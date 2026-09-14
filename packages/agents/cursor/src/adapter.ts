import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isTestPath } from "@builder/types";
import type { AgentSource, EventMeta, EventType, LocalEvent, SessionRecord } from "@builder/types";
import {
  newParseStats,
  openReadOnly,
  parseBlobJson,
  type DiscoveredProject,
  type ParsedSession,
  type SessionRef,
  type SourceAdapter,
} from "@builder/agent-core";
import { CURSOR_CAPABILITIES } from "./capabilities.ts";
import {
  classifyCursorTool,
  isFailedStatus,
  isRejection,
  mcpNamespace,
  normalizeToolName,
} from "./classify.ts";

const SUPPORT = join(homedir(), "Library", "Application Support");
export const CURSOR_GLOBAL_DB = join(SUPPORT, "Cursor", "User", "globalStorage", "state.vscdb");
export const CURSOR_WORKSPACE_DIR = join(SUPPORT, "Cursor", "User", "workspaceStorage");

function hashId(v: string): string {
  return createHash("sha256").update(v).digest("hex").slice(0, 32);
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * Cursor stores conversations in SQLite rather than JSONL, which makes it the
 * real test of whether the normalized event layer generalizes.
 *
 * Reconstruction, verified against a real store:
 *   workspaceStorage/<hash>/workspace.json  → the project's folder URI
 *   global cursorDiskKV composerData:<id>   → conversation metadata + message order
 *   global cursorDiskKV bubbleId:<id>:<b>   → individual messages
 *
 * Measured shape: 101 composers of which only 13 hold data, 2,885 messages, and
 * checkpointId rows are 125 MB of the 169 MB file. Skipping the prefixes that
 * hold pure file content cuts the read by roughly three quarters.
 */
export class CursorAdapter implements SourceAdapter {
  readonly source: AgentSource = "cursor";
  readonly capabilities = CURSOR_CAPABILITIES;
  readonly verified = true;

  constructor(
    private readonly globalDbPath: string = CURSOR_GLOBAL_DB,
    private readonly workspaceDir: string = CURSOR_WORKSPACE_DIR,
  ) {}

  async detect(): Promise<boolean> {
    try {
      await stat(this.globalDbPath);
      return true;
    } catch {
      return false;
    }
  }

  async discover(): Promise<DiscoveredProject[]> {
    const composerPaths = await this.workspacePaths();
    const db = await openReadOnly(this.globalDbPath);
    try {
      const rows = db.all<{ key: string; value: unknown }>(
        "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'",
      );

      const byProject = new Map<string, DiscoveredProject>();
      for (const row of rows) {
        const composerId = row.key.slice("composerData:".length);
        const data = rec(parseBlobJson(row.value));
        if (!data) continue;

        const headers = Array.isArray(data.fullConversationHeadersOnly)
          ? data.fullConversationHeadersOnly
          : [];
        // 88 of 101 composers on a real machine are empty shells. Skip them
        // rather than emitting projects with no evidence.
        if (headers.length === 0) continue;

        const path = composerPaths.get(composerId);
        const project_id = hashId(path ?? `cursor:${composerId}`);
        const existing = byProject.get(project_id);
        const ref: SessionRef = {
          source: "cursor",
          locator: composerId,
          bytes: headers.length * 7500, // measured mean bubble size
        };
        if (existing) {
          existing.session_refs.push(ref);
          existing.bytes += ref.bytes;
        } else {
          byProject.set(project_id, {
            key: composerId,
            ...(path !== undefined && { path }),
            project_id,
            session_refs: [ref],
            bytes: ref.bytes,
          });
        }
      }
      return [...byProject.values()].sort((a, b) => b.bytes - a.bytes);
    } finally {
      db.close();
    }
  }

  /** composerId → workspace folder path, via each workspace's own index. */
  private async workspacePaths(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    let dirs: string[];
    try {
      dirs = (await readdir(this.workspaceDir, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return out;
    }

    for (const dir of dirs) {
      const base = join(this.workspaceDir, dir);
      let folder: string | undefined;
      try {
        const meta = JSON.parse(await readFile(join(base, "workspace.json"), "utf8")) as {
          folder?: string;
        };
        // The folder is a URL-encoded file:// URI; a path with spaces arrives as
        // %20 and must be decoded or it will never match the git root.
        folder = meta.folder ? decodeURIComponent(meta.folder.replace(/^file:\/\//, "")) : undefined;
      } catch {
        continue;
      }
      if (!folder) continue;

      try {
        const db = await openReadOnly(join(base, "state.vscdb"));
        try {
          const rows = db.all<{ value: unknown }>(
            "SELECT value FROM ItemTable WHERE key = 'composer.composerData'",
          );
          const parsed = rec(parseBlobJson(rows[0]?.value));
          const all = Array.isArray(parsed?.allComposers) ? parsed.allComposers : [];
          for (const c of all) {
            const id = str(rec(c)?.composerId);
            if (id) out.set(id, folder);
          }
        } finally {
          db.close();
        }
      } catch {
        continue;
      }
    }
    return out;
  }

  async parseSession(ref: SessionRef, project: DiscoveredProject): Promise<ParsedSession | undefined> {
    const db = await openReadOnly(this.globalDbPath);
    const stats = newParseStats();
    try {
      const composerRows = db.all<{ value: unknown }>(
        "SELECT value FROM cursorDiskKV WHERE key = ?",
        `composerData:${ref.locator}`,
      );
      const data = rec(parseBlobJson(composerRows[0]?.value));
      if (!data) return undefined;

      const headers = Array.isArray(data.fullConversationHeadersOnly)
        ? data.fullConversationHeadersOnly
        : [];
      if (headers.length === 0) return undefined;

      const createdAt = plausibleEpochMs(data.createdAt) ?? Date.now();
      const lastUpdated = plausibleEpochMs(data.lastUpdatedAt) ?? createdAt;
      const events: LocalEvent[] = [];
      let seq = 0;

      for (let i = 0; i < headers.length; i++) {
        const bubbleId = str(rec(headers[i])?.bubbleId);
        if (!bubbleId) continue;
        stats.records++;

        const rows = db.all<{ value: unknown }>(
          "SELECT value FROM cursorDiskKV WHERE key = ?",
          `bubbleId:${ref.locator}:${bubbleId}`,
        );
        const bubble = rec(parseBlobJson(rows[0]?.value));
        if (!bubble) {
          stats.malformed++;
          continue;
        }
        stats.parsed++;

        // Only ~9% of messages carry a timestamp, so position between the
        // conversation's bounds stands in. Ordering is real; duration is not,
        // which is why this adapter does not claim `event_timing`.
        const timestamp = interpolate(createdAt, lastUpdated, i, headers.length, bubble);

        for (const e of bubbleToEvents(bubble, {
          session_id: ref.locator,
          project_id: project.project_id,
          timestamp,
          seqStart: seq,
        })) {
          events.push(e);
          seq++;
        }
      }

      if (events.length === 0) return undefined;

      const timestamps = events.map((e) => e.timestamp);
      const session: SessionRecord = {
        session_id: ref.locator,
        source: "cursor",
        project_id: project.project_id,
        started_at: Math.min(...timestamps),
        ended_at: Math.max(...timestamps),
        // Without real per-event timing, active time is the conversation span.
        // Coarser than Claude Code's idle-gap calculation, and honest about it.
        active_ms: Math.max(0, lastUpdated - createdAt),
        event_count: events.length,
        prompt_count: events.filter(
          (e) => e.event_type === "user_instruction" || e.event_type === "course_correction",
        ).length,
        content_hash: hashId(`${ref.locator}:${headers.length}`),
        source_ref: {
          source: "cursor",
          source_hash: hashId(ref.locator),
          content_hash: hashId(`${ref.locator}:${headers.length}`),
          bytes: stats.bytes,
        },
        ...(str(rec(data.modelConfig)?.modelName) !== undefined && {
          model: str(rec(data.modelConfig)?.modelName)!,
        }),
      };

      return { session, events, stats };
    } finally {
      db.close();
    }
  }
}

/**
 * Epoch milliseconds must land in a plausible window.
 *
 * Cursor's `timingInfo.clientStartTime` looks like a timestamp and is not: real
 * values include 18596.7 and 94963.1, which are relative performance timings,
 * not wall clock. Trusting them put 45 events in 1970 and stretched the
 * observation window to 20,706 days, which in turn wrecked active_days and every
 * recency calculation downstream.
 *
 * Anything before 2000 or in the future is not a timestamp, whatever the field
 * is called.
 */
const MIN_PLAUSIBLE_MS = Date.parse("2000-01-01T00:00:00Z");

export function plausibleEpochMs(v: unknown, now: number = Date.now()): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  if (v < MIN_PLAUSIBLE_MS) return undefined;
  if (v > now + 86_400_000) return undefined;
  return v;
}

function interpolate(
  from: number,
  to: number,
  index: number,
  total: number,
  bubble: Record<string, unknown>,
): number {
  const timing = rec(bubble.timingInfo);
  const real =
    plausibleEpochMs(timing?.clientStartTime) ?? plausibleEpochMs(timing?.clientRpcSendTime);
  if (real !== undefined) return real;
  if (total <= 1 || to <= from) return from;
  return Math.round(from + ((to - from) * index) / (total - 1));
}

interface EmitCtx {
  session_id: string;
  project_id: string;
  timestamp: number;
  seqStart: number;
}

function bubbleToEvents(bubble: Record<string, unknown>, ctx: EmitCtx): LocalEvent[] {
  const out: LocalEvent[] = [];
  const isUser = bubble.type === 1;
  const text = str(bubble.text) ?? "";
  const tool = rec(bubble.toolFormerData);

  const base = (
    event_type: EventType,
    actor: LocalEvent["actor"],
    metadata: EventMeta,
    local: LocalEvent["local"],
    offset: number,
  ): LocalEvent => ({
    event_id: hashId(`${ctx.session_id}:${str(bubble.bubbleId) ?? ctx.seqStart}:${event_type}:${offset}`),
    source: "cursor",
    session_id: ctx.session_id,
    timestamp: ctx.timestamp,
    project_id: ctx.project_id,
    event_type,
    actor,
    seq: ctx.seqStart + offset,
    is_sidechain: false,
    metadata: { raw_kind: isUser ? "bubble:user" : "bubble:assistant", ...metadata },
    local,
  });

  if (isUser && text.length > 0 && !tool) {
    const words = text.split(/\s+/).filter(Boolean).length;
    out.push(
      base(
        "user_instruction",
        "developer",
        {
          char_count: text.length,
          word_count: words,
          line_count: text.split("\n").length,
          has_code_block: text.includes("```"),
        },
        { text },
        0,
      ),
    );
    return out;
  }

  if (!isUser && text.length > 0) {
    const meta: EventMeta = { char_count: text.length };
    const thinking = Array.isArray(bubble.allThinkingBlocks) ? bubble.allThinkingBlocks : [];
    if (thinking.length > 0) meta.thinking_char_count = JSON.stringify(thinking).length;
    const tokens = num(bubble.tokenCount);
    if (tokens !== undefined) meta.tokens = { input: 0, output: tokens, cache_read: 0, cache_create: 0 };
    out.push(base("assistant_response", "agent", meta, { text }, 0));
  }

  // Only emit tool events when the record actually identifies a tool.
  //
  // Measured on a real store, 723 of 1,955 toolFormerData objects contain only
  // an `additionalData` key — no name, no tool, no params, no result. They are
  // not tool calls. Treating them as such produced 1,446 phantom events and
  // inflated tool_call_count by 43%, corrupting every ratio built on it.
  const toolName = str(tool?.name);
  if (tool && toolName) {
    const name = normalizeToolName(toolName);
    const event_type = classifyCursorTool(toolName);
    const params = rec(tool.params) ?? {};
    const filePath = str(params.target_file) ?? str(params.path) ?? str(params.relative_workspace_path);
    const command = str(params.command);

    const callMeta: EventMeta = { tool_name: name };
    const namespace = mcpNamespace(name);
    if (namespace) callMeta.tool_namespace = namespace;
    if (filePath) {
      callMeta.paths = [
        // isTestPath, not /test|spec/i over the whole path: that matched any
        // directory named "latest" and any repository named "contest", so a
        // Cursor user's test ratio was inflated by paths with no tests in them
        // while a Claude Code user's was not. Same rule for every source.
        {
          path_hash: hashId(filePath),
          ext: extOf(filePath),
          depth: filePath.split("/").length,
          is_test: isTestPath(filePath),
        },
      ];
    }
    if (command) callMeta.command_hash = hashId(command).slice(0, 16);
    callMeta.arg_bytes = JSON.stringify(tool.params ?? {}).length;

    const call = base(event_type, "agent", callMeta, {
      tool_args: tool.params,
      ...(command !== undefined && { command }),
      ...(filePath !== undefined && { absolute_paths: [filePath] }),
    }, out.length);
    // Hashed, not passed through. Cursor stores a two-line value here for some
    // tools — "call_XXX\nfc_YYY" — and an identifier with an embedded newline
    // is malformed wherever it lands. This is an opaque pairing key, so hashing
    // keeps it stable and well-formed whatever Cursor decides to store next.
    const callId = str(tool.toolCallId);
    if (callId !== undefined) call.correlation_id = hashId(callId).slice(0, 32);
    out.push(call);

    const failed = isFailedStatus(tool.status);
    const rejected = isRejection(tool.userDecision);
    const resultMeta: EventMeta = { tool_name: name, is_error: failed };
    if (rejected) resultMeta.denial_kind = "user-rejected";
    if (callMeta.paths) resultMeta.paths = callMeta.paths;
    if (callMeta.command_hash) resultMeta.command_hash = callMeta.command_hash;
    resultMeta.result_bytes = JSON.stringify(tool.result ?? "").length;

    const result = base(event_type, "tool", resultMeta, { tool_result: tool.result }, out.length);
    if (call.correlation_id !== undefined) result.correlation_id = call.correlation_id;
    out.push(result);
  }

  return out;
}

function extOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot);
}
