import { describe, expect, test } from "bun:test";
import type { Dimension, FeatureVector } from "@builder/types";
import { DIMENSIONS, SIGNALS, V1_WEIGHTS, displayScore } from "@builder/types";
import {
  band,
  CALIBRATION,
  computeConfidence,
  DIMENSION_CONFIDENCE_CEILING,
  DIMENSION_FUNCTIONS,
  inverseBand,
  invertedU,
  saturating,
  scoreBuilder,
  STEERING_PEAK,
} from "../src/index.ts";

/** A realistic vector, anchored on values measured from a real 71-day corpus. */
function features(overrides: Partial<FeatureVector> = {}): FeatureVector {
  return {
    feature_version: "0.1.0",
    scope: { kind: "window", from: 0, to: 71 * 86400_000 },
    observed_signals: [...SIGNALS],
    interaction: {
      prompt_count: 1531, tool_call_count: 61253, assistant_turn_count: 19368,
      active_ms: 1_362_201_765, files_touched: 766, distinct_extensions: 15,
      mean_prompt_words: 120.6, prompt_words_stddev: 443.8,
      session_count: 260, active_days: 45,
    },
    planning: {
      plan_mode_used: true, plan_before_execution_rate: 0.554, planned_episode_count: 97,
      upfront_exploration_share: 0.171, exploration_tool_ratio: 0.042,
    },
    steering: {
      steering_event_rate: 0.409, correction_count: 536, interrupt_count: 90,
      rejected_output_count: 215, fast_correction_rate: 0.304,
    },
    debugging: {
      failure_count: 1110, retry_count: 155, debug_recovery_rate: 0.893,
      repeated_failure_rate: 0.024, mean_recovery_ms: 60039, error_rate: 0.026,
    },
    delegation: {
      subagent_spawn_count: 569, background_task_count: 571, max_spawn_depth: 1,
      delegation_completion_rate: 0.995,
    },
    git: {
      commit_count: 403, lines_added: 609269, lines_removed: 157360, files_changed: 2206,
      mean_commit_size: 1902, session_corroborated_commit_rate: 0.846,
      rework_ratio: 0.076, revert_count: 0,
    },
    quality: {
      deep_analysis_ran: false, test_file_ratio: 0.019, test_success_rate: 0.945,
      // Measured on the same real corpus: 5.70 reads per mutation, 23.9% of
      // mutations whole-file writes.
      read_edit_ratio: 5.7, write_share_of_mutations: 0.239,
      test_run_count: 1590,
    },
    outcome: { episode_count: 175, completed_episode_rate: 0.909, deployment_count: 126 },
    extra: { window_days: 71 },
    ...overrides,
  };
}

const score = (f: FeatureVector) =>
  scoreBuilder({ builder_id: "B1", features: f, pipeline_version: "0.1.0", source_count: 1, now: 0 });

describe("determinism (Doc 5 §9)", () => {
  test("identical features produce byte-identical scores", () => {
    const a = JSON.stringify(score(features()).record);
    const b = JSON.stringify(score(features()).record);
    expect(a).toBe(b);
  });

  test("stable across many runs", () => {
    const results = new Set(Array.from({ length: 30 }, () => score(features()).record.composite_score));
    expect(results.size).toBe(1);
  });
});

describe("anti-gaming (Doc 3 §11)", () => {
  test("prompt volume alone does not raise the composite", () => {
    const base = score(features()).record.composite_score;
    const chatty = score(features({
      interaction: { ...features().interaction, prompt_count: 15310 },
    })).record.composite_score;
    expect(chatty).toBeLessThanOrEqual(base);
  });

  test("commit volume alone does not raise Engineering", () => {
    const base = DIMENSION_FUNCTIONS.engineering(features()).score;
    const prolific = DIMENSION_FUNCTIONS.engineering(
      features({ git: { ...features().git, commit_count: 40_000, lines_added: 60_000_000 } }),
    ).score;
    expect(prolific).toBeCloseTo(base, 5);
  });

  test("long sessions show diminishing returns", () => {
    const f = features();
    const doubled = saturating(f.outcome.deployment_count * 2, CALIBRATION.deploymentCount);
    const single = saturating(f.outcome.deployment_count, CALIBRATION.deploymentCount);
    // Doubling the count must not double the contribution.
    expect(doubled - single).toBeLessThan(single * 0.5);
  });

  test("no dimension can exceed 100 even with absurd inputs", () => {
    const absurd = features({
      interaction: { ...features().interaction, mean_prompt_words: 1e9, files_touched: 1e9, distinct_extensions: 1e6, prompt_words_stddev: 1e9, tool_call_count: 1e9 },
      outcome: { episode_count: 1e6, completed_episode_rate: 1, deployment_count: 1e6 },
      delegation: { ...features().delegation, subagent_spawn_count: 1e6, delegation_completion_rate: 1 },
      steering: { ...features().steering, rejected_output_count: 1e6, fast_correction_rate: 1 },
    });
    for (const d of DIMENSIONS) {
      expect(DIMENSION_FUNCTIONS[d](absurd).score).toBeLessThanOrEqual(100);
    }
  });
});

describe("calibration", () => {
  test("a real profile saturates no dimension", () => {
    // The bug this pins: anchors guessed low put every count-based component at
    // 100%, so an active developer maxed out and the scale measured nothing.
    for (const d of DIMENSIONS) {
      const s = DIMENSION_FUNCTIONS[d](features()).score;
      expect(s).toBeLessThan(95);
      expect(s).toBeGreaterThan(20);
    }
  });

  test("no count-based component saturates on a real profile", () => {
    // Only counts matter here. A rate at 0.99 is a genuinely near-perfect record;
    // a saturating count curve at 1.0 means the anchor is too low and the
    // component has stopped telling anyone apart.
    for (const d of DIMENSIONS) {
      for (const c of DIMENSION_FUNCTIONS[d](features()).components) {
        if (c.kind !== "count") continue;
        expect(c.value, `${d}/${c.feature} is saturated`).toBeLessThan(0.95);
      }
    }
  });

  test("rates are allowed to be near-perfect", () => {
    const zeroReverts = DIMENSION_FUNCTIONS.engineering(features()).components
      .find((c) => c.feature === "git.revert_count");
    expect(zeroReverts?.kind).toBe("rate");
    expect(zeroReverts?.value).toBe(1);
  });

  test("an empty profile scores near zero rather than crashing", () => {
    const empty = features({
      interaction: { prompt_count: 0, tool_call_count: 0, assistant_turn_count: 0, active_ms: 0, files_touched: 0, distinct_extensions: 0, mean_prompt_words: 0, prompt_words_stddev: 0, session_count: 0, active_days: 0 },
      outcome: { episode_count: 0, completed_episode_rate: 0, deployment_count: 0 },
      quality: { deep_analysis_ran: false, test_file_ratio: 0, test_success_rate: 0, test_run_count: 0, read_edit_ratio: 0, write_share_of_mutations: 0 },
      git: { commit_count: 0, lines_added: 0, lines_removed: 0, files_changed: 0, mean_commit_size: 0, session_corroborated_commit_rate: 0, rework_ratio: 0, revert_count: 0 },
      delegation: { subagent_spawn_count: 0, background_task_count: 0, max_spawn_depth: 0, delegation_completion_rate: 0 },
      steering: { steering_event_rate: 0, correction_count: 0, interrupt_count: 0, rejected_output_count: 0, fast_correction_rate: 0 },
      planning: { plan_mode_used: false, plan_before_execution_rate: 0, planned_episode_count: 0, upfront_exploration_share: 0, exploration_tool_ratio: 0 },
      debugging: { failure_count: 0, retry_count: 0, debug_recovery_rate: 0, repeated_failure_rate: 0, mean_recovery_ms: 0, error_rate: 0 },
      extra: { window_days: 0 },
    });
    const r = score(empty).record;
    expect(r.composite_score).toBeLessThan(30);
    expect(r.confidence).toBeLessThan(0.2);
  });

  test("never running tests is not the same as passing them", () => {
    const noTests = features({
      quality: { deep_analysis_ran: false, test_file_ratio: 0, test_success_rate: 1, test_run_count: 0, read_edit_ratio: 0, write_share_of_mutations: 0 },
    });
    const ran = features();
    expect(DIMENSION_FUNCTIONS.engineering(noTests).score).toBeLessThan(
      DIMENSION_FUNCTIONS.engineering(ran).score,
    );
  });
});

describe("curves", () => {
  test("invertedU peaks in the middle, not at the extremes", () => {
    // Never correcting and constantly correcting are both worse than moderate.
    expect(invertedU(STEERING_PEAK, STEERING_PEAK, 0.3)).toBe(1);
    expect(invertedU(0, STEERING_PEAK, 0.3)).toBeLessThan(1);
    expect(invertedU(1.5, STEERING_PEAK, 0.3)).toBeLessThan(0.1);
  });

  test("band clamps outside its range", () => {
    expect(band(-5, 0, 10)).toBe(0);
    expect(band(50, 0, 10)).toBe(1);
    expect(band(5, 0, 10)).toBe(0.5);
  });

  test("inverseBand rewards low values", () => {
    expect(inverseBand(0, 0, 1)).toBe(1);
    expect(inverseBand(1, 0, 1)).toBe(0);
  });

  test("saturating never reaches 1 and never exceeds it", () => {
    expect(saturating(1e12, 10)).toBeLessThanOrEqual(1);
    expect(saturating(0, 10)).toBe(0);
  });
});

describe("confidence (Doc 3 §8)", () => {
  test("is separate from capability", () => {
    const r = score(features()).record;
    expect(r.confidence).not.toBe(r.composite_score / 100);
  });

  test("thin evidence lowers confidence and explains why", () => {
    const thin = features({
      outcome: { episode_count: 2, completed_episode_rate: 1, deployment_count: 0 },
      interaction: { ...features().interaction, active_days: 1 },
      extra: { window_days: 1 },
    });
    const c = computeConfidence(thin, 1);
    expect(c.value).toBeLessThan(0.5);
    expect(c.reasons.length).toBeGreaterThan(0);
    expect(c.reasons.join(" ")).toContain("episodes");
  });

  test("Product Thinking can never claim high confidence", () => {
    // The weakest dimension must not borrow certainty from the others.
    const r = score(features()).record;
    expect(r.product.confidence).toBeLessThanOrEqual(DIMENSION_CONFIDENCE_CEILING.product!);
    expect(r.product.confidence).toBeLessThan(r.steering.confidence);
  });

  test("Engineering confidence drops when no tests ran", () => {
    const noTests = features({
      quality: { deep_analysis_ran: false, test_file_ratio: 0, test_success_rate: 0, test_run_count: 0, read_edit_ratio: 0, write_share_of_mutations: 0 },
    });
    expect(score(noTests).record.engineering.confidence).toBeLessThan(
      score(features()).record.engineering.confidence,
    );
  });

  test("more agents means more source diversity", () => {
    expect(computeConfidence(features(), 3).value).toBeGreaterThan(
      computeConfidence(features(), 1).value,
    );
  });
});

describe("output contract (Doc 3 §10, Doc 4 §4)", () => {
  const { record } = score(features());

  test("carries every version needed to replay it", () => {
    expect(record.score_version).toBeTruthy();
    expect(record.feature_version).toBe("0.1.0");
    expect(record.pipeline_version).toBe("0.1.0");
  });

  test("every dimension names the evidence that moved it (Doc 3 §5)", () => {
    for (const d of DIMENSIONS) {
      expect((record as unknown as Record<Dimension, { evidence_refs: string[] }>)[d].evidence_refs.length).toBeGreaterThan(0);
    }
  });

  test("composite matches the documented weighting", () => {
    const dims = Object.fromEntries(
      DIMENSIONS.map((d) => [d, (record as unknown as Record<Dimension, { score: number }>)[d].score]),
    ) as Record<Dimension, number>;
    const manual = DIMENSIONS.reduce((a, d) => a + dims[d] * V1_WEIGHTS[d], 0);
    expect(record.composite_score).toBeCloseTo(manual, 1);
  });

  test("display score is the composite times 100", () => {
    expect(displayScore(record.composite_score)).toBe(Math.round(record.composite_score * 100));
    expect(displayScore(record.composite_score)).toBeLessThanOrEqual(10_000);
  });
});

describe("capability-aware scoring", () => {
  const ALL = [...SIGNALS];
  const withoutInterrupts = ALL.filter((s) => s !== "interrupts");

  test("a component whose signal is unavailable is dropped, not zeroed", () => {
    const full = DIMENSION_FUNCTIONS.steering(features({ observed_signals: ALL }));
    const blind = DIMENSION_FUNCTIONS.steering(features({ observed_signals: withoutInterrupts }));

    expect(full.components.some((c) => c.requires === "interrupts")).toBe(true);
    expect(blind.components.some((c) => c.requires === "interrupts")).toBe(false);
    expect(blind.components.length).toBe(full.components.length - 1);
  });

  test("remaining weights renormalize, so the score stays on the same scale", () => {
    const blind = DIMENSION_FUNCTIONS.steering(features({ observed_signals: withoutInterrupts }));
    expect(blind.score).toBeGreaterThan(0);
    expect(blind.score).toBeLessThanOrEqual(100);
  });

  test("a tool that cannot see a signal is not punished for it", () => {
    // The defect this prevents: ranking people by their editor. A builder whose
    // tool records interrupts badly must not score below one whose tool records
    // them well, given identical behaviour on everything else.
    const thrashing = { ...features().steering, steering_event_rate: 2.0 };

    const observed = DIMENSION_FUNCTIONS.steering(
      features({ observed_signals: ALL, steering: thrashing }),
    ).score;
    const cannotSee = DIMENSION_FUNCTIONS.steering(
      features({ observed_signals: withoutInterrupts, steering: thrashing }),
    ).score;

    // Not observing the signal must never be worse than observing a bad value.
    expect(cannotSee).toBeGreaterThanOrEqual(observed);
  });

  test("losing every optional signal still yields a usable score", () => {
    const minimal = features({ observed_signals: ["timestamps", "tool_calls"] });
    const r = scoreBuilder({
      builder_id: "B1", features: minimal, pipeline_version: "0.1.0", source_count: 1, now: 0,
    }).record;
    expect(r.composite_score).toBeGreaterThan(0);
    for (const d of DIMENSIONS) {
      const dim = (r as unknown as Record<Dimension, { score: number }>)[d];
      expect(Number.isFinite(dim.score)).toBe(true);
      expect(dim.score).toBeGreaterThanOrEqual(0);
      expect(dim.score).toBeLessThanOrEqual(100);
    }
  });
});
