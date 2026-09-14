import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LocalEvent, SessionRecord } from "@builder/types";
import { newAdapterState, recordToEvents, type EmitContext } from "./adapter.ts";
import { hashId } from "./hash.ts";
import { newStats, readJsonl, type JsonlStats } from "./jsonl.ts";

export const CLAUDE_DIR = join(homedir(), ".claude");
export const PROJECTS_DIR = join(CLAUDE_DIR, "projects");

export interface DiscoveredProject {
  /** Opaque directory name. NOT a reversible encoding of the path. */
  dir: string;
  /** Authoritative cwd, read from the first record of the first session. */
  cwd?: string;
  project_id: string;
  session_files: string[];
  bytes: number;
}

/**
 * Doc 2 §3 — discovery must report project name, path, agent count and session
 * count before any processing happens.
 *
 * The directory name looks like a path but is a lossy [^A-Za-z0-9]->'-' mapping:
 * `/Users/jj/paxel2.0` and `/Users/jj/paxel_2-0` both encode to
 * `-Users-jj-paxel2-0`. It is used only as a grouping key; the real path comes
 * from the `cwd` field every record carries.
 */
export async function discoverProjects(
  projectsDir: string = PROJECTS_DIR,
): Promise<DiscoveredProject[]> {
  let dirs: string[];
  try {
    dirs = (await readdir(projectsDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }

  const out: DiscoveredProject[] = [];
  for (const dir of dirs) {
    const full = join(projectsDir, dir);
    let entries: string[];
    try {
      entries = await readdir(full);
    } catch {
      continue;
    }
    const files = entries.filter((f) => f.endsWith(".jsonl")).map((f) => join(full, f));
    if (files.length === 0) continue;

    let bytes = 0;
    for (const f of files) {
      try {
        bytes += (await stat(f)).size;
      } catch {
        // A session file can vanish between readdir and stat; skip it.
      }
    }

    const cwd = await peekCwd(files);
    out.push({
      dir,
      ...(cwd !== undefined && { cwd }),
      project_id: hashId(cwd ?? dir),
      session_files: files,
      bytes,
    });
  }
  return out.sort((a, b) => b.bytes - a.bytes);
}

/** Read just enough of a session to recover the authoritative cwd. */
async function peekCwd(files: string[]): Promise<string | undefined> {
  for (const file of files) {
    const stats = newStats();
    for await (const rec of readJsonl(file, stats)) {
      const cwd = rec.cwd;
      if (typeof cwd === "string" && cwd.length > 0) return cwd;
      if (stats.parsed > 20) break;
    }
  }
  return undefined;
}

export interface ParsedSession {
  session: SessionRecord;
  events: LocalEvent[];
  stats: JsonlStats;
}

/** Parse one session file into a session record plus its normalized events. */
export async function parseSessionFile(
  file: string,
  project: Pick<DiscoveredProject, "project_id" | "cwd">,
): Promise<ParsedSession | undefined> {
  const stats = newStats();
  const state = newAdapterState();
  const events: LocalEvent[] = [];

  let sessionId: string | undefined;
  let branch: string | undefined;
  let model: string | undefined;
  // Hashes record identity incrementally so the whole file need not be buffered
  // to produce Doc 2 §8's `session_id + content hash` idempotency key.
  const hasher = createHash("sha256");

  for await (const rec of readJsonl(file, stats)) {
    sessionId ??= typeof rec.sessionId === "string" ? rec.sessionId : undefined;
    if (branch === undefined && typeof rec.gitBranch === "string" && rec.gitBranch.length > 0) {
      branch = rec.gitBranch;
    }
    if (typeof rec.uuid === "string") hasher.update(rec.uuid);

    const ctx: EmitContext = {
      session_id: sessionId ?? file,
      project_id: project.project_id,
      cwd: project.cwd ?? "",
    };
    for (const e of recordToEvents(rec, ctx, state)) {
      if (model === undefined && e.metadata.model) model = e.metadata.model;
      events.push(e);
    }
  }

  if (events.length === 0) return undefined;

  const timestamps = events.map((e) => e.timestamp);
  const started_at = Math.min(...timestamps);
  const ended_at = Math.max(...timestamps);

  const session: SessionRecord = {
    session_id: sessionId ?? hashId(file),
    source: "claude_code",
    project_id: project.project_id,
    started_at,
    ended_at,
    active_ms: activeMs(timestamps),
    event_count: events.length,
    prompt_count: events.filter(
      (e) => e.event_type === "user_instruction" || e.event_type === "course_correction",
    ).length,
    content_hash: hasher.digest("hex").slice(0, 32),
    source_ref: {
      source: "claude_code",
      source_hash: hashId(file),
      content_hash: "",
      bytes: stats.bytes,
    },
    ...(model !== undefined && { model }),
    ...(branch !== undefined && { branch_hash: hashId(branch) }),
  };
  session.source_ref.content_hash = session.content_hash;

  return { session, events, stats };
}

/**
 * Wall-clock minus idle gaps.
 *
 * A session left open overnight is not eight hours of work, and counting it as
 * such would make "leverage" a measure of forgetting to close a terminal.
 */
export const IDLE_GAP_MS = 15 * 60 * 1000;

export function activeMs(timestamps: number[], idleGapMs: number = IDLE_GAP_MS): number {
  if (timestamps.length < 2) return 0;
  const sorted = [...timestamps].sort((a, b) => a - b);
  let total = 0;
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i]! - sorted[i - 1]!;
    if (gap <= idleGapMs) total += gap;
  }
  return total;
}
