import type { LocalEvent, WireEvent } from "./event.ts";

/**
 * Project an on-device event to its text-free form.
 *
 * No event is uploaded any more, so this is now a boundary INSIDE the machine:
 * the local pipeline runs on projected events, which means prompt text and
 * source code never reach episode building, feature extraction or scoring at
 * all. Only the local model, which also never leaves the machine, reads the
 * unprojected form.
 *
 * `LocalEvent` is `WireEvent` plus exactly one key, so the projection is a
 * single omission and the result cannot carry text unless `WireEvent` itself is
 * widened to allow it.
 *
 * Built by naming fields explicitly rather than by deleting `local` from a copy:
 * an allowlist stays correct when `LocalEvent` grows a field, a denylist
 * silently starts leaking.
 */
export function toWire(e: LocalEvent): WireEvent {
  const w: WireEvent = {
    event_id: e.event_id,
    source: e.source,
    session_id: e.session_id,
    timestamp: e.timestamp,
    project_id: e.project_id,
    event_type: e.event_type,
    actor: e.actor,
    seq: e.seq,
    is_sidechain: e.is_sidechain,
    metadata: e.metadata,
  };
  if (e.parent_event_id !== undefined) w.parent_event_id = e.parent_event_id;
  if (e.correlation_id !== undefined) w.correlation_id = e.correlation_id;
  return w;
}

/**
 * Keys that must never appear in an uploaded structure.
 *
 * Two categories, and the second one shrank on 2026-09-09.
 *
 * The first is anything that may carry source code, prompt text or absolute
 * paths. That list is unchanged and is the whole point: the payload now carries
 * a score and a set of counts, so any key here means something went badly
 * wrong upstream.
 *
 * The second is what the SERVER still derives. It used to include `score` and
 * `composite_score`, because the client uploaded features and the server
 * computed every number. The client now computes its own score, so those keys
 * are legitimate. `rank` and `percentile` are not: a rank is a function of the
 * entire population and no single machine can know one, so a client sending one
 * is either broken or lying.
 */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  // content
  "local",
  "text",
  "content",
  "content_excerpt",
  "excerpt",
  "excerpts",
  "narrative",
  "narratives",
  "summary",
  "snippet",
  "tool_args",
  "tool_result",
  "command",
  "absolute_paths",
  "cwd",
  "commit_subject",
  "old_string",
  "new_string",
  "original_file",
  "stdout",
  "stderr",
  "patch",
  "diff",
  "source_code",
  // Server-derived, and unrepresentable in the payload type as well. A client
  // that sends any of these is broken or lying: the score is computed here,
  // from evidence, precisely so there is no number for a machine to edit.
  "score",
  "scores",
  "composite_score",
  "proof_score",
  "rank",
  "ranking_score",
  "percentile",
]);

/**
 * Deep-scan an assembled payload and throw on anything forbidden.
 *
 * There is no longer an escape hatch. The payload used to allowlist
 * `$.excerpts`, `$.narratives` and `$.decisions` because approved prose was
 * uploadable; none of it is now, so the rule is unconditional and the scanner
 * has no subtree where free text is permitted.
 *
 * SEVERAL OF THESE KEYS NOW NAME TYPES THAT NO LONGER EXIST, and that is
 * deliberate rather than leftover. `ExcerptCandidate`, `ApprovedExcerpt`,
 * `NarrativeRecord` and `DecisionRecord` were deleted on 2026-09-13 because
 * nothing produced them and the product decided against uploading text. The
 * keys stay because this list guards against a shape, not against a type: the
 * next person to add a field called `text` or `summary` will be stopped
 * whether or not a matching interface was ever written. Removing an entry here
 * because "nothing generates it any more" is how the hole gets reopened.
 *
 * Defence in depth: the payload type already makes a leak unrepresentable, but
 * running this over the assembled object means a mistake anywhere upstream
 * fails on the developer's machine rather than quietly shipping their work.
 */
export function assertUploadSafe(value: unknown, path = "$"): void {
  if (value === null || typeof value !== "object") return;

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) assertUploadSafe(value[i], `${path}[${i}]`);
    return;
  }

  for (const [key, v] of Object.entries(value)) {
    const here = `${path}.${key}`;
    if (FORBIDDEN_KEYS.has(key)) {
      throw new UploadSafetyError(
        `Forbidden key "${key}" at ${here}. Nothing derived from the developer's ` +
          `work may be uploaded beyond the score and its evidence counts.`,
      );
    }
    assertUploadSafe(v, here);
  }
}

export class UploadSafetyError extends Error {
  override readonly name = "UploadSafetyError";
}
