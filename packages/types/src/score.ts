/**
 * Doc 3 §6 and §10 — dimension scores, composite, and the score contract.
 *
 * Produced on the developer's machine and uploaded as-is. This said "produced
 * by the SERVER from an uploaded feature vector" until the 2026-09-09 reversal;
 * `UploadPayload` now carries a `ScoreRecord` directly, and payload.ts records
 * what that costs and what compensates for it.
 */

/** Doc 3 §2 — the five behavioral dimensions. */
export const DIMENSIONS = ["execution", "steering", "engineering", "product", "planning"] as const;
export type Dimension = (typeof DIMENSIONS)[number];

/**
 * Doc 3 §6 — "Treat the weights as a versioned V1 hypothesis; store them in
 * configuration." This is the V1 default, loaded from config rather than
 * referenced directly, so a reweighting is a config change plus a recompute.
 */
export const V1_WEIGHTS: Readonly<Record<Dimension, number>> = Object.freeze({
  execution: 0.25,
  steering: 0.2,
  engineering: 0.25,
  product: 0.15,
  planning: 0.15,
});

/** Doc 3 §6 — dimension scores are 0-100. */
export const DIMENSION_MIN = 0;
export const DIMENSION_MAX = 100;

export interface DimensionScore {
  /** 0-100 */
  score: number;
  /** 0..1, computed separately from capability (Doc 3 §8). */
  confidence: number;
  /**
   * Doc 3 §5 — every claim carries its evidence. Feature ids and episode ids
   * that moved this dimension, so a score is explicable rather than asserted.
   */
  evidence_refs: string[];
}

/** Doc 3 §10 — the scoring output contract. */
export interface ScoreRecord {
  builder_id: string;
  execution: DimensionScore;
  steering: DimensionScore;
  engineering: DimensionScore;
  product: DimensionScore;
  planning: DimensionScore;
  /** Internal composite, 0-100 (Doc 4 §4). */
  composite_score: number;
  /** Overall evidence confidence, kept separate from capability (Doc 4 §6). */
  confidence: number;
  score_version: string;
  feature_version: string;
  pipeline_version: string;
  calculated_at: number;
  /** The evidence window this score summarizes (Doc 4 §12 traceability). */
  window_from: number;
  window_to: number;
}

/**
 * Doc 4 §4 — internal composite is 0-100; the displayed Proof Score is 0-10,000.
 * Kept as a function rather than a stored column so the two can never disagree.
 */
export function displayScore(internalComposite: number): number {
  return Math.round(internalComposite * 100);
}

/** Doc 3 §6 — composite from weighted dimensions. Weights come from config. */
export function compositeScore(
  dimensions: Readonly<Record<Dimension, number>>,
  weights: Readonly<Record<Dimension, number>> = V1_WEIGHTS,
): number {
  let total = 0;
  let weightSum = 0;
  for (const d of DIMENSIONS) {
    total += dimensions[d] * weights[d];
    weightSum += weights[d];
  }
  // Normalizing by the weight sum keeps the composite in 0-100 even if a
  // reweighting does not sum to exactly 1.
  return weightSum === 0 ? 0 : total / weightSum;
}
