import type { Signal } from "@builder/types";

/**
 * What Cursor actually records, verified against a real 169 MB store.
 *
 * Declared conservatively on purpose. Over-claiming is worse than omitting: a
 * signal we claim but cannot reliably read becomes a real zero in the feature
 * vector and quietly penalizes every Cursor user, while an omitted signal only
 * costs certainty.
 *
 * Two notable absences:
 *
 * `interrupts` — Claude Code writes an explicit sentinel when a turn is
 * cancelled. Cursor has no equivalent, so a Cursor user's interrupt count would
 * be zero regardless of behaviour.
 *
 * `event_timing` — measured on real data, only 26 of 300 messages carry any
 * timing at all. Conversations have createdAt/lastUpdatedAt and message order is
 * reliable, so positions are known; durations are not. Rather than invent
 * per-message clocks and let them flow into recovery latency and active time,
 * we decline the signal.
 */
export const CURSOR_CAPABILITIES: ReadonlySet<Signal> = new Set<Signal>([
  "tool_calls",
  "file_paths",
  "commands",
  "permission_denials",
  "test_results",
  "token_usage",
  "thinking",
  "plan_mode",
  "model",
  "timestamps",
]);
