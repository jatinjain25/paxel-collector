/**
 * Wire types in this package use snake_case, matching the JSON contracts given
 * verbatim in Doc 2 §4, Doc 2 §8 and Doc 3 §10. Serializing straight from these
 * types keeps the API identical to the spec with no translation layer to drift.
 */

/**
 * Supported inputs. Doc 2 §2 names the first three; the rest were found on real
 * machines and carry real evidence.
 *
 * Doc 1 §6 requires that adding a source never changes the score schema. That
 * holds because sources contribute normalized events, and what a source cannot
 * observe is declared rather than silently zero — see `Signal` below.
 */
export const AGENT_SOURCES = [
  "claude_code",
  "codex_cli",
  "cursor",
  "opencode",
  "vscode_copilot",
  "windsurf",
] as const;
export type AgentSource = (typeof AGENT_SOURCES)[number];

/**
 * What a source is capable of recording.
 *
 * This exists because tools differ in what they write down, and ignoring that
 * would rank people by their editor. Claude Code writes an explicit sentinel
 * when a turn is interrupted; Cursor has no equivalent. A Cursor-only builder
 * scoring `interrupt_count: 0` is not a builder who never interrupts — it is a
 * builder whose tool did not record it.
 *
 * So an adapter declares the signals it can observe, features record which were
 * available, and scoring drops components it could not see rather than reading
 * absence as zero. A missing signal costs certainty, never points.
 */
export const SIGNALS = [
  "tool_calls",
  "file_paths",
  "commands",
  "interrupts",
  "permission_denials",
  "test_results",
  "token_usage",
  "thinking",
  "subagents",
  "plan_mode",
  "model",
  /** Some temporal anchor exists, even if only per-conversation bounds. */
  "timestamps",
  /**
   * Per-event wall-clock times are genuine, not interpolated.
   *
   * Cursor records createdAt/lastUpdatedAt per conversation but a timestamp on
   * only ~9% of messages, so per-event times there are derived from position
   * between two bounds. Ordering is trustworthy; durations are not. Anything
   * measuring elapsed time — recovery latency, active time, time-windowed
   * proximity — needs this signal, not merely `timestamps`.
   */
  "event_timing",
] as const;
export type Signal = (typeof SIGNALS)[number];

/** Signals every source must provide for its evidence to be usable at all. */
/**
 * The floor for usable evidence. Deliberately excludes `event_timing`: a source
 * with reliable ordering but no per-message clock still supports most of the
 * behavioural signal, and excluding it would discard Cursor entirely.
 */
export const REQUIRED_SIGNALS: readonly Signal[] = ["timestamps", "tool_calls"];

/** Doc 2 §4 — who produced an event. */
export const ACTORS = ["developer", "agent", "tool"] as const;
export type Actor = (typeof ACTORS)[number];

/** Provenance for one parsed input, used for idempotency (Doc 2 §8). */
export interface SourceRef {
  source: AgentSource;
  /** Opaque stable id for the file or DB row. Never an absolute path. */
  source_hash: string;
  /** Content hash of the parsed input — half of the `session_id + content hash` key. */
  content_hash: string;
  bytes: number;
}

/**
 * Doc 3 §5 and Doc 5 §8 — every derived artifact carries the versions that
 * produced it, so any score can be replayed or invalidated.
 */
export interface VersionStamp {
  pipeline_version: string;
  feature_version: string;
  score_version: string;
  /** Local model that wrote the prose. Absent when no model was available. */
  model_version?: string;
  prompt_version?: string;
}
