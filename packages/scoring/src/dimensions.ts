import type { Dimension, FeatureVector, Signal } from "@builder/types";
import { band, inverseBand, invertedU, saturating, weighted } from "./curves.ts";

/**
 * Feature → dimension mapping (Doc 3 §2, §6).
 *
 * Each dimension is a weighted blend of normalized features, and each component
 * records which feature it came from so Doc 3 §5's evidence requirement can be
 * satisfied: a score can always say what moved it.
 *
 * Doc 3 §11's anti-gaming rules are enforced here rather than checked
 * afterwards. Nothing in this file reads a raw count as "more is better" without
 * a saturating curve, and nothing reads prompt or commit volume directly.
 */


/**
 * CALIBRATION ANCHORS — the weakest part of V1 scoring, stated plainly.
 *
 * Doc 3 §7 wants percentile and cohort-aware normalization "when enough data
 * exists". It does not exist yet: the population is one developer. So these are
 * absolute anchors, and absolute anchors are guesses.
 *
 * The first set was guessed low and every count-based component saturated at
 * 100% against a real 71-day corpus — deployment_count 126 against an anchor of
 * 5, subagent spawns 569 against 10, prompt words 120 against 60. A scale where
 * an active developer maxes out every component is not measuring anything; it
 * just says "yes".
 *
 * These are re-derived so the one real profile available lands near the middle
 * of each curve, leaving headroom above and below. That is calibration against
 * n=1, which is barely calibration: it fixes the saturation but carries no claim
 * that the midpoint is where a typical builder belongs.
 *
 * PARTIALLY REPLACED 2026-09-10. Two anchors now come from a published analysis
 * of 6,852 Claude Code sessions and 234,760 tool calls
 * (github.com/lucemia/claude-session-analyzer, MIT, from the methodology in
 * anthropics/claude-code#42796). They are marked. Everything unmarked is still
 * n=1 and still a guess; the population fixed two of fifteen.
 *
 * A third published threshold was deliberately NOT adopted. Their "frustration
 * indicators" (<6% good, >10% degraded) are sentiment and word-frequency
 * derived; our `steering_event_rate` counts corrections structurally and never
 * reads content. The numbers are not measuring the same thing, and borrowing a
 * threshold across two different measurements would look rigorous while meaning
 * nothing.
 *
 * Because scores recompute from stored evidence (Doc 5 §9), swapping these for
 * real percentiles is a config change and a rescore, not a re-upload.
 */
export const CALIBRATION = {
  /**
   * PUBLISHED: >6.0 research-first, 2.0-6.0 transition, <2.0 edit-first.
   * The drop from 6.6 to 2.0 was the measurable signature of a quality
   * regression across 234,760 tool calls.
   */
  readEditLo: 2.0,
  readEditHi: 6.0,
  /**
   * PUBLISHED: <5% healthy, >10% degraded. Rewriting a whole file where an edit
   * would do is the signature of not having read it first.
   *
   * Caveat worth keeping: greenfield work legitimately writes more new files
   * than maintenance does, so this reads harsh on a young repository. It is one
   * component at 0.10 weight for that reason.
   */
  writeShareLo: 0.05,
  writeShareHi: 0.10,
  /** Work per instruction. Observed ~40. */
  toolCallsPerPrompt: 45,
  /** Observed 126 over ~10 weeks. */
  deploymentCount: 60,
  /** Observed 215. */
  rejectedOutputs: 200,
  /** Observed 2.4%. Band starts at 0 so a clean record is not free marks. */
  repeatedFailureLo: 0.0,
  repeatedFailureHi: 0.3,
  /** Observed 1.9%. 20% remains the target, deliberately unmoved. */
  testFileRatioHi: 0.2,
  /** Observed 7.6%. */
  reworkLo: 0.05,
  reworkHi: 0.35,
  /** Observed 120.6 words. */
  promptWords: 130,
  /** Observed 443.8. */
  promptWordsStdDev: 480,
  /** Observed 766. */
  filesTouched: 830,
  /** Observed 15. */
  distinctExtensions: 16,
  /** Observed 569. */
  subagentSpawns: 400,
  /** Observed 17.1%. */
  upfrontExplorationHi: 0.25,
  /** Observed 4.2%. */
  explorationRatioHi: 0.15,
} as const;

export interface Component {
  /** Feature that produced this, for evidence references. */
  feature: string;
  /** Normalized 0..1. */
  value: number;
  weight: number;
  /**
   * What kind of quantity this came from.
   *
   * `count` values pass through a saturating curve and must never sit at 1.0 for
   * a real profile — that means the anchor is too low and the component has
   * stopped discriminating. `rate` values are already 0..1 and may legitimately
   * be near-perfect. `flag` is boolean and is always exactly 0 or 1.
   *
   * The distinction exists because conflating them hides a real calibration bug
   * behind two harmless ones.
   */
  kind: "count" | "rate" | "flag";
  /**
   * Signal this component depends on. Undefined means it needs only what every
   * source must provide.
   *
   * When a source cannot observe the signal, the component is dropped and the
   * remaining weights renormalize — `weighted()` divides by the weights it is
   * given, so removal is the whole mechanism. A builder is scored on what their
   * tools could actually see, and a missing signal costs certainty rather than
   * points. Without this, a Cursor user's Steering would be depressed purely
   * because Cursor does not record interrupts.
   */
  requires?: Signal;
}

/** Drop components whose signal the contributing sources could not observe. */
export function availableComponents(
  components: Component[],
  observed: readonly Signal[],
): Component[] {
  const set = new Set(observed);
  return components.filter((c) => c.requires === undefined || set.has(c.requires));
}

export interface DimensionBreakdown {
  dimension: Dimension;
  /** 0-100 */
  score: number;
  components: Component[];
}

/**
 * Execution Leverage — "How effectively does the builder turn intent into
 * completed work?" (Doc 3 §2)
 *
 * Note what is absent: commit count, line count, and prompt count. Doc 3 §11 is
 * explicit that commit volume must not equal execution quality, so this reads
 * completion and recovery — whether work got finished — rather than how much
 * activity occurred.
 */
export function executionLeverage(f: FeatureVector): DimensionBreakdown {
  const components: Component[] = [
    {
      feature: "outcome.completed_episode_rate",
      kind: "rate",
      value: f.outcome.completed_episode_rate,
      weight: 0.35,
    },
    {
      feature: "debugging.debug_recovery_rate",
      kind: "rate",
      value: f.debugging.debug_recovery_rate,
      weight: 0.2,
    },
    {
      feature: "delegation.delegation_completion_rate",
      requires: "subagents",
      kind: "rate",
      value: f.delegation.delegation_completion_rate,
      weight: 0.15,
    },
    {
      // Work accomplished per instruction. Saturating, so issuing more prompts
      // cannot inflate it and neither can a runaway agent loop.
      feature: "interaction.tool_call_count / prompt_count",
      kind: "count",
      value: saturating(
        f.interaction.prompt_count === 0
          ? 0
          : f.interaction.tool_call_count / f.interaction.prompt_count,
        CALIBRATION.toolCallsPerPrompt,
      ),
      weight: 0.2,
    },
    {
      feature: "outcome.deployment_count",
      requires: "commands",
      kind: "count",
      value: saturating(f.outcome.deployment_count, CALIBRATION.deploymentCount),
      weight: 0.1,
    },
  ];
  const avail = availableComponents(components, f.observed_signals);
  return { dimension: "execution", score: weighted(avail) * 100, components: avail };
}

/**
 * Steering — "How effectively does the builder direct and correct AI?"
 *
 * The correction rate uses an inverted-U rather than "more is better". Never
 * correcting the agent means either flawless instructions or not reading the
 * output, and correcting constantly means thrashing; both are worse than the
 * middle. A monotonic curve would have to call one of those two failure modes
 * excellent.
 *
 * The peak at 0.25 is a hypothesis. On real data one developer sits at 0.41,
 * which this treats as good but past ideal — exactly the kind of anchor that
 * should be replaced by a real distribution once there is a population.
 */
export const STEERING_PEAK = 0.25;
export const STEERING_WIDTH = 0.3;

export function steering(f: FeatureVector): DimensionBreakdown {
  const components: Component[] = [
    {
      feature: "steering.steering_event_rate",
      requires: "interrupts",
      kind: "rate",
      value: invertedU(f.steering.steering_event_rate, STEERING_PEAK, STEERING_WIDTH),
      weight: 0.25,
    },
    {
      // Catching a wrong turn early rather than twenty turns later.
      feature: "steering.fast_correction_rate",
      kind: "rate",
      value: f.steering.fast_correction_rate,
      weight: 0.3,
    },
    {
      // Not making the same mistake twice.
      feature: "debugging.repeated_failure_rate",
      kind: "rate",
      value: inverseBand(
        f.debugging.repeated_failure_rate,
        CALIBRATION.repeatedFailureLo,
        CALIBRATION.repeatedFailureHi,
      ),
      weight: 0.25,
    },
    {
      // Rejecting a proposed action is steering that never became a prompt.
      feature: "steering.rejected_output_count",
      requires: "permission_denials",
      kind: "count",
      value: saturating(f.steering.rejected_output_count, CALIBRATION.rejectedOutputs),
      weight: 0.2,
    },
  ];
  const avail = availableComponents(components, f.observed_signals);
  return { dimension: "steering", score: weighted(avail) * 100, components: avail };
}

/**
 * Engineering Quality — "How sound is the engineering process/output?"
 *
 * The test-file ratio anchor deserves comment. Real data from one repo shows
 * 1.9%, which is genuinely low, and the honest thing is for that to register.
 * But it is deliberately not dominant: at 30% weight, a repo with no tests can
 * still reach a middling Engineering score on rework, reverts and test success.
 * A single signal should not become a verdict, and Doc 3 §8 keeps confidence
 * separate precisely so thin evidence can say so rather than being averaged in.
 */
export function engineeringQuality(f: FeatureVector): DimensionBreakdown {
  const components: Component[] = [
    {
      feature: "quality.test_file_ratio",
      kind: "rate",
      // 0% scores 0, 20% scores full marks. Beyond that is not better.
      value: band(f.quality.test_file_ratio, 0, CALIBRATION.testFileRatioHi),
      weight: 0.2,
    },
    {
      feature: "quality.test_success_rate",
      requires: "test_results",
      kind: "rate",
      // Only meaningful if tests were actually run; no runs is not a pass.
      value: f.quality.test_run_count === 0 ? 0 : f.quality.test_success_rate,
      weight: 0.2,
    },
    {
      // The one component here with a real population behind its anchor rather
      // than a guess fitted to a single machine.
      feature: "quality.read_edit_ratio",
      kind: "rate",
      value: band(f.quality.read_edit_ratio, CALIBRATION.readEditLo, CALIBRATION.readEditHi),
      weight: 0.15,
    },
    {
      feature: "quality.write_share_of_mutations",
      kind: "rate",
      value: inverseBand(
        f.quality.write_share_of_mutations,
        CALIBRATION.writeShareLo,
        CALIBRATION.writeShareHi,
      ),
      weight: 0.1,
    },
    {
      feature: "git.rework_ratio",
      kind: "rate",
      value: inverseBand(f.git.rework_ratio, CALIBRATION.reworkLo, CALIBRATION.reworkHi),
      weight: 0.2,
    },
    {
      feature: "git.revert_count",
      kind: "rate",
      value: inverseBand(
        f.git.commit_count === 0 ? 0 : f.git.revert_count / f.git.commit_count,
        0.01,
        0.1,
      ),
      weight: 0.15,
    },
  ];
  const avail = availableComponents(components, f.observed_signals);
  return { dimension: "engineering", score: weighted(avail) * 100, components: avail };
}

/**
 * Product Thinking — "Does the builder reason about what should be built?"
 *
 * The weakest of the five, and the code should say so rather than hide it.
 * Requirements, edge cases, scope and user impact live in the *content* of what
 * someone writes, and the ranked path deliberately never reads content. What is
 * left are structural shadows.
 *
 * An earlier version borrowed completed_episode_rate from Execution and
 * plan_before_execution_rate from Planning, and scored 80.8 on real data — but
 * its top contributor was identical to Execution's, meaning it was reporting a
 * blend of its neighbours as if it were an independent reading. It also let one
 * feature reach the composite through two channels, quietly doubling its
 * influence.
 *
 * So this now uses only signals not already owned by another dimension:
 * specificity of instruction, variation in how much context is given, and the
 * breadth of material touched. Those are thin, and the resulting score is lower
 * and less flattering. That is the correct outcome — Doc 3 §8's separate
 * confidence exists so a weak dimension can report weakly instead of borrowing
 * certainty from stronger ones.
 */
export function productThinking(f: FeatureVector): DimensionBreakdown {
  const components: Component[] = [
    {
      // Instructions long enough to actually specify something. Saturating, so
      // padding prompts cannot farm it — Doc 3 §11.
      feature: "interaction.mean_prompt_words",
      kind: "count",
      value: saturating(f.interaction.mean_prompt_words, CALIBRATION.promptWords),
      weight: 0.35,
    },
    {
      // Varying depth: some quick, some detailed, rather than one register for
      // everything. Matching instruction depth to task difficulty is the closest
      // observable shadow of judging what a piece of work needs.
      feature: "interaction.prompt_words_stddev",
      kind: "count",
      value: saturating(f.interaction.prompt_words_stddev, CALIBRATION.promptWordsStdDev),
      weight: 0.25,
    },
    {
      feature: "interaction.distinct_extensions",
      kind: "count",
      value: saturating(f.interaction.distinct_extensions, CALIBRATION.distinctExtensions),
      weight: 0.2,
    },
    {
      // Breadth of surface touched, as a weak proxy for considering more than
      // the immediate file.
      feature: "interaction.files_touched",
      kind: "count",
      value: saturating(f.interaction.files_touched, CALIBRATION.filesTouched),
      weight: 0.2,
    },
  ];
  const avail = availableComponents(components, f.observed_signals);
  return { dimension: "product", score: weighted(avail) * 100, components: avail };
}

/**
 * Planning — "Does the builder structure work before execution?"
 *
 * Deliberately overlaps Product Thinking on plan_before_execution_rate: the two
 * dimensions ask different questions of the same behaviour (did you structure
 * the work vs did you understand what to build), and Doc 3's dimensions are not
 * claimed to be orthogonal.
 */
export function planning(f: FeatureVector): DimensionBreakdown {
  const components: Component[] = [
    {
      feature: "planning.plan_before_execution_rate",
      kind: "rate",
      value: f.planning.plan_before_execution_rate,
      weight: 0.3,
    },
    {
      feature: "planning.upfront_exploration_share",
      kind: "rate",
      // 25% of an episode spent orienting is full marks; more is not better.
      value: band(f.planning.upfront_exploration_share, 0, CALIBRATION.upfrontExplorationHi),
      weight: 0.25,
    },
    {
      feature: "planning.exploration_tool_ratio",
      kind: "rate",
      value: band(f.planning.exploration_tool_ratio, 0, CALIBRATION.explorationRatioHi),
      weight: 0.2,
    },
    {
      feature: "planning.plan_mode_used",
      requires: "plan_mode",
      kind: "flag",
      value: f.planning.plan_mode_used ? 1 : 0,
      weight: 0.1,
    },
    {
      feature: "delegation.subagent_spawn_count",
      requires: "subagents",
      kind: "count",
      // Decomposing work into delegable pieces is a planning behaviour.
      value: saturating(f.delegation.subagent_spawn_count, CALIBRATION.subagentSpawns),
      weight: 0.15,
    },
  ];
  const avail = availableComponents(components, f.observed_signals);
  return { dimension: "planning", score: weighted(avail) * 100, components: avail };
}

export const DIMENSION_FUNCTIONS = {
  execution: executionLeverage,
  steering,
  engineering: engineeringQuality,
  product: productThinking,
  planning,
} as const satisfies Record<Dimension, (f: FeatureVector) => DimensionBreakdown>;
