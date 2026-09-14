import type { Signal } from "@builder/types";

/**
 * What Codex CLI is DOCUMENTED to record. Nothing here has been verified.
 *
 * Codex is not installed on any machine this has run on, so this set is read
 * off the rollout format rather than measured, and the adapter ships with
 * `verified: false` because of it. Every other adapter in this repo has been
 * corrected twice by contact with real data, and there is no reason to believe
 * this one is the exception.
 *
 * Deliberately the thinnest set of the three. An over-claim is not a cosmetic
 * error: a signal declared but not actually read becomes a real zero in the
 * feature vector, and a Codex user is then penalized for behaviour their tool
 * simply never wrote down. An omission only costs certainty, and the scorer
 * already renormalizes the weights of a dimension whose component is dropped.
 *
 * Claimed, because the rollout format's `ResponseItem` and `EventMsg` variants
 * carry them plainly: tool calls, the paths and commands inside their
 * arguments, per-item timestamps, and the model on the session header.
 *
 * NOT claimed, pending somebody running this:
 *   token_usage        reported per turn in some versions and not others
 *   thinking           reasoning items exist but are not reliably persisted
 *   test_results       derivable from commands, but only once command parsing
 *                      is confirmed against real rollouts
 *   interrupts         no documented cancellation marker
 *   permission_denials approval flow is interactive and may not be journaled
 *   subagents          no documented equivalent
 *   plan_mode          no documented equivalent
 *   event_timing       per-item timestamps exist; durations do not
 */
export const CODEX_CAPABILITIES: ReadonlySet<Signal> = new Set<Signal>([
  "tool_calls",
  "file_paths",
  "commands",
  "model",
  "timestamps",
]);
