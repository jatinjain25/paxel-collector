import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import {
  classifyCommand,
  newParseStats,
  type CommandFamily,
  type DiscoveredProject,
  type ParsedSession,
  type ParseStats,
  type SessionRef,
  type SourceAdapter,
} from "@builder/agent-core";
import { isTestPath } from "@builder/types";
import type {
  AgentSource,
  EventMeta,
  EventType,
  LocalEvent,
  SessionRecord,
} from "@builder/types";
import { CODEX_CAPABILITIES } from "./capabilities.ts";

/** `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`. */
export const CODEX_SESSIONS_DIR = join(homedir(), ".codex", "sessions");

function hashId(v: string): string {
  return createHash("sha256").update(v).digest("hex").slice(0, 32);
}
function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * Codex CLI rollouts -> normalized events.
 *
 * WRITTEN BLIND, AND MARKED UNVERIFIED. Codex was not installed on any machine
 * this has run on, so every line below is read off the documented rollout
 * format rather than from a file anybody has opened. The Claude Code adapter
 * was corrected twice by real data and the Cursor one twice more; assume this
 * is wrong until somebody with Codex installed runs it.
 *
 * `verified: false` is not decoration. `builder discover` prints "(unverified
 * adapter)" beside the source, so the person whose data it is can see that this
 * has never met a real rollout.
 *
 * Documented shape, one JSON object per line:
 *   line 0     SessionMeta: id, timestamp, cwd, originator, cli_version
 *   thereafter { type: "response_item" | "event_msg" | ..., payload: {...} }
 *
 * `ResponseItem` covers `message`, `function_call`, `function_call_output`,
 * `reasoning` and `local_shell_call`. The call carries `name` and a JSON
 * `arguments` string; the output carries `call_id` and the result. That pairing
 * is what produces one invocation and one result per tool use, which is the
 * invariant everything downstream depends on.
 */
export class CodexAdapter implements SourceAdapter {
  readonly source: AgentSource = "codex_cli";
  readonly capabilities = CODEX_CAPABILITIES;
  readonly verified = false;

  constructor(private readonly sessionsDir: string = CODEX_SESSIONS_DIR) {}

  async detect(): Promise<boolean> {
    try {
      return (await stat(this.sessionsDir)).isDirectory();
    } catch {
      return false;
    }
  }

  /** Rollouts are filed under YYYY/MM/DD, so this walks a bounded depth. */
  private async rolloutFiles(): Promise<{ path: string; bytes: number }[]> {
    const out: { path: string; bytes: number }[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 4) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          await walk(full, depth + 1);
        } else if (e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) {
          try {
            out.push({ path: full, bytes: (await stat(full)).size });
          } catch {
            // A file that vanished between readdir and stat is not an error.
          }
        }
      }
    };
    await walk(this.sessionsDir, 0);
    return out;
  }

  async discover(): Promise<DiscoveredProject[]> {
    const byCwd = new Map<string, { refs: SessionRef[]; bytes: number }>();

    for (const file of await this.rolloutFiles()) {
      const cwd = (await this.readMeta(file.path))?.cwd ?? "";
      const entry = byCwd.get(cwd) ?? { refs: [], bytes: 0 };
      entry.refs.push({ source: "codex_cli", locator: file.path, bytes: file.bytes });
      entry.bytes += file.bytes;
      byCwd.set(cwd, entry);
    }

    return [...byCwd].map(([cwd, { refs, bytes }]) => ({
      key: cwd,
      ...(cwd.length > 0 && { path: cwd }),
      project_id: hashId(cwd),
      session_refs: refs,
      bytes,
    }));
  }

  /** Only the first line, so discovery does not read every rollout in full. */
  private async readMeta(
    path: string,
  ): Promise<{ id?: string | undefined; cwd?: string | undefined; model?: string | undefined } | undefined> {
    let head: string;
    try {
      head = (await readFile(path, "utf8")).slice(0, 8192);
    } catch {
      return undefined;
    }
    const first = head.split("\n", 1)[0];
    if (first === undefined) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(first);
    } catch {
      return undefined;
    }
    const rec = asRecord(parsed);
    // Some versions wrap the header in { type: "session_meta", payload: {...} }.
    const meta = asRecord(rec?.payload) ?? rec;
    return {
      ...(str(meta?.id) !== undefined && { id: str(meta?.id) }),
      ...(str(meta?.cwd) !== undefined && { cwd: str(meta?.cwd) }),
      ...(str(meta?.model) !== undefined && { model: str(meta?.model) }),
    };
  }

  async parseSession(ref: SessionRef, project: DiscoveredProject): Promise<ParsedSession | undefined> {
    let text: string;
    try {
      text = await readFile(ref.locator, "utf8");
    } catch {
      return undefined;
    }

    const stats = newParseStats();
    stats.bytes = text.length;
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length === 0) return undefined;

    const meta = (await this.readMeta(ref.locator)) ?? {};
    const sessionId = meta.id ?? hashId(ref.locator);
    // From discovery, which resolves the git root, rather than re-hashing cwd here.
    const project_id = project.project_id;

    const events: LocalEvent[] = [];
    let seq = 0;
    let prompts = 0;
    let first = 0;
    let last = 0;
    const pending = new Map<string, { name: string; family?: CommandFamily; at: number }>();

    for (const line of lines) {
      stats.records++;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        stats.malformed++;
        continue;
      }
      const rec = asRecord(value);
      if (rec === undefined) {
        stats.malformed++;
        continue;
      }

      const at = Date.parse(str(rec.timestamp) ?? "") || 0;
      if (at > 0) {
        first = first === 0 ? at : Math.min(first, at);
        last = Math.max(last, at);
      }

      const payload = asRecord(rec.payload) ?? rec;
      const kind = str(payload.type) ?? str(rec.type) ?? "";

      const push = (
        event_type: EventType,
        actor: "developer" | "agent" | "tool",
        m: EventMeta,
        local: LocalEvent["local"],
        correlation_id?: string,
      ) => {
        events.push({
          event_id: hashId(`${sessionId}:${seq}:${event_type}:${actor}`),
          source: "codex_cli",
          session_id: sessionId,
          timestamp: at,
          project_id,
          event_type,
          actor,
          seq: seq++,
          is_sidechain: false,
          ...(correlation_id !== undefined && { correlation_id }),
          metadata: m,
          local,
        });
        stats.parsed++;
      };

      if (kind === "message") {
        const role = str(payload.role);
        const content = textOf(payload.content);
        if (role === "user") {
          prompts++;
          push(
            "user_instruction",
            "developer",
            {
              raw_kind: "message:user",
              char_count: content.length,
              word_count: content.trim() === "" ? 0 : content.trim().split(/\s+/).length,
              line_count: content === "" ? 0 : content.split("\n").length,
            },
            { text: content },
          );
        } else if (role === "assistant") {
          push(
            "assistant_response",
            "agent",
            {
              raw_kind: "message:assistant",
              char_count: content.length,
              ...(meta.model !== undefined && { model: meta.model }),
            },
            { text: content },
          );
        }
        continue;
      }

      if (kind === "function_call" || kind === "local_shell_call") {
        const name = str(payload.name) ?? (kind === "local_shell_call" ? "shell" : "unknown");
        const args = parseArgs(payload.arguments ?? payload.action);
        const command = str(args?.command) ?? commandOf(args?.command);
        const filePath = str(args?.path) ?? str(args?.file_path) ?? str(args?.filePath);
        const family = command !== undefined ? classifyCommand(command) : undefined;
        const callId = str(payload.call_id) ?? str(payload.id) ?? `${sessionId}:${seq}`;
        pending.set(callId, { name, ...(family !== undefined && { family }), at });

        push(
          classifyCodexTool(name, family),
          "agent",
          {
            raw_kind: kind,
            tool_name: name,
            ...(family !== undefined && { command_family: family }),
            ...(command !== undefined && { command_hash: hashId(command).slice(0, 16) }),
            ...(filePath !== undefined && {
              paths: [
                {
                  path_hash: hashId(filePath),
                  ext: extname(filePath),
                  depth: filePath.split("/").filter(Boolean).length,
                  is_test: isTestPath(filePath),
                },
              ],
            }),
            arg_bytes: JSON.stringify(args ?? {}).length,
          },
          {
            ...(command !== undefined && { command }),
            ...(filePath !== undefined && { absolute_paths: [filePath] }),
            ...(args !== undefined && { tool_args: args }),
          },
          hashId(callId),
        );
        continue;
      }

      if (kind === "function_call_output" || kind === "local_shell_call_output") {
        const callId = str(payload.call_id) ?? "";
        const call = pending.get(callId);
        pending.delete(callId);
        const output = textOf(payload.output);
        const isError = /"?success"?\s*:\s*false|\berror\b/i.test(output.slice(0, 200));
        const type = classifyCodexTool(call?.name ?? "unknown", call?.family);
        const resultType: EventType =
          type === "test_run" ? (isError ? "test_failure" : "test_success") : type;

        push(
          resultType,
          "tool",
          {
            raw_kind: kind,
            ...(call !== undefined && { tool_name: call.name }),
            ...(call?.family !== undefined && { command_family: call.family }),
            is_error: isError,
            ...(call !== undefined && at > 0 && { duration_ms: Math.max(0, at - call.at) }),
            result_bytes: output.length,
          },
          { tool_result: output },
          callId.length > 0 ? hashId(callId) : undefined,
        );
      }
    }

    const record: SessionRecord = {
      session_id: sessionId,
      source: "codex_cli",
      project_id,
      started_at: first,
      ended_at: last,
      active_ms: Math.max(0, last - first),
      event_count: events.length,
      prompt_count: prompts,
      content_hash: hashId(`${sessionId}:${lines.length}:${text.length}`),
      source_ref: {
        source: "codex_cli",
        source_hash: hashId(ref.locator),
        content_hash: hashId(`${lines.length}:${text.length}`),
        bytes: text.length,
      },
    };

    return { session: record, events, stats };
  }
}

/** Content is a string in some versions and an array of parts in others. */
function textOf(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    return v
      .map((part) => (typeof part === "string" ? part : str(asRecord(part)?.text) ?? ""))
      .join("\n");
  }
  const rec = asRecord(v);
  return str(rec?.text) ?? str(rec?.output) ?? "";
}

/** `arguments` is a JSON STRING on function_call, and an object on shell calls. */
function parseArgs(v: unknown): Record<string, unknown> | undefined {
  if (typeof v === "string") {
    try {
      return asRecord(JSON.parse(v));
    } catch {
      return undefined;
    }
  }
  return asRecord(v);
}

/** A shell call's command may be an argv array rather than a string. */
function commandOf(v: unknown): string | undefined {
  return Array.isArray(v) ? v.filter((x) => typeof x === "string").join(" ") : undefined;
}

const READ = new Set(["read_file", "read", "grep", "search", "list_dir", "glob"]);
const WRITE = new Set(["write_file", "create_file", "write"]);
const EDIT = new Set(["apply_patch", "edit_file", "edit", "patch", "str_replace"]);
const SHELL = new Set(["shell", "bash", "exec", "local_shell", "run"]);

export function classifyCodexTool(name: string, family?: CommandFamily): EventType {
  const n = name.trim().toLowerCase();
  if (SHELL.has(n)) {
    switch (family) {
      case "test":
        return "test_run";
      case "git_commit":
        return "git_commit";
      case "git_branch":
        return "git_branch";
      case "git_checkout":
        return "git_checkout";
      case "deploy":
        return "deployment";
      default:
        return "terminal_command";
    }
  }
  if (READ.has(n)) return "file_read";
  if (WRITE.has(n)) return "file_write";
  if (EDIT.has(n)) return "file_edit";
  return "tool_call";
}

export type { ParseStats };
