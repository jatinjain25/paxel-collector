import { describe, expect, test } from "bun:test";
import {
  activeDays,
  hashAuthor,
  isTestPath,
  markCorroboration,
  parseLog,
  parseLogDetailed,
  reworkRatio,
  testFileRatio,
} from "../src/index.ts";

const RS = "\x1e";
const US = "\x1f";

function entry(
  sha: string,
  date: string,
  email: string,
  parents: string,
  subject: string,
  numstat: string[],
): string {
  return `${RS}${sha}${US}${date}${US}${email}${US}${parents}${US}${subject}\n${numstat.join("\n")}\n`;
}

const SAMPLE =
  entry("abc123", "2026-09-01T10:00:00Z", "Dev@Example.com ", "p1", "add retry helper", [
    "12\t3\tsrc/retry.ts",
    "40\t0\tsrc/retry.test.ts",
  ]) +
  entry("def456", "2026-09-01T14:00:00Z", "dev@example.com", "p1 p2", "Merge branch 'x'", []) +
  entry("ghi789", "2026-09-03T09:00:00Z", "other@example.com", "p3", "Revert \"add retry helper\"", [
    "0\t12\tsrc/retry.ts",
    "-\t-\tassets/logo.png",
  ]);

describe("parseLog", () => {
  const commits = parseLog(SAMPLE);

  test("parses every commit", () => {
    expect(commits).toHaveLength(3);
    expect(commits.map((c) => c.sha)).toEqual(["abc123", "def456", "ghi789"]);
  });

  test("sums numstat line counts", () => {
    expect(commits[0]!.lines_added).toBe(52);
    expect(commits[0]!.lines_removed).toBe(3);
    expect(commits[0]!.files_changed).toBe(2);
  });

  test("detects merges from the parent list", () => {
    expect(commits[0]!.is_merge).toBe(false);
    expect(commits[1]!.is_merge).toBe(true);
  });

  test("treats binary files as zero lines but still a changed file", () => {
    expect(commits[2]!.files_changed).toBe(2);
    expect(commits[2]!.lines_removed).toBe(12);
  });

  test("keeps subject length, never the subject", () => {
    expect(commits[0]!.subject_length).toBe("add retry helper".length);
    const serialized = JSON.stringify(commits);
    expect(serialized).not.toContain("retry helper");
    expect(serialized).not.toContain("Merge branch");
  });

  test("never carries an email or a file path", () => {
    const serialized = JSON.stringify(commits);
    expect(serialized).not.toContain("example.com");
    expect(serialized).not.toContain("src/retry.ts");
  });

  test("handles a subject containing tabs and quotes", () => {
    const weird = entry("z1", "2026-09-01T10:00:00Z", "a@b.c", "p", 'fix "a\tb" case', ["1\t1\tx.ts"]);
    const [c] = parseLog(weird);
    expect(c?.sha).toBe("z1");
    expect(c?.lines_added).toBe(1);
  });

  test("ignores malformed chunks rather than throwing", () => {
    expect(parseLog(`${RS}garbage-with-no-separators\n`)).toHaveLength(0);
    expect(parseLog("")).toHaveLength(0);
  });
});

describe("hashAuthor", () => {
  test("is stable and case/whitespace insensitive", () => {
    expect(hashAuthor("Dev@Example.com ")).toBe(hashAuthor("dev@example.com"));
  });

  test("distinguishes different authors", () => {
    expect(hashAuthor("a@b.c")).not.toBe(hashAuthor("d@e.f"));
  });

  test("does not contain the address", () => {
    expect(hashAuthor("secret@corp.com")).not.toContain("secret");
  });
});

describe("markCorroboration (Doc 3 §11)", () => {
  const commits = parseLog(SAMPLE);

  test("commits inside an observed session are corroborated", () => {
    const sessions = [{ started_at: Date.parse("2026-09-01T09:00:00Z"), ended_at: Date.parse("2026-09-01T11:00:00Z") }];
    const marked = markCorroboration(commits, sessions);
    expect(marked[0]!.session_corroborated).toBe(true);
    expect(marked[2]!.session_corroborated).toBe(false);
  });

  test("commits shortly after a session still count", () => {
    const sessions = [{ started_at: Date.parse("2026-09-01T09:00:00Z"), ended_at: Date.parse("2026-09-01T09:45:00Z") }];
    // Commit at 10:00 is 15 min after the session ends, inside the trailing window.
    expect(markCorroboration(commits, sessions)[0]!.session_corroborated).toBe(true);
  });

  test("with no sessions, nothing is corroborated", () => {
    // This is the case that matters: a repo of imported commits and no local
    // evidence must not read as the uploader's own work.
    expect(markCorroboration(commits, []).every((c) => !c.session_corroborated)).toBe(true);
  });

  test("handles overlapping sessions", () => {
    const sessions = [
      { started_at: Date.parse("2026-09-01T08:00:00Z"), ended_at: Date.parse("2026-09-01T12:00:00Z") },
      { started_at: Date.parse("2026-09-01T09:30:00Z"), ended_at: Date.parse("2026-09-01T09:40:00Z") },
    ];
    expect(markCorroboration(commits, sessions)[0]!.session_corroborated).toBe(true);
  });
});

describe("churn and quality proxies", () => {
  const details = parseLogDetailed(SAMPLE);

  test("counts distinct active days", () => {
    expect(activeDays(details.map((d) => d.commit.timestamp))).toBe(2);
  });

  test("counts lines removed from a recently touched file", () => {
    // src/retry.ts gains 12 lines on Sep 1, then loses 12 on Sep 3 (47h later).
    // A 48h window sees the removal as rework; a 1h window does not.
    expect(reworkRatio(details, 48 * 3600_000)).toBeGreaterThan(0);
    expect(reworkRatio(details, 1 * 3600_000)).toBe(0);
  });

  test("does not count merely revisiting a file — only undoing it", () => {
    // Two commits, same file, both purely additive. Cadence is high, rework is
    // zero. The naive "touched twice" proxy would have called this 100%.
    const additive = parseLogDetailed(
      entry("a", "2026-09-01T10:00:00Z", "a@b.c", "p", "x", ["10\t0\tsrc/a.ts"]) +
        entry("b", "2026-09-01T11:00:00Z", "a@b.c", "p", "y", ["10\t0\tsrc/a.ts"]),
    );
    expect(reworkRatio(additive)).toBe(0);
  });

  test("is directional — removals before any prior touch do not count", () => {
    const removeFirst = parseLogDetailed(
      entry("a", "2026-09-01T10:00:00Z", "a@b.c", "p", "x", ["0\t10\tsrc/a.ts"]),
    );
    expect(reworkRatio(removeFirst)).toBe(0);
  });

  test("rework is zero when every file is touched once", () => {
    const single = parseLogDetailed(
      entry("a", "2026-09-01T10:00:00Z", "a@b.c", "p", "x", ["5\t0\ta.ts", "5\t0\tb.ts"]),
    );
    expect(reworkRatio(single)).toBe(0);
  });

  test.each([
    ["src/retry.test.ts", true],
    ["tests/thing.py", true],
    ["spec/models_spec.rb", true],
    ["pkg/thing_test.go", true],
    ["tests/unit/deep/x.ts", true],
    ["src/latest.ts", false],
    ["src/contest.ts", false],
  ])("isTestPath(%p) === %p", (p, expected) => {
    expect(isTestPath(p)).toBe(expected);
  });

  test("computes the test-file ratio across commits", () => {
    // 4 file entries total, 1 is a test file.
    expect(testFileRatio(details)).toBeCloseTo(0.25, 5);
  });
});
