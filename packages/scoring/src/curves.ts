/**
 * Normalization curves mapping raw feature values into 0..1.
 *
 * Doc 3 §7 wants percentile and cohort-aware normalization "when enough data
 * exists". At launch it does not exist — there is no population to be a
 * percentile of, and Doc 4 §12 forbids showing a percentile without its
 * comparison population. So V1 uses absolute reference curves with anchor points
 * stated in the open.
 *
 * Every anchor here is a hypothesis, versioned with the score. They will be
 * replaced by real distributions once there is a population, and that swap is
 * cheap by design: scores recompute from stored features (Doc 5 §9).
 */

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Linear ramp: `lo` scores 0, `hi` scores 1, outside is clamped. */
export function band(x: number, lo: number, hi: number): number {
  if (hi === lo) return x >= hi ? 1 : 0;
  return clamp01((x - lo) / (hi - lo));
}

/** Lower is better: `lo` scores 1, `hi` scores 0. */
export function inverseBand(x: number, lo: number, hi: number): number {
  return 1 - band(x, lo, hi);
}

/**
 * Saturating curve for counts, reaching ~0.63 at `k` and approaching 1.
 *
 * This is how Doc 3 §11's "long AI sessions have diminishing returns" is
 * enforced: doubling a count near the top of the curve barely moves the score,
 * so volume cannot be farmed.
 */
export function saturating(x: number, k: number): number {
  if (k <= 0) return 0;
  return 1 - Math.exp(-Math.max(0, x) / k);
}

/**
 * Inverted-U: peaks at `peak`, falling away on both sides.
 *
 * Some behaviours are not monotonically good. Correction rate is the clearest
 * case: never correcting the agent means either flawless instructions or not
 * reading the output, and correcting constantly means thrashing. The good region
 * is in the middle, and a monotonic curve would rank one of the two failure
 * modes as excellent.
 */
export function invertedU(x: number, peak: number, width: number): number {
  if (width <= 0) return x === peak ? 1 : 0;
  return clamp01(Math.exp(-(((x - peak) / width) ** 2)));
}

/** Weighted mean of already-normalized 0..1 components. */
export function weighted(components: { value: number; weight: number }[]): number {
  let total = 0;
  let weightSum = 0;
  for (const c of components) {
    total += clamp01(c.value) * c.weight;
    weightSum += c.weight;
  }
  return weightSum === 0 ? 0 : total / weightSum;
}
