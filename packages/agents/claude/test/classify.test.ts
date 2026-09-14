import { describe, expect, test } from "bun:test";
import {
  classifyCommand,
  classifyToolCall,
  isInterruptMarker,
  looksLikeCorrection,
} from "../src/classify.ts";

describe("classifyCommand", () => {
  test.each([
    ["pytest -q", "test"],
    ["npm test", "test"],
    ["bun test packages/types", "test"],
    ["cargo test --all", "test"],
    ["go test ./...", "test"],
    ["cd /tmp && vitest run", "test"],
    ["git commit -m 'x'", "git_commit"],
    ["git checkout -b feat", "git_checkout"],
    ["git switch main", "git_checkout"],
    ["git branch -d old", "git_branch"],
    ["vercel deploy --prod", "deploy"],
    ["wrangler pages deploy out", "deploy"],
    ["kubectl apply -f k8s/", "deploy"],
    ["npm run build", "build"],
    ["pnpm install", "package_manager"],
    ["ls -la", "inspect"],
  ])("classifies %p as %s", (cmd, family) => {
    expect(classifyCommand(cmd)).toBe(family as never);
  });

  test("npm test is a test, not a package-manager call", () => {
    // Ordering bug bait: the package-manager rule also matches `npm ...`.
    expect(classifyCommand("npm test")).toBe("test");
  });

  test("does not treat `latest` as a test runner", () => {
    expect(classifyCommand("npm i react@latest")).toBe("package_manager");
  });

  test("does not treat `digest` or `protest` as tests", () => {
    expect(classifyCommand("echo protest")).toBe("other");
  });
});

describe("classifyToolCall", () => {
  test.each([
    ["Read", undefined, "file_read"],
    ["Grep", undefined, "file_read"],
    ["Write", undefined, "file_write"],
    ["Edit", undefined, "file_edit"],
    ["Agent", undefined, "agent_spawn"],
    ["Bash", "test", "test_run"],
    ["Bash", "git_commit", "git_commit"],
    ["Bash", "deploy", "deployment"],
    ["Bash", "other", "terminal_command"],
    ["WebSearch", undefined, "tool_call"],
  ])("maps %s/%s to %s", (tool, family, expected) => {
    expect(classifyToolCall(tool, family as never)).toBe(expected as never);
  });
});

describe("interrupts and corrections", () => {
  test("detects Claude Code's interrupt sentinels", () => {
    expect(isInterruptMarker("[Request interrupted by user]")).toBe(true);
    expect(isInterruptMarker("[Request interrupted by user for tool use]")).toBe(true);
    expect(isInterruptMarker("please continue")).toBe(false);
  });

  test("anything following a failure or interrupt counts as a correction", () => {
    expect(looksLikeCorrection("now add the index", true)).toBe(true);
  });

  test("recognises corrective openers on short messages", () => {
    expect(looksLikeCorrection("No, use the existing helper.", false)).toBe(true);
    expect(looksLikeCorrection("Actually, revert that.", false)).toBe(true);
    expect(looksLikeCorrection("stop", false)).toBe(true);
  });

  test("does not treat ordinary instructions as corrections", () => {
    expect(looksLikeCorrection("Add a test for the parser.", false)).toBe(false);
  });

  test("does not lexically match a long message that merely opens with 'no'", () => {
    // Long messages are structural-only: phrasing is too weak a signal at length.
    expect(looksLikeCorrection(`No, ${"detail ".repeat(60)}`, false)).toBe(false);
  });
});

describe("inspect", () => {
  /**
   * This family exists because read:edit ratio is otherwise a measure of TOOL
   * CHOICE rather than of care. Somebody reading with the Read tool looks
   * research-first; somebody reading the same files with `cat` and `sed -n`
   * looked edit-first, because every one of those landed in `other`. On a real
   * corpus that was 24,554 commands and it dragged the ratio from 7.68 to 0.80.
   */
  test.each([
    "cat package.json",
    "sed -n '1,40p' src/index.ts",
    "grep -rn foo src",
    "rg --files-with-matches TODO",
    "git log --oneline -5",
    "git diff HEAD~1",
    "git status",
    "ls -la",
    "find . -name '*.ts'",
    "wc -l src/*.ts",
    "cat a.txt | grep b",
    "ls 2>/dev/null",
  ])("reads the codebase: %s", (cmd) => {
    expect(classifyCommand(cmd)).toBe("inspect");
  });

  /**
   * Output redirection means the command WRITES, whatever it starts with.
   * `cat > file <<EOF` is how a file gets created from a shell, and reading it
   * as "looking around" would count writing as care — inverting the signal.
   */
  test.each([
    "cat > file.ts <<EOF",
    "cat >> log.txt",
    "grep foo src > out.txt",
    "python3 - <<PY",
    "sed -n '1,5p' a.txt > b.txt",
  ])("a redirect is never inspect: %s", (cmd) => {
    expect(classifyCommand(cmd)).not.toBe("inspect");
  });

  test("more specific families still win", () => {
    // `git commit` and `npm test` must keep their own families even though
    // they would otherwise be caught by the inspect rules.
    expect(classifyCommand("git commit -m x")).toBe("git_commit");
    expect(classifyCommand("npm test")).toBe("test");
    expect(classifyCommand("git checkout main")).toBe("git_checkout");
  });
});
