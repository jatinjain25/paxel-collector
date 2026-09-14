import type { AgentSource, Signal } from "./agent.ts";
import type { Dimension } from "./score.ts";

/**
 * Read models for the public web surfaces (Doc 4 §3 and §7).
 *
 * Separate from `ScoreRecord` on purpose: that is what the scorer produces, this
 * is what a page renders. Keeping them apart means the profile layout can change
 * without touching scoring, and scoring can gain fields the UI does not show.
 */

/** Doc 4 §5 — eligibility is a gate, and a builder is entitled to know why. */
export interface EligibilityCheck {
  label: string;
  passed: boolean;
  /** e.g. "10 sessions" — the bar, stated. */
  requirement: string;
  /** e.g. "275 sessions" — what they have. */
  actual: string;
}

export type ConfidenceBand = "high" | "moderate" | "low";

/** Doc 4 §6 — confidence is displayed distinctly from capability, never merged. */
export function confidenceBand(value: number): ConfidenceBand {
  if (value >= 0.8) return "high";
  if (value >= 0.6) return "moderate";
  return "low";
}

export interface DimensionView {
  dimension: Dimension;
  label: string;
  /** 0-100 */
  score: number;
  /** 0..1, always shown beside the score. */
  confidence: number;
  band: ConfidenceBand;
  /** Doc 3 §5 — what moved this dimension. */
  evidence_refs: string[];
  /** Plain-language statement of what the dimension asks (Doc 3 §2). */
  question: string;
}

export interface EvidenceView {
  sessions: number;
  events: number;
  episodes: number;
  commits: number;
  /** Distinct projects. See EvidenceCounts.projects for why not repositories. */
  projects: number;
  active_days: number;
  window_days: number;
  sources: AgentSource[];
  /**
   * Signals no contributing tool could observe. Shown so a builder can see what
   * their tools could not record, rather than wondering why a dimension is thin.
   */
  unobserved_signals: Signal[];
}

/**
 * Doc 4 §12 forbids showing a percentile without its comparison population, so
 * the two travel together or not at all — a percentile cannot be rendered
 * without the number it was computed against.
 */
export interface RankView {
  rank: number;
  previous_rank?: number;
  change?: number;
  peak_rank?: number;
  /** How many builders are ranked. Required before any percentile is shown. */
  population: number;
  percentile?: number;
}

export interface ProfileView {
  handle: string;
  builder_id: string;
  /** Doc 4 §3 — verification state, currently "authenticated" at best. */
  verified: boolean;
  /** Doc 4 §4 — 0-10,000, the composite times 100. */
  proof_score: number;
  composite: number;
  confidence: number;
  rank?: RankView;
  dimensions: DimensionView[];
  evidence: EvidenceView;
  archetype?: string;
  growth_edge?: string;
  eligibility: EligibilityCheck[];
  eligible: boolean;
  score_version: string;
  updated_at: number;
  /**
   * Owner-controlled visibility of the dimension breakdown.
   *
   * Default is score and rank only: a public profile publishes a judgement about
   * someone's work, and the breakdown is theirs to expose. Doc 4 §4 wants the
   * composite not to be opaque, so publishing is encouraged — but not imposed.
   */
  dimensions_public?: boolean;
  /** True when this row is generated for development. Never true in production. */
  sample?: boolean;
}

/** Doc 4 §7 — one row of the global board. */
export interface LeaderboardRow {
  rank: number;
  handle: string;
  builder_id: string;
  proof_score: number;
  confidence: number;
  band: ConfidenceBand;
  change?: number;
  archetype?: string;
  sample?: boolean;
}

export interface LeaderboardView {
  rows: LeaderboardRow[];
  population: number;
  updated_at: string;
  /** Set when any row is generated data, so the page can say so plainly. */
  contains_sample_data: boolean;
}

/** Doc 3 §2 — the question each dimension is trying to answer. */
export const DIMENSION_QUESTIONS: Readonly<Record<Dimension, string>> = {
  execution: "How effectively is intent turned into completed work?",
  steering: "How effectively is the AI directed and corrected?",
  engineering: "How sound is the engineering process and output?",
  product: "Is there reasoning about what should be built?",
  planning: "Is work structured before execution?",
};

export const DIMENSION_LABELS: Readonly<Record<Dimension, string>> = {
  execution: "Execution Leverage",
  steering: "Steering",
  engineering: "Engineering Quality",
  product: "Product Thinking",
  planning: "Planning",
};
