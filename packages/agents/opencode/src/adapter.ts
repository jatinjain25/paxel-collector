import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import {
  classifyCommand,
  openReadOnly,
  newParseStats,
  type CommandFamily,
  type DiscoveredProject,
  type ParsedSession,
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
import { OPENCODE_CAPABILITIES } from "./capabilities.ts";
import { classifyOpencodeTool } from "./classify.ts";

export const OPENCODE_DB = join(homedir(), ".local", "share", "opencode", "opencode.db");

function hashId(v: string): string {
  return createHash("sha256").update(v).digest("hex").slice(0, 32);
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

function parse(json: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(json));
  } catch {
    return undefined;
  }
}

interface SessionRow {
  id: string;
  directory: string;
  title: string;
  time_created: number;
  time_updated: number;
}
interface MessageRow {
  id: string;
  session_id: string;
  time_created: number;
  data: string;
}
interface PartRow {
  id: string;
  message_id: string;
  session_id: string;
  time_created: number;
  data: string;
}

/**
 * opencode -> normalized events.
 *
 * Verified against a real 226 MB store: 32 sessions, 4,046 messages, 14,973
 * parts across 2 projects. The schema is relational rather than a blob of
 * JSON, which makes this the most straightforward of the three adapters:
 *
 *   session  id, directory, title, time_created/updated
 *   message  data JSON: role, tokens, modelID, providerID, path.{cwd,root}
 *   part     data JSON: type ∈ {tool, text, reasoning, step-*, file}
 *
 * A `tool` part carries the CALL AND THE RESULT in one row: `state.input`,
 * `state.output`, `state.status` and `state.time.{start,end}`. It is emitted as
 * two events, matching the invariant the taxonomy relies on everywhere else,
 * that one tool use is an invocation plus a result under one event type.
 *
 * NEVER READ THE `account` TABLE. It holds `email`, `access_token` and
 * `refresh_token` for a live session. Nothing here needs it, a collector whose
 * whole argument is restraint has no business near it, and the queries below
 * name their columns so that reading it would have to be deliberate.
 */
export class OpencodeAdapter implements SourceAdapter {
  readonly source: AgentSource = "opencode";
  readonly capabilities = OPENCODE_CAPABILITIES;
  readonly verified = true;

  constructor(private readonly dbPath: string = OPENCODE_DB) {}

  async detect(): Promise<boolean> {
    try {
      await stat(this.dbPath);
      return true;
    } catch {
      return false;
    }
  }

  async discover(): Promise<DiscoveredProject[]> {
    const db = await openReadOnly(this.dbPath);
    try {
      const rows = db.all<SessionRow>(
        "SELECT id, directory, title, time_created, time_updated FROM session",
      );
      const byDir = new Map<string, SessionRef[]>();
      for (const s of rows) {
        const dir = s.directory ?? "";
        const refs = byDir.get(dir) ?? [];
        refs.push({ source: "opencode", locator: s.id, bytes: 0 });
        byDir.set(dir, refs);
      }

      return [...byDir].map(([dir, session_refs]) => ({
        key: dir,
        ...(dir.length > 0 && { path: dir }),
        // Overwritten by discovery's resolveProjectId, which resolves the git
        // root. Computed here so the adapter is usable on its own.
        project_id: hashId(dir),
        session_refs,
        bytes: 0,
      }));
    } finally {
      db.close();
    }
  }

  async parseSession(ref: SessionRef, project: DiscoveredProject): Promise<ParsedSession | undefined> {
    const db = await openReadOnly(this.dbPath);
    try {
      const [session] = db.all<SessionRow>(
        "SELECT id, directory, title, time_created, time_updated FROM session WHERE id = ?",
        ref.locator,
      );
      if (session === undefined) return undefined;

      const messages = db.all<MessageRow>(
        "SELECT id, session_id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC",
        ref.locator,
      );
      const parts = db.all<PartRow>(
        "SELECT id, message_id, session_id, time_created, data FROM part WHERE session_id = ? ORDER BY time_created ASC",
        ref.locator,
      );

      return this.build(session, messages, parts, project.project_id);
    } finally {
      db.close();
    }
  }

  private build(
    session: SessionRow,
    messages: MessageRow[],
    parts: PartRow[],
    project_id: string,
  ): ParsedSession {
    const stats = newParseStats();
    const events: LocalEvent[] = [];
    let seq = 0;
    let prompts = 0;

    const partsByMessage = new Map<string, PartRow[]>();
    for (const p of parts) {
      const list = partsByMessage.get(p.message_id) ?? [];
      list.push(p);
      partsByMessage.set(p.message_id, list);
    }

    const push = (
      event_type: EventType,
      actor: "developer" | "agent" | "tool",
      timestamp: number,
      meta: EventMeta,
      local: LocalEvent["local"],
      correlation_id?: string,
    ) => {
      events.push({
        event_id: hashId(`${session.id}:${seq}:${event_type}:${actor}`),
        source: "opencode",
        session_id: session.id,
        timestamp,
        project_id,
        event_type,
        actor,
        seq: seq++,
        is_sidechain: false,
        ...(correlation_id !== undefined && { correlation_id }),
        metadata: meta,
        local,
      });
    };

    for (const m of messages) {
      const data = parse(m.data);
      if (data === undefined) {
        stats.malformed++;
        continue;
      }
      stats.records++;
      const role = str(data.role);
      const at = num(asRecord(data.time)?.created) ?? m.time_created;
      const mine = partsByMessage.get(m.id) ?? [];

      if (role === "user") {
        prompts++;
        const text = mine
          .filter((p) => parse(p.data)?.type === "text")
          .map((p) => str(parse(p.data)?.text) ?? "")
          .join("\n");
        push(
          "user_instruction",
          "developer",
          at,
          {
            raw_kind: "message:user",
            char_count: text.length,
            word_count: text.trim() === "" ? 0 : text.trim().split(/\s+/).length,
            line_count: text === "" ? 0 : text.split("\n").length,
          },
          { text },
        );
        continue;
      }
      if (role !== "assistant") continue;

      const modelId = str(data.modelID);
      const tokens = asRecord(data.tokens);
      const cache = asRecord(tokens?.cache);
      const assistantMeta: EventMeta = {
        raw_kind: "message:assistant",
        ...(modelId !== undefined && { model: modelId }),
        ...(tokens !== undefined && {
          tokens: {
            input: num(tokens.input) ?? 0,
            output: num(tokens.output) ?? 0,
            cache_read: num(cache?.read) ?? 0,
            cache_create: num(cache?.write) ?? 0,
          },
        }),
      };

      const thinking = mine.filter((p) => parse(p.data)?.type === "reasoning");
      if (thinking.length > 0) {
        const text = thinking.map((p) => str(parse(p.data)?.text) ?? "").join("\n");
        push("assistant_response", "agent", at, { ...assistantMeta, thinking_char_count: text.length }, { text });
      } else {
        push("assistant_response", "agent", at, assistantMeta, {});
      }

      for (const p of mine) {
        const pd = parse(p.data);
        if (pd?.type !== "tool") continue;
        this.emitTool(pd, p, push);
      }
    }

    const record: SessionRecord = {
      session_id: session.id,
      source: "opencode",
      project_id,
      started_at: session.time_created,
      ended_at: session.time_updated,
      active_ms: Math.max(0, session.time_updated - session.time_created),
      event_count: events.length,
      prompt_count: prompts,
      content_hash: hashId(`${session.id}:${messages.length}:${parts.length}:${session.time_updated}`),
      source_ref: {
        source: "opencode",
        source_hash: hashId(session.id),
        content_hash: hashId(`${messages.length}:${parts.length}:${session.time_updated}`),
        bytes: 0,
      },
    };

    return { session: record, events, stats };
  }

  /** One `tool` row becomes an invocation and a result, as the taxonomy requires. */
  private emitTool(
    pd: Record<string, unknown>,
    row: PartRow,
    push: (
      t: EventType,
      a: "developer" | "agent" | "tool",
      ts: number,
      m: EventMeta,
      l: LocalEvent["local"],
      c?: string,
    ) => void,
  ): void {
    const tool = str(pd.tool) ?? "unknown";
    const state = asRecord(pd.state);
    const input = asRecord(state?.input);
    const time = asRecord(state?.time);
    const startedAt = num(time?.start) ?? row.time_created;
    const endedAt = num(time?.end) ?? startedAt;
    const correlation = hashId(str(pd.callID) ?? row.id);

    const command = str(input?.command);
    const family: CommandFamily | undefined =
      command !== undefined ? classifyCommand(command) : undefined;
    const filePath = str(input?.filePath) ?? str(input?.file_path) ?? str(input?.path);

    const base: EventMeta = {
      raw_kind: "part:tool",
      tool_name: tool,
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
    };

    const type = classifyOpencodeTool(tool, family);
    push(type, "agent", startedAt, { ...base, arg_bytes: JSON.stringify(input ?? {}).length }, {
      ...(command !== undefined && { command }),
      ...(filePath !== undefined && { absolute_paths: [filePath] }),
      ...(input !== undefined && { tool_args: input }),
    }, correlation);

    // The EXIT CODE decides, not `state.status`.
    //
    // `status` is "error" when the tool itself failed; a test suite that ran
    // and reported failures exits non-zero with status "completed". Keying on
    // status alone reported all 43 test runs in this store as passes when 11
    // of them had failed, which would hand every opencode user a perfect
    // test-success rate. `metadata.exit` is present on 1,750 of the bash calls
    // here and is the only field that knows.
    const meta = asRecord(state?.metadata);
    const exit = num(meta?.exit);
    const isError = exit !== undefined ? exit !== 0 : str(state?.status) === "error";
    const output = str(state?.output) ?? "";

    // A failed test run is `test_failure`, a passing one `test_success`. The
    // outcome lives on the RESULT, which is why the predicates distinguish
    // actor rather than event type.
    const resultType: EventType =
      type === "test_run" ? (isError ? "test_failure" : "test_success") : type;

    push(
      resultType,
      "tool",
      endedAt,
      {
        ...base,
        is_error: isError,
        ...(exit !== undefined && { exit_code: exit }),
        duration_ms: Math.max(0, endedAt - startedAt),
        result_bytes: output.length,
      },
      { tool_result: output },
      correlation,
    );
  }
}
