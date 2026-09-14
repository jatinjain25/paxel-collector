import { describe, expect, test } from "bun:test";
import { SIGNALS, type EpisodeRecord, type EventType, type WireEvent } from "@builder/types";
import {
  debuggingFeatures,
  extractFeatures,
  fastCorrectionRate,
  isMutation,
  upfrontExplorationShare,
} from "../src/index.ts";

let seq = 0;
function ev(
  event_type: EventType,
  actor: WireEvent["actor"],
  t: number,
  metadata: WireEvent["metadata"] = {},
  session_id = "s1",
): WireEvent {
  return {
    event_id: `e${seq++}`,
    source: "claude_code",
    session_id,
    timestamp: t,
    project_id: "p1",
    event_type,
    actor,
    seq: seq,
    is_sidechain: false,
    metadata,
  };
}

function episode(session_ids: string[], completed = true): EpisodeRecord {
  return {
    episode_id: "ep1",
    evidence_key: "k1",
    project_id: "p1",
    sources: ["claude_code"],
    boundary: "commit",
    started_at: 0,
    ended_at: 1_000_000,
    active_ms: 1_000_000,
    session_ids,
    commits: [],
    completed,
  };
}

describe("fastCorrectionRate", () => {
  test("a correction after few agent actions is fast", () => {
    const events = [
      ev("user_instruction", "developer", 1),
      ev("file_edit", "agent", 2),
      ev("course_correction", "developer", 3),
    ];
    expect(fastCorrectionRate(events)).toBe(1);
  });

  test("a correction after many unchallenged agent actions is not", () => {
    // The bug this pins: the first version returned 98.5% because it only asked
    // whether ANY agent action preceded the correction.
    const events = [
      ev("user_instruction", "developer", 1),
      ...Array.from({ length: 20 }, (_, i) => ev("file_edit", "agent", 2 + i)),
      ev("course_correction", "developer", 100),
    ];
    expect(fastCorrectionRate(events)).toBe(0);
  });

  test("the counter resets after each developer turn", () => {
    const events = [
      ...Array.from({ length: 20 }, (_, i) => ev("file_edit", "agent", i)),
      ev("user_instruction", "developer", 50),
      ev("file_edit", "agent", 51),
      ev("course_correction", "developer", 52),
    ];
    expect(fastCorrectionRate(events)).toBe(1);
  });

  test("is zero when there are no corrections", () => {
    expect(fastCorrectionRate([ev("file_edit", "agent", 1)])).toBe(0);
  });
});

describe("debuggingFeatures", () => {
  const MIN = 60_000;

  test("a failure fixed soon after counts as recovered", () => {
    const events = [
      ev("terminal_command", "tool", 0, { tool_name: "Bash", is_error: true, command_hash: "h1", command_family: "test" }),
      ev("terminal_command", "tool", 2 * MIN, { tool_name: "Bash", is_error: false, command_hash: "h2", command_family: "test" }),
    ];
    const d = debuggingFeatures([episode(["s1"])], events);
    expect(d.debug_recovery_rate).toBe(1);
  });

  test("a fixed command still counts as recovery even though its hash changed", () => {
    // The over-correction this pins: requiring an exact hash match reported
    // 14.9% recovery on real data, because fixing a command changes its hash.
    const events = [
      ev("terminal_command", "tool", 0, { tool_name: "Bash", is_error: true, command_hash: "broken", command_family: "build" }),
      ev("terminal_command", "tool", MIN, { tool_name: "Bash", is_error: false, command_hash: "fixed", command_family: "build" }),
    ];
    expect(debuggingFeatures([episode(["s1"])], events).debug_recovery_rate).toBe(1);
  });

  test("a success long after the failure is not recovery", () => {
    // The bug this pins: searching the whole corpus for "same tool succeeded
    // later" reported 98.5%, because over 71 days Bash always succeeds again.
    const events = [
      ev("terminal_command", "tool", 0, { tool_name: "Bash", is_error: true, command_hash: "h1", command_family: "test" }),
      ev("terminal_command", "tool", 24 * 60 * MIN, { tool_name: "Bash", is_error: false, command_hash: "h1", command_family: "test" }),
    ];
    expect(debuggingFeatures([episode(["s1"])], events).debug_recovery_rate).toBe(0);
  });

  test("repeated failures need an exact target match", () => {
    const events = [
      ev("file_edit", "tool", 0, { tool_name: "Edit", is_error: true, paths: [{ path_hash: "a", ext: ".ts", depth: 1, is_test: false }] }),
      ev("file_edit", "tool", MIN, { tool_name: "Edit", is_error: true, paths: [{ path_hash: "a", ext: ".ts", depth: 1, is_test: false }] }),
    ];
    expect(debuggingFeatures([episode(["s1"])], events).repeated_failure_rate).toBe(0.5);
  });

  test("two different failures are not a repeat", () => {
    // The bug this pins: unidentifiable targets collapsed to one key and
    // produced a 99.6% repeated-failure rate.
    const events = [
      ev("terminal_command", "tool", 0, { tool_name: "Bash", is_error: true, command_hash: "a" }),
      ev("terminal_command", "tool", MIN, { tool_name: "Bash", is_error: true, command_hash: "b" }),
    ];
    expect(debuggingFeatures([episode(["s1"])], events).repeated_failure_rate).toBe(0);
  });

  test("unidentifiable failures are excluded from the repeat denominator", () => {
    // Reporting a rate over things we cannot tell apart would be invented.
    const events = [
      ev("tool_call", "tool", 0, { tool_name: "Mystery", is_error: true }),
      ev("tool_call", "tool", MIN, { tool_name: "Mystery", is_error: true }),
    ];
    const d = debuggingFeatures([episode(["s1"])], events);
    expect(d.failure_count).toBe(2);
    expect(d.repeated_failure_rate).toBe(0);
  });

  test("failures in different episodes are not related", () => {
    const events = [
      ev("file_edit", "tool", 0, { tool_name: "Edit", is_error: true, paths: [{ path_hash: "a", ext: "", depth: 1, is_test: false }] }, "s1"),
      ev("file_edit", "tool", MIN, { tool_name: "Edit", is_error: true, paths: [{ path_hash: "a", ext: "", depth: 1, is_test: false }] }, "s2"),
    ];
    const eps = [episode(["s1"]), { ...episode(["s2"]), episode_id: "ep2" }];
    expect(debuggingFeatures(eps, events).repeated_failure_rate).toBe(0);
  });
});

describe("anti-gaming (Doc 3 §11)", () => {
  const base = {
    scope: { kind: "window", from: 0, to: 1000 } as const,
    feature_version: "t",
    observed_signals: [...SIGNALS],
    sessions: [],
    commits: [],
  };

  test("prompt volume alone does not raise any rate", () => {
    const few = extractFeatures({
      ...base,
      episodes: [],
      events: [ev("user_instruction", "developer", 1), ev("course_correction", "developer", 2)],
    });
    const many = extractFeatures({
      ...base,
      episodes: [],
      events: [
        ...Array.from({ length: 200 }, (_, i) => ev("user_instruction", "developer", i)),
        ...Array.from({ length: 200 }, (_, i) => ev("course_correction", "developer", 200 + i)),
      ],
    });
    // Same behaviour at 100x the volume must produce the same rate.
    expect(many.steering.steering_event_rate).toBeCloseTo(few.steering.steering_event_rate, 5);
  });

  test("raw counts ship alongside rates so 1/1 and 400/400 differ (Doc 3 §3)", () => {
    const few = extractFeatures({ ...base, episodes: [], events: [ev("course_correction", "developer", 1)] });
    const many = extractFeatures({
      ...base,
      episodes: [],
      events: Array.from({ length: 400 }, (_, i) => ev("course_correction", "developer", i)),
    });
    expect(few.steering.steering_event_rate).toBe(many.steering.steering_event_rate);
    expect(few.steering.correction_count).not.toBe(many.steering.correction_count);
  });

  test("tool invocations are counted once, not twice", () => {
    // Every tool use emits a call and a result under one event_type.
    const f = extractFeatures({
      ...base,
      episodes: [],
      events: [
        ev("file_edit", "agent", 1, { tool_name: "Edit" }),
        ev("file_edit", "tool", 2, { tool_name: "Edit" }),
      ],
    });
    expect(f.interaction.tool_call_count).toBe(1);
  });
});

describe("upfrontExplorationShare", () => {
  test("is zero when the first action changes something", () => {
    const events = [ev("file_edit", "agent", 0), ev("file_edit", "agent", 100)];
    expect(upfrontExplorationShare(episode(["s1"]), events)).toBe(0);
  });

  test("is one when nothing was ever changed", () => {
    const events = [ev("file_read", "agent", 0), ev("file_read", "agent", 100)];
    expect(upfrontExplorationShare(episode(["s1"]), events)).toBe(1);
  });

  test("reflects the share elapsed before the first change", () => {
    const events = [ev("file_read", "agent", 0), ev("file_edit", "agent", 50), ev("file_edit", "agent", 100)];
    expect(upfrontExplorationShare(episode(["s1"]), events)).toBeCloseTo(0.5, 5);
  });
});

describe("taxonomy", () => {
  test.each([
    ["file_write", true],
    ["file_edit", true],
    ["git_commit", true],
    ["file_read", false],
    ["assistant_response", false],
  ])("isMutation(%s) === %p", (t, expected) => {
    expect(isMutation(t as EventType)).toBe(expected);
  });
});
