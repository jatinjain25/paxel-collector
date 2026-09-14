/**
 * Artifacts produced on the developer's machine that are NEVER uploaded.
 *
 * This file exists because of the 2026-09-09 reversal. These types used to live
 * in payload.ts, which is what made them uploadable; the module boundary is now
 * the statement. Anything here is computed locally, read locally, and dropped
 * when the process exits or written only to the builder's own private report.
 *
 * Adding a field here is free. Moving one into payload.ts is a product decision
 * about what leaves someone's machine, and the landing page makes a promise
 * about it.
 */

/** Aggregate git metrics, feeding the Git feature family. Local only. */
export interface GitMetrics {
  commit_count: number;
  active_days: number;
  files_changed: number;
  lines_added: number;
  lines_removed: number;
  repo_count: number;
  session_corroborated_commit_rate: number;
}

/**
 * REMOVED 2026-09-13: `DecisionRecord` and `NarrativeRecord`.
 *
 * They described prose from a local model: a narrative, an archetype, a growth
 * edge. Each was exported and imported by nobody, and each occurred exactly
 * once in the repo, at its own declaration. No provider interface was ever
 * written, no local model runtime is installed, and prose never feeds a score
 * by design, so nothing was blocked on them and nothing degraded without them.
 *
 * An exported type with no implementation does not read as a plan. It reads as
 * something half-built, and it invites the next person to wire it up to
 * whatever is nearest. They can come back with the feature that needs them.
 */
