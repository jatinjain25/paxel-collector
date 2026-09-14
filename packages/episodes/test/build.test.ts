import { describe, expect, test } from "bun:test";
import type { CommitRef, SessionRecord } from "@builder/types";
import { buildEpisodes, evidenceKey, isCompleted } from "../src/index.ts";

const H = 3600_000;
const T0 = Date.parse("2026-09-01T09:00:00Z");

function session(id: string, startH: number, durH: number, project = "p1"): SessionRecord {
  return {
    session_id: id,
    source: "claude_code",
    project_id: project,
    started_at: T0 + startH * H,
    ended_at: T0 + (startH + durH) * H,
    active_ms: durH * H,
    event_count: 10,
    prompt_count: 3,
    content_hash: `hash-${id}`,
    source_ref: { source: "claude_code", source_hash: `f-${id}`, content_hash: `hash-${id}`, bytes: 100 },
  };
}

function commit(sha: string, atH: number, is_merge = false): CommitRef {
  return {
    sha,
    timestamp: T0 + atH * H,
    author_hash: "a1",
    lines_added: 10,
    lines_removed: 2,
    files_changed: 1,
    is_revert: false,
    subject_length: 12,
    is_merge,
    session_corroborated: true,
  };
}

describe("buildEpisodes", () => {
  test("merges sessions separated by less than the gap", () => {
    const eps = buildEpisodes({
      sessions: [session("a", 0, 1), session("b", 2, 1)],
      events: [],
      commits: [],
    });
    expect(eps).toHaveLength(1);
    expect(eps[0]!.session_ids).toEqual(["a", "b"]);
  });

  test("splits sessions separated by more than the gap", () => {
    const eps = buildEpisodes({
      sessions: [session("a", 0, 1), session("b", 10, 1)],
      events: [],
      commits: [],
    });
    expect(eps).toHaveLength(2);
  });

  test("a commit between sessions ends the episode even within the gap", () => {
    // Sessions are 2h apart, well inside the 4h window, but work shipped between
    // them — shipping is a stronger boundary than elapsed time.
    const eps = buildEpisodes({
      sessions: [session("a", 0, 1), session("b", 2, 1)],
      events: [],
      commits: [commit("c1", 1.5)],
    });
    expect(eps).toHaveLength(2);
    expect(eps[0]!.boundary).toBe("commit");
  });

  test("never merges sessions from different projects", () => {
    const eps = buildEpisodes({
      sessions: [session("a", 0, 1, "p1"), session("b", 1.5, 1, "p2")],
      events: [],
      commits: [],
    });
    expect(eps).toHaveLength(2);
    expect(new Set(eps.map((e) => e.project_id))).toEqual(new Set(["p1", "p2"]));
  });

  test("active time sums sessions rather than spanning the episode", () => {
    // Two 1h sessions 2h apart: 2h of work across a 3h span. The idle gap
    // between them is exactly the time nobody was working.
    const eps = buildEpisodes({
      sessions: [session("a", 0, 1), session("b", 2, 1)],
      events: [],
      commits: [],
    });
    expect(eps[0]!.active_ms).toBe(2 * H);
    expect(eps[0]!.ended_at - eps[0]!.started_at).toBe(3 * H);
  });

  test("attaches commits landing inside or just after the episode", () => {
    const eps = buildEpisodes({
      sessions: [session("a", 0, 1)],
      events: [],
      commits: [commit("in", 0.5), commit("way-later", 20)],
    });
    expect(eps[0]!.commits.map((c) => c.sha)).toEqual(["in"]);
  });

  test("orders episodes by start time", () => {
    const eps = buildEpisodes({
      sessions: [session("late", 20, 1), session("early", 0, 1)],
      events: [],
      commits: [],
    });
    expect(eps.map((e) => e.session_ids[0])).toEqual(["early", "late"]);
  });

  test("handles no sessions", () => {
    expect(buildEpisodes({ sessions: [], events: [], commits: [] })).toEqual([]);
  });

  test("respects a custom gap", () => {
    const eps = buildEpisodes({
      sessions: [session("a", 0, 1), session("b", 2, 1)],
      events: [],
      commits: [],
      gapMs: 30 * 60_000,
    });
    expect(eps).toHaveLength(2);
  });
});

describe("evidenceKey (Doc 2 §8 idempotency)", () => {
  test("is stable across re-runs", () => {
    expect(evidenceKey([session("a", 0, 1)])).toBe(evidenceKey([session("a", 0, 1)]));
  });

  test("ignores session ordering", () => {
    const a = session("a", 0, 1);
    const b = session("b", 2, 1);
    expect(evidenceKey([a, b])).toBe(evidenceKey([b, a]));
  });

  test("changes when session content changes", () => {
    const a = session("a", 0, 1);
    const mutated = { ...a, content_hash: "different" };
    expect(evidenceKey([a])).not.toBe(evidenceKey([mutated]));
  });
});

describe("isCompleted (Doc 3 §3)", () => {
  const span = { started_at: T0, ended_at: T0 + 4 * H };

  test("shipping near the end completes the episode", () => {
    expect(isCompleted([commit("c", 3.9)], [], span)).toBe(true);
  });

  test("shipping early then wandering does not", () => {
    // The distinction the naive version could not make: this episode contains a
    // commit but did not end by shipping.
    expect(isCompleted([commit("c", 0.2)], [], span)).toBe(false);
  });

  test("a merge commit alone does not complete", () => {
    expect(isCompleted([commit("c", 3.9, true)], [], span)).toBe(false);
  });

  test("a passing test result near the end completes", () => {
    expect(
      isCompleted([], [{ session_id: "a", event_type: "test_success", timestamp: T0 + 3.9 * H, actor: "tool" }], span),
    ).toBe(true);
  });

  test("a deployment near the end completes", () => {
    expect(
      isCompleted([], [{ session_id: "a", event_type: "deployment", timestamp: T0 + 3.8 * H, actor: "tool" }], span),
    ).toBe(true);
  });

  test("merely ending does not count as completing", () => {
    expect(
      isCompleted([], [
        { session_id: "a", event_type: "user_instruction", timestamp: T0 + 3.9 * H, actor: "developer" },
        { session_id: "a", event_type: "file_edit", timestamp: T0 + 3.95 * H, actor: "agent" },
      ], span),
    ).toBe(false);
  });

  test("a test invocation is not a test result", () => {
    // actor:agent is the call; only actor:tool carries the outcome.
    expect(
      isCompleted([], [{ session_id: "a", event_type: "test_success", timestamp: T0 + 3.9 * H, actor: "agent" }], span),
    ).toBe(false);
  });

  test("short episodes get a floor on the tail window", () => {
    // A 10-minute episode: 25% would be 2.5 min, too tight to catch a commit
    // landing just after the work. The 30-minute floor covers it.
    const shortSpan = { started_at: T0, ended_at: T0 + 10 * 60_000 };
    expect(isCompleted([commit("c", 0.02)], [], shortSpan)).toBe(true);
  });
});
