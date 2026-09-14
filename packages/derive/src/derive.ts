import { buildEpisodes } from "@builder/episodes";
import { extractFeatures } from "@builder/features";
import { scoreBuilder } from "@builder/scoring";
import { isToolInvocation, SIGNALS, type ScoreRecord, type Signal, type UploadPayload } from "@builder/types";
import type { EvidenceCounts } from "@builder/types";

/**
 * Compute a score from uploaded evidence.
 *
 * ITS OWN PACKAGE, so the collector can run it too.
 *
 * It used to live in packages/api, where the CLI could not reach it: that
 * barrel pulls in @builder/store and therefore `pg`, and the collector's
 * privacy argument rests on how little it contains. So the terminal computed a
 * score one way and the server computed it another, and the two numbers
 * disagreed in front of the user. This depends on nothing but episodes,
 * features, scoring and types, all four of which the CLI already had.
 *
 * One function, one input, one number. A preview that is not the published
 * number is not a preview.
 *
 * This is the whole point of the 2026-09-10 reversal: the client states no
 * number, so there is nothing for it to edit. The same pure functions the CLI
 * used to run locally run here instead, which also means a weight change is a
 * recompute over stored evidence rather than a request that everybody re-run
 * the collector.
 *
 * `rework_ratio`, `revert_count` and `test_file_ratio` used to arrive as
 * client-computed floats. They are derived here instead, for the same reason as
 * everything else: a number a client can state is a number a client can invent.
 */

export interface Derived {
  record: ScoreRecord;
  evidence: EvidenceCounts;
  episodes: number;
  observedSignals: Signal[];
  missingSignals: Signal[];
}

const DAY = 86_400_000;
const HOUR = 3_600_000;

const REWORK_WINDOW_MS = 48 * HOUR;

/**
 * Lines removed from a file that was already touched recently.
 *
 * Computed from the EVENT stream, not from commit totals. Wire events carry
 * `path_hash` plus per-edit line counts, which is exactly what the local
 * implementation in packages/git uses, so the definition survives the move to
 * the server rather than degrading into "removed over added" — a ratio that
 * mostly tracks commit cadence, which Doc 3 §11 explicitly forbids reading as
 * quality.
 *
 * Directional on purpose: an earlier touch, not any touch, so ordinary forward
 * progress across many edits does not inflate it.
 *
 * The revisit must CROSS A SESSION, and that is the whole correctness of this
 * function rather than a refinement of it. The local implementation counts a
 * file touched again within 48h of a COMMIT, and a commit is a checkpoint:
 * re-opening a file after it means going back over finished work. An edit
 * event is not a checkpoint. Editing a file eight times over twenty minutes is
 * how anybody writes code with an agent, and counting each of those as rework
 * measures typing.
 *
 * Measured on a real 109,810-event corpus: without the session check this
 * reported 31.2% rework against roughly 7.6% from the same person's commits,
 * and 92.3% of the revisits it counted were inside one session. It cost 18.7
 * points of Engineering Quality, on the builder whose behaviour the anchors
 * were fitted to. Doc 3 §11 forbids reading commit cadence as quality; reading
 * edit cadence as its inverse is the same error pointed the other way.
 */
export function reworkRatio(events: UploadPayload["events"]): number {
  const ordered = [...events].sort((a, b) => a.timestamp - b.timestamp);
  const lastTouch = new Map<string, { at: number; session: string }>();
  let reworked = 0;
  let total = 0;

  for (const e of ordered) {
    const added = e.metadata.lines_added ?? 0;
    const removed = e.metadata.lines_removed ?? 0;
    if (added === 0 && removed === 0) continue;

    for (const p of e.metadata.paths ?? []) {
      total += added + removed;
      const prev = lastTouch.get(p.path_hash);
      if (
        prev !== undefined &&
        prev.session !== e.session_id &&
        e.timestamp - prev.at <= REWORK_WINDOW_MS
      ) {
        reworked += removed;
      }
      lastTouch.set(p.path_hash, { at: e.timestamp, session: e.session_id });
    }
  }

  return total === 0 ? 0 : reworked / total;
}

/**
 * Share of file touches that landed on a test file.
 *
 * INVOCATIONS ONLY. A tool use emits a call and a result under one event type,
 * 1:1, and both carry the path; counting the stream flat counts every touch
 * twice. That was survivable while both sides agreed, and they did not: the
 * result's PathRef was a stub with `is_test` hardcoded false, so every touch of
 * a test file scored one true and one false and this read roughly half of the
 * truth. `isToolInvocation` exists precisely so this cannot be got wrong
 * silently, and it was not being used here.
 */
function testFileRatio(events: UploadPayload["events"]): number {
  let touched = 0;
  let tests = 0;
  for (const e of events) {
    if (!isToolInvocation(e)) continue;
    for (const p of e.metadata.paths ?? []) {
      touched += 1;
      if (p.is_test) tests += 1;
    }
  }
  return touched === 0 ? 0 : tests / touched;
}

export function derive(
  payload: UploadPayload,
  builderId: string,
  pipelineVersion: string,
  featureVersion: string,
): Derived {
  const { sessions, events, commits } = payload;

  const episodes = buildEpisodes({ sessions, events, commits });

  const timestamps = events.map((e) => e.timestamp).filter((t) => t > 0);
  const from = timestamps.length > 0 ? Math.min(...timestamps) : 0;
  const to = timestamps.length > 0 ? Math.max(...timestamps) : 0;

  // Trust the union the sources declared, but never beyond the enum.
  const declared = new Set(payload.unobserved_signals);
  const observed = SIGNALS.filter((s) => !declared.has(s));

  const features = extractFeatures({
    scope: { kind: "window", from, to },
    feature_version: featureVersion,
    observed_signals: observed,
    sessions,
    episodes,
    events,
    commits,
    rework_ratio: reworkRatio(events),
    revert_count: commits.filter((c) => c.is_revert === true).length,
    test_file_ratio: testFileRatio(events),
  });

  const { record } = scoreBuilder({
    builder_id: builderId,
    features,
    pipeline_version: pipelineVersion,
    source_count: payload.sources.length,
  });

  // Days with activity, not the span. One busy weekend and two steady months
  // can share a window, and the gates care about the former.
  const activeDays = new Set(events.map((e) => Math.floor(e.timestamp / DAY))).size;
  const projects = new Set(events.map((e) => e.project_id));

  return {
    record,
    evidence: {
      sessions: sessions.length,
      events: events.length,
      episodes: episodes.length,
      projects: projects.size,
      sources: [...payload.sources],
      unobserved_signals: [...declared],
      commits: commits.length,
      active_days: activeDays,
      window_days: Math.max(activeDays, Math.round((to - from) / DAY)),
    },
    episodes: episodes.length,
    observedSignals: observed,
    missingSignals: [...declared],
  };
}
