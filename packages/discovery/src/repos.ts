import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Find git repositories on the machine.
 *
 * Doc 2 §3 requires discovery to report what will be analyzed before anything
 * is processed. Session-linked projects are only part of that: a developer's git
 * activity in repos where they did not use an agent is still evidence, and Doc 3
 * §11 already down-weights commits that no session corroborates, so including
 * them cannot inflate a score.
 */

/** Directories never worth descending into. */
const SKIP = new Set([
  "node_modules", ".git", "Library", "Applications", ".Trash", ".cache", ".npm",
  ".bun", ".cargo", ".rustup", "vendor", "dist", "build", "target", ".next",
  "venv", ".venv", "__pycache__", "Pictures", "Music", "Movies",
]);

export interface RepoScanOptions {
  roots?: string[];
  /** Depth 4 found 39 repos on a real machine; deeper mostly finds vendored copies. */
  maxDepth?: number;
  /** Stop early rather than walking a whole disk. */
  limit?: number;
}

export async function findRepos(options: RepoScanOptions = {}): Promise<string[]> {
  const roots = options.roots ?? [homedir()];
  const maxDepth = options.maxDepth ?? 4;
  const limit = options.limit ?? 500;
  const found: string[] = [];
  const seen = new Set<string>();

  async function walk(dir: string, depth: number): Promise<void> {
    if (found.length >= limit || depth > maxDepth) return;
    const real = resolve(dir);
    if (seen.has(real)) return;
    seen.add(real);

    let entries: { name: string; isDirectory(): boolean; isSymbolicLink(): boolean }[];
    try {
      entries = await readdir(real, { withFileTypes: true });
    } catch {
      return;
    }

    if (entries.some((e) => e.name === ".git")) {
      found.push(real);
      // A repository's subdirectories are its own content, not more projects.
      // Submodules are missed by this; that is the right trade for not walking
      // every vendored dependency on the machine.
      return;
    }

    for (const e of entries) {
      // Symlinks can point anywhere, including back up the tree.
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      if (e.name.startsWith(".") && e.name !== ".config") continue;
      if (SKIP.has(e.name)) continue;
      await walk(join(real, e.name), depth + 1);
    }
  }

  for (const root of roots) {
    try {
      if ((await stat(root)).isDirectory()) await walk(root, 0);
    } catch {
      continue;
    }
  }
  return found.sort();
}
