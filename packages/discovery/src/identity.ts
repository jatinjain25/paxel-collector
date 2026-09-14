import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/**
 * Resolve a path to the identity of the project containing it.
 *
 * This is what makes multi-source evidence merge. Claude Code reports a working
 * directory, Cursor reports a workspace folder URI, and the same repository
 * legitimately appears as its root from one tool and a subdirectory from
 * another. Hashing the reported path directly turns one project into several,
 * and then episodes never span tools: a builder who used Cursor and Claude Code
 * on the same work gets two fragmented halves and a depressed completion rate.
 *
 * Observed on a real machine before this existed: `/Users/dev/starter`,
 * `/Users/dev/starter-1` and
 * `/Users/dev/starter/nested/starter` were three separate
 * projects.
 *
 * Walking up for `.git` rather than shelling out to `git rev-parse` keeps this
 * cheap enough to call per session, and avoids launching a process for a
 * question the filesystem already answers.
 */

const rootCache = new Map<string, string | undefined>();

export async function findRepoRoot(startPath: string): Promise<string | undefined> {
  const start = resolve(startPath);
  const cached = rootCache.get(start);
  if (cached !== undefined || rootCache.has(start)) return cached;

  const visited: string[] = [];
  let dir = start;
  for (;;) {
    visited.push(dir);
    const hit = rootCache.get(dir);
    if (hit !== undefined || rootCache.has(dir)) {
      for (const v of visited) rootCache.set(v, hit);
      return hit;
    }
    try {
      await stat(join(dir, ".git"));
      for (const v of visited) rootCache.set(v, dir);
      return dir;
    } catch {
      // keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const v of visited) rootCache.set(v, undefined);
  return undefined;
}

/**
 * Stable project identity.
 *
 * Falls back to the reported path when there is no repository, so agent work in
 * a scratch directory still groups consistently — it simply will not merge with
 * anything else, which is correct.
 */
export async function resolveProjectId(path: string | undefined): Promise<string> {
  if (!path) return hash("unknown");
  const root = await findRepoRoot(path);
  return hash(root ?? resolve(path));
}

export function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

/** Test seam. */
export function clearRepoRootCache(): void {
  rootCache.clear();
}
