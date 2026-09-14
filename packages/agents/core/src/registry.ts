import type { AgentSource, Signal } from "@builder/types";
import type { DiscoveredProject, ParsedSession, SourceAdapter } from "./adapter.ts";

/**
 * Runs every installed adapter and merges their output.
 *
 * Merging is where multi-source correctness is won or lost. Two adapters
 * reporting the same repository must produce one project, or episodes never
 * span tools and a builder who used Cursor and Claude Code on the same work
 * gets two fragmented halves and a depressed completion rate.
 */

export interface CollectionResult {
  projects: MergedProject[];
  /** Sources found installed, in discovery order. */
  detected: AgentSource[];
  /** Union of what the detected sources can observe. */
  observed_signals: Signal[];
  /** Per-source capability detail, for explaining a score. */
  capabilities: { source: AgentSource; signals: Signal[]; verified: boolean }[];
}

export interface MergedProject {
  project_id: string;
  path?: string;
  /** Every source that has evidence for this project. */
  sources: AgentSource[];
  contributions: DiscoveredProject[];
  bytes: number;
}

export async function detectAll(adapters: SourceAdapter[]): Promise<SourceAdapter[]> {
  const found: SourceAdapter[] = [];
  for (const a of adapters) {
    // One broken adapter must not prevent every other source being read.
    try {
      if (await a.detect()) found.push(a);
    } catch {
      continue;
    }
  }
  return found;
}

export async function collect(adapters: SourceAdapter[]): Promise<CollectionResult> {
  const detected = await detectAll(adapters);

  const byProject = new Map<string, MergedProject>();
  for (const adapter of detected) {
    let discovered: DiscoveredProject[] = [];
    try {
      discovered = await adapter.discover();
    } catch {
      continue;
    }
    for (const p of discovered) {
      const existing = byProject.get(p.project_id);
      if (existing) {
        existing.contributions.push(p);
        existing.bytes += p.bytes;
        if (!existing.sources.includes(adapter.source)) existing.sources.push(adapter.source);
        // Prefer a path we already resolved; sources disagree about depth.
        if (existing.path === undefined && p.path !== undefined) existing.path = p.path;
      } else {
        byProject.set(p.project_id, {
          project_id: p.project_id,
          ...(p.path !== undefined && { path: p.path }),
          sources: [adapter.source],
          contributions: [p],
          bytes: p.bytes,
        });
      }
    }
  }

  const signals = new Set<Signal>();
  for (const a of detected) for (const s of a.capabilities) signals.add(s);

  return {
    projects: [...byProject.values()].sort((a, b) => b.bytes - a.bytes),
    detected: detected.map((a) => a.source),
    observed_signals: [...signals].sort(),
    capabilities: detected.map((a) => ({
      source: a.source,
      signals: [...a.capabilities].sort(),
      verified: a.verified,
    })),
  };
}

/** Parse every session of a merged project, across all contributing sources. */
export async function parseProject(
  project: MergedProject,
  adapters: SourceAdapter[],
): Promise<ParsedSession[]> {
  const bySource = new Map(adapters.map((a) => [a.source, a]));
  const out: ParsedSession[] = [];

  for (const contribution of project.contributions) {
    for (const ref of contribution.session_refs) {
      const adapter = bySource.get(ref.source);
      if (!adapter) continue;
      try {
        const parsed = await adapter.parseSession(ref, contribution);
        if (parsed) out.push(parsed);
      } catch {
        // A single unreadable session should not lose the rest of the project.
        continue;
      }
    }
  }
  return out;
}
