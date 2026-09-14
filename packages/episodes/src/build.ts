import { createHash } from "node:crypto";
import type {
  CommitRef,
  EpisodeBoundary,
  EpisodeRecord,
  SessionRecord,
  WireEvent,
} from "@builder/types";

/**
 * Episode construction (Doc 2 §5).
 *
 * A session is one contiguous agent interaction; an episode is a coherent unit
 * of work that can span several. Episodes exist because sessions are an artifact
 * of how someone happens to use a terminal — closing a laptop splits a session
 * without splitting the work. Scoring per session would rank habits of tool
 * usage; scoring per episode ranks units of work.
 *
 * Doc 2 §5 is explicit that boundaries must be "derived metadata, not an opaque
 * LLM-only decision", so every episode records why it ended and the rule is
 * inspectable here rather than living inside a prompt.
 */

/**
 * Sessions closer together than this continue the same episode.
 *
 * Four hours is chosen to bridge a lunch break or a meeting but not an overnight
 * gap. It is deliberately larger than the 15-minute idle threshold used for
 * active time: that one asks "were they at the keyboard", this one asks "is this
 * still the same piece of work".
 */
export const EPISODE_GAP_MS = 4 * 60 * 60 * 1000;

/** Commits land slightly after the work that produced them. */
export const COMMIT_TRAILING_MS = 30 * 60 * 1000;

export interface BuildEpisodesInput {
  sessions: SessionRecord[];
  /** Used to decide completion and to detect task transitions. */
  events: Pick<WireEvent, "session_id" | "event_type" | "timestamp" | "actor">[];
  commits: CommitRef[];
  gapMs?: number;
}

/**
 * Stable across re-uploads of the same evidence (Doc 2 §8 idempotency).
 *
 * Derived from session identity and content hashes, so re-running the collector
 * over unchanged history produces the same key and the server can recognise it
 * as already-seen rather than double-counting.
 */
export function evidenceKey(sessions: SessionRecord[]): string {
  const material = [...sessions]
    .map((s) => `${s.session_id}:${s.content_hash}`)
    .sort()
    .join("|");
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}

export function buildEpisodes(input: BuildEpisodesInput): EpisodeRecord[] {
  const gapMs = input.gapMs ?? EPISODE_GAP_MS;
  const byProject = new Map<string, SessionRecord[]>();
  for (const s of input.sessions) {
    const list = byProject.get(s.project_id);
    if (list) list.push(s);
    else byProject.set(s.project_id, [s]);
  }

  const eventsBySession = new Map<string, BuildEpisodesInput["events"]>();
  for (const e of input.events) {
    const list = eventsBySession.get(e.session_id);
    if (list) list.push(e);
    else eventsBySession.set(e.session_id, [e]);
  }

  const episodes: EpisodeRecord[] = [];

  for (const [project_id, sessions] of byProject) {
    const ordered = [...sessions].sort((a, b) => a.started_at - b.started_at);

    let group: SessionRecord[] = [];

    const flush = (reason: EpisodeBoundary) => {
      if (group.length === 0) return;
      episodes.push(makeEpisode(group, project_id, reason, input.commits, eventsBySession));
      group = [];
    };

    for (const session of ordered) {
      if (group.length === 0) {
        group.push(session);
        continue;
      }
      const prev = group[group.length - 1]!;
      const gap = session.started_at - prev.ended_at;

      // Has the current episode already shipped? A commit anywhere inside the
      // work so far — not merely in the gap before this session — closes it.
      //
      // Checking only the gap was the original bug: someone who commits while
      // working continuously never triggered a split, so an entire week of
      // sessions collapsed into one "episode" that trivially looked complete.
      // Measured on a real repo that produced 49 episodes, 100% of them
      // "completed", with one spanning 59.5 hours of active time. A rate that
      // is always 1.0 is not a measurement.
      const groupStart = Math.min(...group.map((g) => g.started_at));
      const shipped = input.commits.some(
        (c) =>
          !c.is_merge &&
          c.timestamp >= groupStart &&
          c.timestamp <= session.started_at + COMMIT_TRAILING_MS,
      );

      if (shipped) {
        flush("commit");
        group.push(session);
      } else if (gap > gapMs) {
        flush("time_proximity");
        group.push(session);
      } else {
        group.push(session);
      }
    }
    flush("time_proximity");
  }

  return episodes.sort((a, b) => a.started_at - b.started_at);
}

function makeEpisode(
  sessions: SessionRecord[],
  project_id: string,
  boundary: EpisodeBoundary,
  allCommits: CommitRef[],
  eventsBySession: Map<string, BuildEpisodesInput["events"]>,
): EpisodeRecord {
  const started_at = Math.min(...sessions.map((s) => s.started_at));
  const ended_at = Math.max(...sessions.map((s) => s.ended_at));

  const commits = allCommits.filter(
    (c) => c.timestamp >= started_at && c.timestamp <= ended_at + COMMIT_TRAILING_MS,
  );

  const events = sessions.flatMap((s) => eventsBySession.get(s.session_id) ?? []);

  return {
    episode_id: evidenceKey(sessions),
    evidence_key: evidenceKey(sessions),
    project_id,
    sources: [...new Set(sessions.map((s) => s.source))],
    boundary,
    started_at,
    ended_at,
    // Summing session active time, not wall clock across the episode: the gaps
    // between sessions in one episode are precisely the time nobody was working.
    active_ms: sessions.reduce((a, s) => a + s.active_ms, 0),
    session_ids: sessions.map((s) => s.session_id),
    commits,
    completed: isCompleted(commits, events, { started_at, ended_at }),
  };
}

/**
 * Doc 3 §3 `completed_episode_rate` — did this stretch of work reach an end?
 *
 * The obvious test — "does the episode contain a commit" — is circular here,
 * because episodes are delimited BY commits. Measured on a real repo it returned
 * 99%, which is not a measurement, it is the construction restating itself.
 *
 * So completion asks whether the episode *ended* by shipping: was there a
 * commit, passing test run, or deployment near its close? Work that trails off
 * unfinished looks identical from the outside to work that finished, and the
 * difference between them is exactly what this is supposed to capture.
 *
 * Explicitly not evidence: the episode merely ending, or shipping something
 * early and then wandering. Treating "stopped" as "completed" would make
 * abandoning things free.
 */
export const COMPLETION_TAIL_MS = 30 * 60 * 1000;
export const COMPLETION_TAIL_SHARE = 0.25;

export function isCompleted(
  commits: CommitRef[],
  events: BuildEpisodesInput["events"],
  span?: { started_at: number; ended_at: number },
): boolean {
  if (!span) {
    // No span given: fall back to presence, used only by callers that have
    // already established the boundary themselves.
    return (
      commits.some((c) => !c.is_merge) ||
      events.some(
        (e) => (e.event_type === "test_success" || e.event_type === "deployment") && e.actor === "tool",
      )
    );
  }

  const duration = span.ended_at - span.started_at;
  const tail = Math.max(COMPLETION_TAIL_MS, duration * COMPLETION_TAIL_SHARE);
  const from = span.ended_at - tail;

  const shippedLate = commits.some(
    (c) => !c.is_merge && c.timestamp >= from && c.timestamp <= span.ended_at + COMMIT_TRAILING_MS,
  );
  if (shippedLate) return true;

  return events.some(
    (e) =>
      (e.event_type === "test_success" || e.event_type === "deployment") &&
      e.actor === "tool" &&
      e.timestamp >= from,
  );
}
