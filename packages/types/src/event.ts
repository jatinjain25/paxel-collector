import type { Actor, AgentSource } from "./agent.ts";

/**
 * Doc 2 §4 — canonical event types.
 *
 * Several of these are *derived classifications*, not raw record types: a Bash
 * call running `pytest` becomes `test_run` plus `test_success`/`test_failure`,
 * and an interrupt followed by a corrective prompt becomes `course_correction`.
 * Classification happens in the adapter; the raw record kind is preserved in
 * `meta.raw_kind` so a claim can always be traced back to what was on disk.
 */
export const EVENT_TYPES = [
  "session_start",
  "session_end",
  "user_instruction",
  "assistant_response",
  "tool_call",
  "file_read",
  "file_write",
  "file_edit",
  "terminal_command",
  "test_run",
  "test_failure",
  "test_success",
  "git_commit",
  "git_branch",
  "git_checkout",
  "deployment",
  "agent_spawn",
  "agent_stop",
  "course_correction",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** A file touched by an event, described without revealing the path. */
export interface PathRef {
  /** sha256(absolute path), truncated. Stable per-machine, opaque off it. */
  path_hash: string;
  /** ".ts", ".py", "". Needed for language and test-ratio features. */
  ext: string;
  /** Directory depth — cheap proxy for how widely a change spreads. */
  depth: number;
  /** Matched a test convention (*.test.*, *_test.*, tests/, spec/). */
  is_test: boolean;
}

export interface TokenUsage {
  input: number;
  output: number;
  cache_read: number;
  cache_create: number;
}

/**
 * Doc 2 §4 `metadata`. Counts, enums, hashes and booleans only — never text.
 * Anything textual lives in `LocalOnly` and is dropped before upload.
 */
export interface EventMeta {
  /** Adapter-level record kind before classification, for auditability. */
  raw_kind?: string;

  /** user_instruction */
  char_count?: number;
  word_count?: number;
  line_count?: number;
  has_code_block?: boolean;
  has_pasted_content?: boolean;
  /** True when this instruction corrected or redirected the agent (Doc 2 steering). */
  is_correction?: boolean;

  /** assistant_response */
  model?: string;
  stop_reason?: string;
  thinking_char_count?: number;
  tokens?: TokenUsage;

  /** tool_call and file_* */
  tool_name?: string;
  /** MCP server for `mcp__<server>__<tool>`, else absent. */
  tool_namespace?: string;
  arg_bytes?: number;
  result_bytes?: number;
  is_error?: boolean;
  interrupted?: boolean;
  duration_ms?: number;
  paths?: PathRef[];
  /** Derived from patch hunk headers only — never the hunk lines themselves. */
  lines_added?: number;
  lines_removed?: number;

  /** terminal_command — classification only; the command string stays local. */
  command_family?: string;
  /**
   * Hash of the command, so the same command can be recognised across events
   * without the text ever leaving the machine. Needed to tell "this failed
   * twice" from "two different things failed" for tools that act on a command
   * rather than a file path.
   */
  command_hash?: string;
  exit_code?: number;

  /** test_run / test_failure / test_success */
  tests_passed?: number;
  tests_failed?: number;
  test_framework?: string;

  /** git_* */
  commit_sha?: string;
  branch_hash?: string;

  /** agent_spawn / agent_stop (Doc 2 delegation family) */
  agent_type?: string;
  spawn_depth?: number;

  /** Errors and retries (Doc 2 debugging family) */
  error_class?: string;
  retry_attempt?: number;
  denial_kind?: string;

  /** Plan mode and other mode switches (Doc 2 planning family) */
  mode?: string;
}

/**
 * Everything that may contain source code, prompt text, or absolute paths.
 *
 * This is the ONLY place such data is permitted. It exists so the local model
 * can read real evidence on-device, and is dropped wholesale by `toWire`.
 * Never widen `WireEvent` to include any of it.
 *
 * Note that Doc 2 §4's `content_excerpt` is deliberately NOT here or on
 * `WireEvent`: excerpts are a separate, user-approved top-level array (see
 * excerpt.ts), which keeps "events carry no free text" true by construction.
 */
export interface LocalOnly {
  text?: string;
  tool_args?: unknown;
  tool_result?: unknown;
  command?: string;
  absolute_paths?: string[];
  cwd?: string;
  commit_subject?: string;
}

/** An event as it may be uploaded. Carries no free text by construction. */
export interface WireEvent {
  event_id: string;
  source: AgentSource;
  session_id: string;
  /** Epoch milliseconds. Adapters normalize ISO-8601 and epoch-seconds inputs. */
  timestamp: number;
  /** sha256 of the project's root path. Groups without naming. */
  project_id: string;
  event_type: EventType;
  actor: Actor;
  /** Order within the session, assigned by the adapter. */
  seq: number;
  /** DAG parent (Claude Code `parentUuid`); absent for roots. */
  parent_event_id?: string;
  /** True for subagent / sidechain turns. */
  is_sidechain: boolean;
  /** Correlates a result back to the call that produced it. */
  correlation_id?: string;
  metadata: EventMeta;
}

/**
 * An event as it exists on the developer's machine.
 *
 * `LocalEvent` is `WireEvent` plus exactly one key. That shape is the privacy
 * guarantee: the projection to `WireEvent` is a single omission, which a test
 * can verify exhaustively rather than by inspection.
 */
export interface LocalEvent extends WireEvent {
  local: LocalOnly;
}

/**
 * Doc 2 §4's taxonomy names the *action*, not the direction, so a single tool
 * use produces two events sharing one `event_type`: the invocation
 * (`actor: "agent"`) and its result (`actor: "tool"`). Verified 1:1 across a
 * real corpus.
 *
 * Counting by `event_type` alone therefore double-counts every tool use. Use
 * these predicates instead of comparing `actor` by hand.
 */
export function isToolInvocation(e: Pick<WireEvent, "actor">): boolean {
  return e.actor === "agent";
}

export function isToolResult(e: Pick<WireEvent, "actor">): boolean {
  return e.actor === "tool";
}

/** A turn authored by the human, not the agent or a tool. */
export function isDeveloperTurn(e: Pick<WireEvent, "actor">): boolean {
  return e.actor === "developer";
}

/**
 * Is this path a test file?
 *
 * ONE definition, because there were three and they disagreed. The git metrics
 * had this pair of regexes, the Claude adapter had a near-copy, and Cursor had
 * `/test|spec/i` against the whole path, which matches any directory called
 * "latest" and any repository called "contest". A path classified differently
 * depending on which editor recorded it ranks people by their editor, which is
 * the defect the capability model exists to prevent.
 *
 * It lives in types because that is the only package every adapter already
 * depends on, and because a classification rule that feeds a score is a
 * contract rather than a utility.
 */
const TEST_PATH = /(^|\/)(tests?|specs?|__tests__)\//i;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|_test\.(py|go|rb|rs)$|(^|\/)test_[^/]*\.py$/i;

export function isTestPath(path: string): boolean {
  return TEST_PATH.test(path) || TEST_FILE.test(path);
}
