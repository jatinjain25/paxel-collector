import type { ConfidenceInputs, FeatureConfidence, FeatureVector } from "@builder/types";
import { band, clamp01, saturating, weighted } from "./curves.ts";

/**
 * Evidence confidence (Doc 3 §8), computed and stored separately from capability.
 *
 * The separation is the point. A confident 60 and an uncertain 90 are different
 * claims, and collapsing them into one number is how a leaderboard ends up
 * ranking people it knows nothing about above people it has measured. Doc 4 §5
 * gates the leaderboard on confidence ≥ 0.60 for exactly this reason.
 *
 * `model_agreement` from Doc 3 §8 is not used in V1: with a single local model
 * there is nothing to agree with, and filling it with a constant would inflate
 * confidence while meaning nothing. The field stays reserved.
 */

export function confidenceInputs(f: FeatureVector, sourceCount: number): ConfidenceInputs {
  const spanDays = f.extra.window_days ?? 0;
  return {
    evidence_count: f.outcome.episode_count,
    active_days: f.interaction.active_days,
    source_diversity: sourceCount,
    temporal_spread: spanDays,
    consistency: consistency(f),
  };
}

/**
 * How evenly work is distributed across the observation window.
 *
 * One frantic weekend and two steady months can produce identical totals, and
 * they support very different claims about how someone works. Days-with-activity
 * over days-elapsed separates them.
 */
export function consistency(f: FeatureVector): number {
  const span = f.extra.window_days ?? 0;
  if (span <= 0) return 0;
  return clamp01(f.interaction.active_days / span);
}

export function computeConfidence(
  f: FeatureVector,
  sourceCount: number,
): FeatureConfidence {
  const inputs = confidenceInputs(f, sourceCount);
  const reasons: string[] = [];

  // Doc 4 §5's thresholds are the shape of "enough": 10 sessions, 3 active days.
  // These curves reach full marks somewhat above those floors, so meeting the
  // minimum produces a passing but not confident score.
  const evidence = saturating(inputs.evidence_count, 15);
  const days = saturating(inputs.active_days, 10);
  const diversity = band(inputs.source_diversity, 1, 3);
  const spread = saturating(inputs.temporal_spread, 30);
  const steadiness = inputs.consistency;

  if (inputs.evidence_count < 10) reasons.push("Fewer than 10 work episodes observed");
  if (inputs.active_days < 3) reasons.push("Fewer than 3 active days");
  if (inputs.source_diversity < 2) reasons.push("Evidence from a single agent only");
  if (inputs.temporal_spread < 14) reasons.push("Observation window shorter than two weeks");
  if (inputs.consistency < 0.2) reasons.push("Activity concentrated in a few bursts");

  const value = weighted([
    { value: evidence, weight: 0.3 },
    { value: days, weight: 0.25 },
    { value: spread, weight: 0.2 },
    { value: steadiness, weight: 0.15 },
    { value: diversity, weight: 0.1 },
  ]);

  return { scope: f.scope, value, inputs, reasons };
}

/**
 * Per-dimension confidence.
 *
 * Overall confidence describes the evidence as a whole, but dimensions are not
 * equally well supported by it. Engineering Quality needs tests to have run;
 * Product Thinking rests on indirect proxies and should never claim the
 * certainty that Steering can. Reporting one number for all five would overstate
 * the weakest and understate the strongest.
 */
export const DIMENSION_CONFIDENCE_CEILING: Record<string, number> = {
  // Directly observable: interrupts, corrections, rejections are unambiguous.
  steering: 1.0,
  // Completion and recovery are well evidenced.
  execution: 0.95,
  // Depends on tests existing and on git being present.
  engineering: 0.85,
  // Structural signals, reasonably direct.
  planning: 0.8,
  // Structural shadows of something that lives in content we never read.
  product: 0.55,
};

export function dimensionConfidence(
  dimension: string,
  overall: number,
  f: FeatureVector,
): number {
  const ceiling = DIMENSION_CONFIDENCE_CEILING[dimension] ?? 0.8;
  let value = Math.min(overall, ceiling);

  // Specific evidence gaps cut further than the general ceiling.
  if (dimension === "engineering") {
    if (f.quality.test_run_count === 0) value *= 0.6;
    if (f.git.commit_count === 0) value *= 0.5;
  }
  if (dimension === "planning" && f.outcome.episode_count < 5) value *= 0.7;

  return clamp01(value);
}
