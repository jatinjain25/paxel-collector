import { extname } from "node:path";
import { isTestPath } from "@builder/types";
import type { EventMeta, EventType, LocalEvent, PathRef, TokenUsage } from "@builder/types";
import {
  classifyCommand,
  classifyToolCall,
  isInterruptMarker,
  looksLikeCorrection,
  type CommandFamily,
} from "./classify.ts";
import { hashId } from "./hash.ts";

/**
 * Claude Code record -> normalized events (Doc 2 §4).
 *
 * Schema verified against a real corpus: 900 files / 278,459 records / 1.8 GB.
 * The two facts that most shape this code:
 *   - `user` records are overwhelmingly tool RESULTS, not humans (2,407 of 2,493
 *     sampled). Counting them as prompts inflates prompt_count by ~40x.
 *   - the project directory name is a lossy [^A-Za-z0-9]->'-' mapping and cannot
 *     be reversed. Every record carries an authoritative `cwd`; use that.
 */


export interface AdapterState {
  seq: number;
  /** tool_use id -> the tool that issued it, so results can be correlated. */
  pendingTools: Map<string, {
    name: string;
    family?: CommandFamily;
    at: number;
    commandHash?: string;
    path?: PathRef;
  }>;
  /** Set by an interrupt or a failed tool result; consumed by the next prompt. */
  afterFailureOrInterrupt: boolean;
  /** requestId -> usage, aggregated because usage is emitted per streamed block. */
  usageByRequest: Map<string, TokenUsage>;
}

export function newAdapterState(): AdapterState {
  return {
    seq: 0,
    pendingTools: new Map(),
    afterFailureOrInterrupt: false,
    usageByRequest: new Map(),
  };
}

function pathRef(filePath: string): PathRef {
  const ext = extname(filePath);
  return {
    path_hash: hashId(filePath),
    ext,
    depth: filePath.split("/").filter(Boolean).length,
    is_test: isTestPath(filePath),
  };
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Flatten Claude Code's `content` into plain text for local-only inspection. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const b = asRecord(block);
    if (!b) continue;
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n");
}

export interface EmitContext {
  session_id: string;
  project_id: string;
  cwd: string;
}

/**
 * Convert one raw record into zero or more normalized events.
 *
 * Zero is common and expected: system errors, meta turns, and records carrying
 * only bookkeeping produce nothing. Only developer- or agent-attributable
 * behavior becomes an event.
 */
export function recordToEvents(
  raw: Record<string, unknown>,
  ctx: EmitContext,
  state: AdapterState,
): LocalEvent[] {
  const type = str(raw.type);
  if (!type) return [];

  const ts = parseTimestamp(raw.timestamp);
  if (ts === undefined) return [];

  switch (type) {
    case "assistant":
      return assistantEvents(raw, ctx, state, ts);
    case "user":
      return userEvents(raw, ctx, state, ts);
    default:
      // `system` records are API errors and transport retries — infrastructure
      // noise, not developer behavior. Counting them as debugging signal would
      // reward flaky networks.
      return [];
  }
}

function parseTimestamp(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

function baseEvent(
  raw: Record<string, unknown>,
  ctx: EmitContext,
  state: AdapterState,
  ts: number,
  event_type: EventType,
  actor: LocalEvent["actor"],
  metadata: EventMeta,
  local: LocalEvent["local"],
): LocalEvent {
  const uuid = str(raw.uuid) ?? `${ctx.session_id}:${state.seq}`;
  const rawKind = str(raw.type);
  const e: LocalEvent = {
    event_id: hashId(`${ctx.session_id}:${uuid}:${event_type}:${state.seq}`),
    source: "claude_code",
    session_id: ctx.session_id,
    timestamp: ts,
    project_id: ctx.project_id,
    event_type,
    actor,
    seq: state.seq++,
    is_sidechain: raw.isSidechain === true,
    metadata: { ...(rawKind !== undefined && { raw_kind: rawKind }), ...metadata },
    local,
  };
  // Doc 2 §6 steering — the developer rejecting a proposed action is a
  // correction that never became a prompt, and is otherwise invisible.
  const denial = str(raw.toolDenialKind);
  if (denial) e.metadata.denial_kind = denial;

  const parent = str(raw.parentUuid);
  if (parent) e.parent_event_id = hashId(`${ctx.session_id}:${parent}`);
  return e;
}

function assistantEvents(
  raw: Record<string, unknown>,
  ctx: EmitContext,
  state: AdapterState,
  ts: number,
): LocalEvent[] {
  const message = asRecord(raw.message);
  if (!message) return [];
  const content = Array.isArray(message.content) ? message.content : [];
  const out: LocalEvent[] = [];

  let text = "";
  let thinkingChars = 0;
  const toolBlocks: Record<string, unknown>[] = [];

  for (const block of content) {
    const b = asRecord(block);
    if (!b) continue;
    if (b.type === "text" && typeof b.text === "string") text += b.text;
    else if (b.type === "thinking" && typeof b.thinking === "string") {
      thinkingChars += b.thinking.length;
    } else if (b.type === "tool_use") toolBlocks.push(b);
  }

  const requestId = str(raw.requestId);
  const usage = extractUsage(message.usage);
  if (requestId && usage) mergeUsage(state.usageByRequest, requestId, usage);

  if (text.length > 0 || thinkingChars > 0) {
    const meta: EventMeta = { char_count: text.length };
    if (thinkingChars > 0) meta.thinking_char_count = thinkingChars;
    const model = str(message.model);
    if (model) meta.model = model;
    const stop = str(message.stop_reason);
    if (stop) meta.stop_reason = stop;
    if (usage) meta.tokens = usage;
    out.push(baseEvent(raw, ctx, state, ts, "assistant_response", "agent", meta, { text }));
  }

  for (const b of toolBlocks) {
    const toolName = str(b.name) ?? "unknown";
    const input = asRecord(b.input) ?? {};
    const command = str(input.command);
    const family = command ? classifyCommand(command) : undefined;
    const event_type = classifyToolCall(toolName, family);

    const meta: EventMeta = { tool_name: toolName };
    if (toolName.startsWith("mcp__")) {
      meta.tool_namespace = toolName.split("__")[1] ?? "unknown";
    }
    if (family) meta.command_family = family;
    if (command) meta.command_hash = hashId(command).slice(0, 16);
    const filePath = str(input.file_path);
    if (filePath) meta.paths = [pathRef(filePath)];
    meta.arg_bytes = JSON.stringify(b.input ?? {}).length;
    const subagent = str(input.subagent_type);
    if (subagent) {
      meta.agent_type = subagent;
      // The main transcript does not record nesting depth; a spawn from a
      // sidechain is depth 2, otherwise 1. Deeper nesting is not observable
      // here, so this is a floor rather than an exact measure.
      meta.spawn_depth = raw.isSidechain === true ? 2 : 1;
    }

    const toolId = str(b.id);
    if (toolId) {
      state.pendingTools.set(toolId, {
        name: toolName,
        at: ts,
        ...(family && { family }),
        ...(command && { commandHash: hashId(command).slice(0, 16) }),
        ...(filePath && { path: pathRef(filePath) }),
      });
    }

    const e = baseEvent(raw, ctx, state, ts, event_type, "agent", meta, {
      tool_args: b.input,
      ...(command !== undefined && { command }),
      ...(filePath !== undefined && { absolute_paths: [filePath] }),
    });
    if (toolId) e.correlation_id = toolId;
    out.push(e);
  }

  return out;
}

function userEvents(
  raw: Record<string, unknown>,
  ctx: EmitContext,
  state: AdapterState,
  ts: number,
): LocalEvent[] {
  const message = asRecord(raw.message);
  if (!message) return [];
  const content = message.content;

  const toolResults = Array.isArray(content)
    ? content.map(asRecord).filter((b): b is Record<string, unknown> => b?.type === "tool_result")
    : [];

  if (toolResults.length > 0) {
    return toolResults.map((b) => toolResultEvent(raw, b, ctx, state, ts));
  }

  // Synthetic/system-authored turns are not the developer speaking.
  if (raw.isMeta === true) return [];

  const text = contentText(content);
  if (text.length === 0) return [];

  if (isInterruptMarker(text)) {
    state.afterFailureOrInterrupt = true;
    const e = baseEvent(
      raw,
      ctx,
      state,
      ts,
      "course_correction",
      "developer",
      { interrupted: true, char_count: text.length },
      { text },
    );
    return [e];
  }

  const isCorrection = looksLikeCorrection(text, state.afterFailureOrInterrupt);
  state.afterFailureOrInterrupt = false;

  const words = text.split(/\s+/).filter(Boolean).length;
  const meta: EventMeta = {
    char_count: text.length,
    word_count: words,
    line_count: text.split("\n").length,
    has_code_block: text.includes("```"),
    is_correction: isCorrection,
  };

  return [
    baseEvent(
      raw,
      ctx,
      state,
      ts,
      isCorrection ? "course_correction" : "user_instruction",
      "developer",
      meta,
      { text },
    ),
  ];
}

function toolResultEvent(
  raw: Record<string, unknown>,
  block: Record<string, unknown>,
  ctx: EmitContext,
  state: AdapterState,
  ts: number,
): LocalEvent {
  const toolUseId = str(block.tool_use_id);
  const pending = toolUseId ? state.pendingTools.get(toolUseId) : undefined;
  if (toolUseId) state.pendingTools.delete(toolUseId);

  const result = asRecord(raw.toolUseResult);
  const isError = block.is_error === true;
  if (isError) state.afterFailureOrInterrupt = true;

  const meta: EventMeta = { is_error: isError };
  if (pending) {
    meta.tool_name = pending.name;
    meta.duration_ms = Math.max(0, ts - pending.at);
    if (pending.family) meta.command_family = pending.family;
    if (pending.commandHash) meta.command_hash = pending.commandHash;
    // The SAME PathRef the invocation carried. This used to be a stub with
    // ext "", depth 0 and is_test hardcoded false, which was wrong about every
    // test file: a tool use emits a call and a result 1:1, so each touch of a
    // test file contributed one true and one false and any ratio over
    // metadata.paths read about half what it should.
    if (pending.path) meta.paths = [pending.path];
  }

  let event_type: EventType = pending
    ? classifyToolCall(pending.name, pending.family)
    : "tool_call";

  if (result) {
    if (result.interrupted === true) {
      meta.interrupted = true;
      state.afterFailureOrInterrupt = true;
    }
    const patch = result.structuredPatch;
    if (Array.isArray(patch)) {
      let added = 0;
      let removed = 0;
      for (const hunk of patch) {
        const h = asRecord(hunk);
        // Hunk HEADERS only. `h.lines` is the actual diff content and is never read.
        added += num(h?.newLines) ?? 0;
        removed += num(h?.oldLines) ?? 0;
      }
      meta.lines_added = added;
      meta.lines_removed = removed;
    }
    const stdout = str(result.stdout);
    const stderr = str(result.stderr);
    meta.result_bytes = (stdout?.length ?? 0) + (stderr?.length ?? 0);
    const code = num(result.exitCode ?? result.exit_code);
    if (code !== undefined) meta.exit_code = code;
  }

  // A test run resolves to success or failure once its result is known.
  if (event_type === "test_run") {
    event_type = isError || (meta.exit_code ?? 0) !== 0 ? "test_failure" : "test_success";
  }

  const e = baseEvent(raw, ctx, state, ts, event_type, "tool", meta, {
    tool_result: raw.toolUseResult,
  });
  if (toolUseId) e.correlation_id = toolUseId;
  return e;
}

function extractUsage(v: unknown): TokenUsage | undefined {
  const u = asRecord(v);
  if (!u) return undefined;
  return {
    input: num(u.input_tokens) ?? 0,
    output: num(u.output_tokens) ?? 0,
    cache_read: num(u.cache_read_input_tokens) ?? 0,
    cache_create: num(u.cache_creation_input_tokens) ?? 0,
  };
}

/**
 * Usage is emitted per streamed block rather than once per turn, so naive
 * summing across records massively overcounts. We take the per-field maximum
 * within a requestId, which is correct whether the API reports cumulative
 * totals or a final total on the last block.
 */
function mergeUsage(map: Map<string, TokenUsage>, requestId: string, usage: TokenUsage): void {
  const prev = map.get(requestId);
  map.set(
    requestId,
    prev
      ? {
          input: Math.max(prev.input, usage.input),
          output: Math.max(prev.output, usage.output),
          cache_read: Math.max(prev.cache_read, usage.cache_read),
          cache_create: Math.max(prev.cache_create, usage.cache_create),
        }
      : usage,
  );
}
