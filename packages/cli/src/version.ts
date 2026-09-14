/**
 * Doc 2 §8 and Doc 5 §8 — versions travel with every payload and every log line.
 *
 * These are separate on purpose. `PIPELINE_VERSION` changes when the meaning of
 * derived evidence changes and is an idempotency key (Doc 2 §8), so bumping it
 * invalidates prior derivations. `CLIENT_VERSION` is just the shipped build.
 * Conflating them would silently reprocess everything on a cosmetic release.
 */
export const CLIENT_VERSION = "0.1.0";
export const PIPELINE_VERSION = "0.1.0";
export const FEATURE_VERSION = "0.1.0";
