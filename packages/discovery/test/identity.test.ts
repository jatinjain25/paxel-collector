import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearRepoRootCache, findRepoRoot, hash, resolveProjectId } from "../src/index.ts";
import { findRepos } from "../src/repos.ts";

const root = await mkdtemp(join(tmpdir(), "builder-identity-"));
await mkdir(join(root, "repo-a", "src", "deep"), { recursive: true });
await mkdir(join(root, "repo-a", ".git"), { recursive: true });
await mkdir(join(root, "repo-b", ".git"), { recursive: true });
await mkdir(join(root, "not-a-repo", "src"), { recursive: true });
// A nested repository is its own project, not part of its parent.
await mkdir(join(root, "repo-a", "vendored", ".git"), { recursive: true });
await writeFile(join(root, "repo-a", "src", "x.ts"), "");

describe("findRepoRoot", () => {
  test("finds the root from a deep subdirectory", async () => {
    clearRepoRootCache();
    expect(await findRepoRoot(join(root, "repo-a", "src", "deep"))).toBe(join(root, "repo-a"));
  });

  test("returns undefined outside any repository", async () => {
    clearRepoRootCache();
    expect(await findRepoRoot(join(root, "not-a-repo", "src"))).toBeUndefined();
  });

  test("a nested repository resolves to itself, not its parent", async () => {
    clearRepoRootCache();
    expect(await findRepoRoot(join(root, "repo-a", "vendored"))).toBe(
      join(root, "repo-a", "vendored"),
    );
  });
});

describe("resolveProjectId", () => {
  test("a subdirectory and its root are the same project", async () => {
    clearRepoRootCache();
    // This is the whole point: Claude Code reports a cwd and Cursor reports a
    // workspace folder, and the same repo arrives at different depths. Hashing
    // the reported path directly fragments one project into several, and then
    // episodes never merge across tools.
    const a = await resolveProjectId(join(root, "repo-a"));
    const b = await resolveProjectId(join(root, "repo-a", "src", "deep"));
    expect(a).toBe(b);
  });

  test("different repositories are different projects", async () => {
    clearRepoRootCache();
    expect(await resolveProjectId(join(root, "repo-a"))).not.toBe(
      await resolveProjectId(join(root, "repo-b")),
    );
  });

  test("paths outside a repository still group consistently", async () => {
    clearRepoRootCache();
    const p = join(root, "not-a-repo", "src");
    expect(await resolveProjectId(p)).toBe(await resolveProjectId(p));
  });

  test("an unknown path is stable", async () => {
    expect(await resolveProjectId(undefined)).toBe(hash("unknown"));
  });
});

describe("findRepos", () => {
  test("finds repositories under a root", async () => {
    const found = await findRepos({ roots: [root], maxDepth: 3 });
    expect(found).toContain(join(root, "repo-a"));
    expect(found).toContain(join(root, "repo-b"));
  });

  test("does not descend into a repository it already found", async () => {
    // Otherwise every vendored dependency with a .git becomes a project.
    const found = await findRepos({ roots: [root], maxDepth: 5 });
    expect(found).not.toContain(join(root, "repo-a", "vendored"));
  });

  test("excludes directories with no repository", async () => {
    const found = await findRepos({ roots: [root], maxDepth: 3 });
    expect(found).not.toContain(join(root, "not-a-repo"));
  });

  test("respects the limit", async () => {
    expect((await findRepos({ roots: [root], maxDepth: 3, limit: 1 })).length).toBe(1);
  });
});
