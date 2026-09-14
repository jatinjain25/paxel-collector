import type { Signal } from "@builder/types";

/**
 * What opencode actually records, verified against a real 226 MB store:
 * 32 sessions, 4,046 messages, 14,973 parts.
 *
 * Declared conservatively, for the reason the Cursor set gives: over-claiming
 * is worse than omitting. A signal we claim but cannot read becomes a real zero
 * in the feature vector and quietly penalizes every opencode user, while an
 * omitted signal is dropped from its dimension and the remaining weights
 * renormalize.
 *
 * Two absences, both measured rather than assumed:
 *
 * `permission_denials` — there is a `permission` table and in this store it
 * holds ZERO rows. The schema suggests the signal and the data does not prove
 * it, so it is not claimed. If somebody's store turns out to populate it, this
 * is a one-line change backed by evidence.
 *
 * `interrupts` — no cancellation marker exists in `part` or `message`. Claude
 * Code writes an explicit sentinel; opencode has no equivalent, so an opencode
 * user's interrupt count would be zero regardless of how they actually work.
 *
 * Everything claimed below was checked against the store: `tokens` and
 * `modelID` on assistant messages, `reasoning` parts (2,799), `todowrite`
 * calls (83), `task` calls (19), `filePath` on read/edit/write, `command` on
 * bash (1,777), and `state.time.start`/`end` on every tool part.
 */
export const OPENCODE_CAPABILITIES: ReadonlySet<Signal> = new Set<Signal>([
  "tool_calls",
  "file_paths",
  "commands",
  "test_results",
  "token_usage",
  "thinking",
  "subagents",
  "plan_mode",
  "model",
  "timestamps",
  "event_timing",
]);
