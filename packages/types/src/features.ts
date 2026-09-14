import type { Signal } from "./agent.ts";

/**
 * Deterministic feature layer (Doc 3 §3) organized into Doc 2 §6's families.
 *
 * These are the ONLY input to the ranked score. They are computed on-device and
 * uploaded; the server recomputes every dimension from them, so no client ever
 * supplies a number that becomes a rank.
 *
 * Doc 3 §3: "Preserve raw values for auditability." Every rate therefore ships
 * alongside the counts it was derived from — a rate alone cannot be audited,
 * and 1/1 must be distinguishable from 400/400.
 */

/** Doc 5 §4 — features are stored "by window/version". */
export type FeatureScope =
  | { kind: "episode"; episode_id: string }
  | { kind: "window"; from: number; to: number };

/** Doc 2 §6 — prompt count, tool calls, duration, files touched. */
export interface InteractionFeatures {
  prompt_count: number;
  tool_call_count: number;
  assistant_turn_count: number;
  active_ms: number;
  files_touched: number;
  distinct_extensions: number;
  mean_prompt_words: number;
  prompt_words_stddev: number;
  /** Doc 3 §3 */
  session_count: number;
  /** Doc 3 §3 */
  active_days: number;
}

/** Doc 2 §6 — plan detected, decomposition, acceptance criteria, architecture discussion. */
export interface PlanningFeatures {
  plan_mode_used: boolean;
  /** Doc 3 §3 */
  plan_before_execution_rate: number;
  planned_episode_count: number;
  /** Share of an episode elapsing before the first mutating tool call. */
  upfront_exploration_share: number;
  /** Read/Grep/Glob as a share of all tool calls. */
  exploration_tool_ratio: number;
}

/** Doc 2 §6 — corrections, constraints, redirections, rejected outputs. */
export interface SteeringFeatures {
  /** Doc 3 §3 */
  steering_event_rate: number;
  correction_count: number;
  interrupt_count: number;
  /** Permission denials — the developer rejecting a proposed action. */
  rejected_output_count: number;
  /** Corrections landing within one turn of the output they correct. */
  fast_correction_rate: number;
}

/** Doc 2 §6 — failures, retries, recovery time, repeated failures. */
export interface DebuggingFeatures {
  failure_count: number;
  retry_count: number;
  /** Doc 3 §3 */
  debug_recovery_rate: number;
  /** Doc 3 §3 — the same failure recurring, which recovery rate alone hides. */
  repeated_failure_rate: number;
  mean_recovery_ms: number;
  error_rate: number;
}

/** Doc 2 §6 — subagents, dispatches, returns, background tasks. */
export interface DelegationFeatures {
  subagent_spawn_count: number;
  background_task_count: number;
  max_spawn_depth: number;
  /** Spawned agents that returned a usable result rather than being abandoned. */
  delegation_completion_rate: number;
}

/** Doc 2 §6 — commits, active days, files changed, additions/deletions. */
export interface GitFeatures {
  commit_count: number;
  lines_added: number;
  lines_removed: number;
  files_changed: number;
  mean_commit_size: number;
  /**
   * Doc 3 §11: "Repository activity without matching local evidence gets limited
   * weight." Share of commits reconcilable with an observed session.
   */
  session_corroborated_commit_rate: number;
  /** Lines rewritten within the rework window of being written. */
  rework_ratio: number;
  revert_count: number;
}

/**
 * Doc 2 §6 — complexity, tests, static findings, duplication, security findings.
 *
 * `test_file_ratio` and the churn-derived signals need only paths and counts, so
 * they are always available. The rest requires the Doc 5 §2 toolchain
 * (tree-sitter, Semgrep, CodeQL) and is absent unless the deep pass ran — hence
 * `deep_analysis_ran`, so a missing value is never read as a zero.
 */
export interface QualityFeatures {
  deep_analysis_ran: boolean;
  /**
   * File reads per file mutation.
   *
   * From the analysis behind anthropics/claude-code#42796, over 6,852 sessions
   * and 234,760 tool calls: above 6.0 is research-first work, below 2.0 is
   * edit-first, and the drop from 6.6 to 2.0 was the measurable signature of a
   * quality regression. One of the few signals here with a published
   * population behind it rather than a guess.
   */
  read_edit_ratio: number;
  /**
   * Whole-file writes as a share of all mutations.
   *
   * Same source: under 5% is healthy, over 10% degraded. Rewriting a file where
   * an edit would do is the signature of not having read it first, which is why
   * it moves with the ratio above.
   */
  write_share_of_mutations: number;
  test_file_ratio: number;
  /** Doc 3 §3 */
  test_success_rate: number;
  test_run_count: number;
  mean_complexity?: number;
  static_finding_count?: number;
  security_finding_count?: number;
  duplication_ratio?: number;
}

/** Episode-completion signals that cut across families. */
export interface OutcomeFeatures {
  episode_count: number;
  /** Doc 3 §3 */
  completed_episode_rate: number;
  deployment_count: number;
}

export interface FeatureVector {
  feature_version: string;
  scope: FeatureScope;
  /**
   * Union of signals the contributing sources could observe.
   *
   * A feature derived from a signal absent here is not a measurement of zero —
   * it is a measurement that could not be taken. Scoring drops the affected
   * components and renormalizes rather than treating the gap as a low value.
   */
  observed_signals: Signal[];
  interaction: InteractionFeatures;
  planning: PlanningFeatures;
  steering: SteeringFeatures;
  debugging: DebuggingFeatures;
  delegation: DelegationFeatures;
  git: GitFeatures;
  quality: QualityFeatures;
  outcome: OutcomeFeatures;
  /** Additions not yet promoted to a named field. Numeric only. */
  extra: Record<string, number>;
}

/**
 * Doc 3 §8 — confidence is computed and stored separately from capability, and
 * Doc 4 §6 keeps them separate in storage and UI. A confident low score and an
 * uncertain high score are different claims and must never be conflated.
 *
 * `model_agreement` from Doc 3 §8 is reserved but unused in V1: with a single
 * local model there is nothing to agree with, and a constant would inflate the
 * number while meaning nothing.
 */
export interface ConfidenceInputs {
  evidence_count: number;
  active_days: number;
  /** How many distinct agents contributed. One source is weaker than three. */
  source_diversity: number;
  /** How widely evidence spreads in time — one busy weekend is not two months. */
  temporal_spread: number;
  /** Variance across episodes; erratic evidence supports a weaker claim. */
  consistency: number;
  model_agreement?: number;
}

export interface FeatureConfidence {
  scope: FeatureScope;
  /** 0..1 */
  value: number;
  inputs: ConfidenceInputs;
  /** Human-readable causes, shown in the profile so a low score is explicable. */
  reasons: string[];
}
