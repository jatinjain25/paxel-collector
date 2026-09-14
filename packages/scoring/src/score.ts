import type {
  Dimension,
  DimensionScore,
  FeatureVector,
  ScoreRecord,
} from "@builder/types";
import { compositeScore, DIMENSIONS, V1_WEIGHTS } from "@builder/types";
import { computeConfidence, dimensionConfidence } from "./confidence.ts";
import { DIMENSION_FUNCTIONS, type DimensionBreakdown } from "./dimensions.ts";

/**
 * The scoring function (Doc 3 §6, output per Doc 3 §10).
 *
 * Runs on the DEVELOPER'S MACHINE, from features extracted there. This said
 * "runs on the SERVER, from an uploaded feature vector" until the 2026-09-09
 * reversal moved scoring to the client so that nothing but the score leaves the
 * machine. The forgery class that broke Paxel is therefore expressible again;
 * see the note on `UploadPayload` for what replaces the architectural defence.
 *
 * It is still a pure function of (features, weights, version) — same inputs,
 * same output, always — which is what makes a score reproducible by anyone
 * holding the same evidence. Doc 5 §9's replay and Doc 4 §8's rank rebuild no
 * longer follow from it, because the server never receives the features; a
 * reweighting now requires every builder to re-run the collector.
 */

export const SCORE_VERSION = "v1.0";

export interface ScoringConfig {
  /** Doc 3 §6 calls these "a versioned V1 hypothesis"; they live in config. */
  weights: Readonly<Record<Dimension, number>>;
  score_version: string;
}

export const DEFAULT_CONFIG: ScoringConfig = {
  weights: V1_WEIGHTS,
  score_version: SCORE_VERSION,
};

export interface ScoreInput {
  builder_id: string;
  features: FeatureVector;
  pipeline_version: string;
  /** How many distinct agents contributed, for Doc 3 §8 source diversity. */
  source_count: number;
  config?: ScoringConfig;
  now?: number;
}

export interface ScoreOutput {
  record: ScoreRecord;
  /** Per-dimension component breakdown, for explaining a score. */
  breakdowns: Record<Dimension, DimensionBreakdown>;
}

export function scoreBuilder(input: ScoreInput): ScoreOutput {
  const config = input.config ?? DEFAULT_CONFIG;
  const f = input.features;
  const confidence = computeConfidence(f, input.source_count);

  const breakdowns = {} as Record<Dimension, DimensionBreakdown>;
  const dimensionScores = {} as Record<Dimension, number>;
  const scored = {} as Record<Dimension, DimensionScore>;

  for (const d of DIMENSIONS) {
    const breakdown = DIMENSION_FUNCTIONS[d](f);
    breakdowns[d] = breakdown;
    dimensionScores[d] = breakdown.score;
    scored[d] = {
      score: round2(breakdown.score),
      confidence: round2(dimensionConfidence(d, confidence.value, f)),
      // Doc 3 §5 — every claim carries its evidence. These name the features
      // that moved the dimension, ordered by contribution, so a score can always
      // be traced to what produced it.
      evidence_refs: breakdown.components
        .filter((c) => c.value > 0)
        .sort((a, b) => b.value * b.weight - a.value * a.weight)
        .slice(0, 4)
        .map((c) => c.feature),
    };
  }

  const composite = compositeScore(dimensionScores, config.weights);
  const window = scopeWindow(f);

  const record: ScoreRecord = {
    builder_id: input.builder_id,
    execution: scored.execution,
    steering: scored.steering,
    engineering: scored.engineering,
    product: scored.product,
    planning: scored.planning,
    composite_score: round2(composite),
    confidence: round2(confidence.value),
    score_version: config.score_version,
    feature_version: f.feature_version,
    pipeline_version: input.pipeline_version,
    calculated_at: input.now ?? Date.now(),
    window_from: window.from,
    window_to: window.to,
  };

  return { record, breakdowns };
}

function scopeWindow(f: FeatureVector): { from: number; to: number } {
  return f.scope.kind === "window" ? { from: f.scope.from, to: f.scope.to } : { from: 0, to: 0 };
}

/**
 * Two decimal places.
 *
 * Determinism matters more than precision here: an unrounded float can differ in
 * its last bits between machines, and two servers must never disagree about a
 * rank. Doc 4 §4's display score is round(composite * 100), so two decimals is
 * exactly the precision the product surfaces.
 */
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
