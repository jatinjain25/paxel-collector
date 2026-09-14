import type { Signal } from "@builder/types";

/**
 * What Claude Code records, verified against a real 1.8 GB corpus.
 *
 * It is the richest source we have: it declares every signal. That is not a
 * compliment to Anthropic so much as a warning about the others — Claude Code
 * sets the ceiling, and every other adapter's capability set should be read as
 * "what is missing relative to this", which is exactly why scoring must drop
 * unobservable components rather than treat them as zero.
 */
export const CLAUDE_CAPABILITIES: ReadonlySet<Signal> = new Set<Signal>([
  "tool_calls",
  "file_paths",
  "commands",
  // `[Request interrupted by user]` is written verbatim into the transcript.
  "interrupts",
  // toolDenialKind records the developer refusing a proposed action.
  "permission_denials",
  "test_results",
  "token_usage",
  "thinking",
  // Subagent transcripts live in a sidecar directory with a meta.json.
  "subagents",
  // ExitPlanMode tool calls make plan mode observable.
  "plan_mode",
  "model",
  "timestamps",
  // Every record carries an ISO-8601 timestamp; none are interpolated.
  "event_timing",
]);
