import { stat } from "node:fs/promises";
import type { AgentSource } from "@builder/types";
import {
  newParseStats,
  type DiscoveredProject,
  type ParsedSession,
  type SessionRef,
  type SourceAdapter,
} from "@builder/agent-core";
import { CLAUDE_CAPABILITIES } from "./capabilities.ts";
import { hashId } from "./hash.ts";
import { discoverProjects, parseSessionFile, PROJECTS_DIR } from "./session.ts";

/**
 * Wraps the Claude Code reader in the common adapter contract.
 *
 * The reader predates the interface — it was written first, against real data,
 * and the interface was extracted from what it turned out to need. This is a
 * thin shim rather than a rewrite: the parsing logic has been validated against
 * 1.8 GB of real transcripts and is not worth disturbing to satisfy a shape.
 */
export class ClaudeAdapter implements SourceAdapter {
  readonly source: AgentSource = "claude_code";
  readonly capabilities = CLAUDE_CAPABILITIES;
  readonly verified = true;

  constructor(private readonly projectsDir: string = PROJECTS_DIR) {}

  async detect(): Promise<boolean> {
    try {
      return (await stat(this.projectsDir)).isDirectory();
    } catch {
      return false;
    }
  }

  async discover(): Promise<DiscoveredProject[]> {
    const projects = await discoverProjects(this.projectsDir);
    return projects.map((p) => ({
      key: p.dir,
      ...(p.cwd !== undefined && { path: p.cwd }),
      project_id: p.project_id,
      session_refs: p.session_files.map((f): SessionRef => ({
        source: "claude_code",
        locator: f,
        // Per-file size is known only after stat; the project total is what
        // discovery needs for ordering, so this stays cheap.
        bytes: Math.round(p.bytes / Math.max(1, p.session_files.length)),
      })),
      bytes: p.bytes,
    }));
  }

  async parseSession(
    ref: SessionRef,
    project: DiscoveredProject,
  ): Promise<ParsedSession | undefined> {
    const parsed = await parseSessionFile(ref.locator, {
      project_id: project.project_id,
      ...(project.path !== undefined && { cwd: project.path }),
    });
    if (!parsed) return undefined;
    return {
      session: parsed.session,
      events: parsed.events,
      stats: {
        ...newParseStats(),
        records: parsed.stats.lines,
        parsed: parsed.stats.parsed,
        skipped: parsed.stats.skipped,
        malformed: parsed.stats.malformed,
        bytes: parsed.stats.bytes,
      },
    };
  }
}

export { hashId };
