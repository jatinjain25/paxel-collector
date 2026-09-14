import type { AgentSource, LocalEvent, SessionRecord, Signal } from "@builder/types";

/**
 * The contract every source adapter implements.
 *
 * Doc 1 §6 requires that adding an adapter never changes the score schema. This
 * interface is how that holds: adapters produce normalized events and declare
 * what they can observe, and nothing downstream needs source-specific knowledge.
 */

export interface DiscoveredProject {
  /** Opaque grouping key from the source's own storage. */
  key: string;
  /**
   * Absolute path the source reports. May be a repo root or a subdirectory of
   * one — `project_id` resolution normalizes that, this does not.
   */
  path?: string;
  /**
   * Stable identity. Resolved from the git repository root where one exists, so
   * the same project seen through two different tools becomes one project.
   */
  project_id: string;
  session_refs: SessionRef[];
  bytes: number;
}

/** Enough to locate one session without holding it in memory. */
export interface SessionRef {
  source: AgentSource;
  /** File path, database key, or whatever the source needs to find it again. */
  locator: string;
  bytes: number;
}

export interface ParsedSession {
  session: SessionRecord;
  events: LocalEvent[];
  stats: ParseStats;
}

export interface ParseStats {
  records: number;
  parsed: number;
  skipped: number;
  malformed: number;
  bytes: number;
}

export interface SourceAdapter {
  readonly source: AgentSource;

  /**
   * Signals this source actually records.
   *
   * Declare conservatively. Claiming a signal the source does not reliably
   * record is worse than omitting it: an over-claimed signal reads as a real
   * zero and quietly penalizes every user of that tool, whereas an omitted one
   * costs only certainty.
   */
  readonly capabilities: ReadonlySet<Signal>;

  /**
   * True when the source is verified against real data from a running install.
   *
   * An adapter written from documentation alone is a hypothesis. Every adapter
   * in this repo written against real data has needed correction, so unverified
   * adapters are labelled rather than trusted.
   */
  readonly verified: boolean;

  /** Is this tool installed on the machine? */
  detect(): Promise<boolean>;

  discover(): Promise<DiscoveredProject[]>;

  parseSession(ref: SessionRef, project: DiscoveredProject): Promise<ParsedSession | undefined>;
}

export function newParseStats(): ParseStats {
  return { records: 0, parsed: 0, skipped: 0, malformed: 0, bytes: 0 };
}
