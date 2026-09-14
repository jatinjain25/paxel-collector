import type { AgentSource, LocalEvent, SessionRecord, Signal } from "@builder/types";
import { toWire } from "@builder/types";
import type { SourceAdapter } from "@builder/agent-core";
import { CLAUDE_CAPABILITIES, ClaudeAdapter } from "@builder/agent-claude";
import { CursorAdapter } from "@builder/agent-cursor";
import { CodexAdapter } from "@builder/agent-codex";
import { OpencodeAdapter } from "@builder/agent-opencode";
import { isRepo, markCorroboration, readCommitsDetailed, reworkRatio, revertCount, testFileRatio } from "@builder/git";
import type { CommitRef, WireEvent } from "@builder/types";
import { resolveProjectId } from "./identity.ts";
import { findRepos } from "./repos.ts";

/** Every adapter the collector knows about. */
export function allAdapters(): SourceAdapter[] {
  return [new ClaudeAdapter(), new CursorAdapter(), new OpencodeAdapter(), new CodexAdapter()];
}

export interface SourceSummary {
  source: AgentSource;
  sessions: number;
  events: number;
  bytes: number;
  verified: boolean;
  signals: Signal[];
}

export interface CollectionSummary {
  sources: SourceSummary[];
  /** Union of signals the detected sources can observe. */
  observed_signals: Signal[];
  projects: number;
  repos: number;
  sessions: SessionRecord[];
  events: WireEvent[];
  commits: CommitRef[];
  rework_ratio: number;
  revert_count: number;
  test_file_ratio: number;
  duration_ms: number;
}

export interface CollectOptions {
  /** Restrict to these project ids; undefined means everything found. */
  projectIds?: Set<string>;
  scanRepos?: boolean;
  onProgress?: (message: string) => void;
}

/**
 * Run every installed source, resolve identities, and read git.
 *
 * Identity resolution happens here rather than inside adapters, so a single rule
 * governs how paths become projects regardless of which tool reported them.
 */
export async function collectAll(options: CollectOptions = {}): Promise<CollectionSummary> {
  const started = Date.now();
  const progress = options.onProgress ?? (() => {});
  const adapters = allAdapters();

  const sessions: SessionRecord[] = [];
  const events: WireEvent[] = [];
  const summaries: SourceSummary[] = [];
  const signals = new Set<Signal>();
  const projectPaths = new Map<string, string>();

  for (const adapter of adapters) {
    if (!(await adapter.detect())) continue;
    for (const s of adapter.capabilities) signals.add(s);
    progress(`reading ${adapter.source}`);

    let sourceSessions = 0;
    let sourceEvents = 0;
    let sourceBytes = 0;

    let discovered;
    try {
      discovered = await adapter.discover();
    } catch {
      continue;
    }

    for (const project of discovered) {
      // The identity rule lives here, not in the adapter.
      const project_id = await resolveProjectId(project.path);
      if (options.projectIds && !options.projectIds.has(project_id)) continue;
      if (project.path) projectPaths.set(project_id, project.path);

      for (const ref of project.session_refs) {
        let parsed;
        try {
          parsed = await adapter.parseSession(ref, { ...project, project_id });
        } catch {
          continue;
        }
        if (!parsed) continue;

        // Rewrite identity onto the records, since adapters computed their own.
        sessions.push({ ...parsed.session, project_id });
        for (const e of parsed.events) events.push({ ...toWire(e), project_id });
        sourceSessions++;
        sourceEvents += parsed.events.length;
        sourceBytes += parsed.stats.bytes;
      }
    }

    summaries.push({
      source: adapter.source,
      sessions: sourceSessions,
      events: sourceEvents,
      bytes: sourceBytes,
      verified: adapter.verified,
      signals: [...adapter.capabilities].sort(),
    });
  }

  // Git: every repo a source pointed at, plus the whole machine when asked.
  const repoPaths = new Set(projectPaths.values());
  if (options.scanRepos) {
    progress("scanning for repositories");
    for (const r of await findRepos()) repoPaths.add(r);
  }

  const commits: CommitRef[] = [];
  const details: Awaited<ReturnType<typeof readCommitsDetailed>> = [];
  let repos = 0;
  for (const path of repoPaths) {
    if (!(await isRepo(path))) continue;
    repos++;
    try {
      const d = await readCommitsDetailed({ cwd: path });
      details.push(...d);
      commits.push(...markCorroboration(d.map((x) => x.commit), sessions));
    } catch {
      continue;
    }
  }

  return {
    sources: summaries,
    observed_signals: [...signals].sort(),
    projects: new Set(sessions.map((s) => s.project_id)).size,
    repos,
    sessions,
    events,
    commits,
    rework_ratio: reworkRatio(details),
    revert_count: revertCount(details),
    test_file_ratio: testFileRatio(details),
    duration_ms: Date.now() - started,
  };
}

export { CLAUDE_CAPABILITIES };
export type { LocalEvent };
