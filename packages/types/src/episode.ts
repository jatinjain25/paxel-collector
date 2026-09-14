import type { AgentSource, SourceRef } from "./agent.ts";

/**
 * Doc 2 §5 — a session is one contiguous coding-agent interaction; an episode is
 * a coherent unit of work that can span several. Both are stored as derived
 * metadata with their inputs recorded, never as an opaque model decision.
 */
export interface SessionRecord {
  session_id: string;
  source: AgentSource;
  project_id: string;
  started_at: number;
  ended_at: number;
  /** Wall clock minus idle gaps over the threshold. */
  active_ms: number;
  event_count: number;
  prompt_count: number;
  /** Half of the `session_id + content hash` idempotency key (Doc 2 §8). */
  content_hash: string;
  source_ref: SourceRef;
  /** Model that served the session, where the agent records it. */
  model?: string;
  branch_hash?: string;
}

/** Doc 2 §5 — what drove an episode boundary. Recorded so grouping is auditable. */
export const EPISODE_BOUNDARIES = [
  "commit",
  "time_proximity",
  "task_similarity",
  "task_transition",
  "project",
] as const;
export type EpisodeBoundary = (typeof EPISODE_BOUNDARIES)[number];

/** Git metadata only — no diffs, no patch content, ever (Doc 2 §7). */
export interface CommitRef {
  sha: string;
  /** Epoch ms, author date. */
  timestamp: number;
  /** sha256 of author email — attribution without storing identity. */
  author_hash: string;
  lines_added: number;
  lines_removed: number;
  files_changed: number;
  /** Length only; the message itself stays local. */
  subject_length: number;
  is_merge: boolean;
  /**
   * Classified locally from the subject, which itself never leaves the machine.
   * A boolean of the same kind as `is_merge`: the server needs to know a revert
   * happened without ever seeing what was reverted.
   */
  is_revert: boolean;
  /** True when a local session overlaps this commit (Doc 3 §11 weighting). */
  session_corroborated: boolean;
  /**
   * Reserved for external anchoring against GitHub. Unused in V1 — present so
   * upgrading "verified account" (Doc 4 §5) from authenticated to
   * commit-anchored needs no schema migration.
   */
  verification?: CommitVerification;
}

export interface CommitVerification {
  method: "github_api" | "signature";
  verified_at: number;
  author_matches: boolean;
}

export interface EpisodeRecord {
  episode_id: string;
  /** Stable across re-uploads of the same evidence — the idempotency anchor. */
  evidence_key: string;
  project_id: string;
  sources: AgentSource[];
  boundary: EpisodeBoundary;
  started_at: number;
  ended_at: number;
  active_ms: number;
  session_ids: string[];
  commits: CommitRef[];
  /** Reached a plausible finish (Doc 3 §3 `completed_episode_rate`). */
  completed: boolean;
}
