import type { CommitRef, GitMetrics } from "@builder/types";
import type { LocalCommitDetail } from "./log.ts";

/**
 * Aggregate git metrics (Doc 2 §8) plus the churn signals Doc 2 §6 lists under
 * Quality. Everything here reduces local detail to numbers; no path or subject
 * survives into the output.
 */

/** Doc 2 §6 — active days, counted in the local timezone since work is human-scheduled. */
export function activeDays(timestamps: number[]): number {
  const days = new Set<string>();
  for (const t of timestamps) {
    const d = new Date(t);
    days.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
  }
  return days.size;
}

/**
 * Rework: work undone shortly after it was done.
 *
 * True line-level churn needs blame across every revision, far too expensive to
 * run on a developer's machine, so this is a proxy. Getting the proxy right
 * matters more than it first appears.
 *
 * The obvious version — "lines in files touched more than once in the window" —
 * is wrong. Measured against a real repo (403 commits over 43 days) it returned
 * 62%, because at nine commits a day nearly every file is touched twice within
 * 48 hours. That metric mostly tracks commit *cadence*, and Doc 3 §11 is
 * explicit that commit volume must not read as quality.
 *
 * So this counts only lines REMOVED from a file that was already touched earlier
 * inside the window. Deleting code you recently wrote is much closer to actual
 * rework than merely returning to a file. It is directional (earlier touch, not
 * any touch) so ordinary forward progress across many commits does not inflate
 * it, and it still overcounts deliberate refactors — acceptable, because it
 * feeds Engineering Quality as one signal among several rather than a verdict.
 */
export const REWORK_WINDOW_MS = 48 * 60 * 60 * 1000;

export function reworkRatio(
  details: LocalCommitDetail[],
  windowMs: number = REWORK_WINDOW_MS,
): number {
  const ordered = [...details].sort((a, b) => a.commit.timestamp - b.commit.timestamp);
  const lastTouch = new Map<string, number>();

  let reworked = 0;
  let total = 0;

  for (const d of ordered) {
    const now = d.commit.timestamp;
    for (const f of d.files) {
      total += f.added + f.removed;
      const prev = lastTouch.get(f.path);
      if (prev !== undefined && now - prev <= windowMs) {
        reworked += f.removed;
      }
      lastTouch.set(f.path, now);
    }
  }

  return total === 0 ? 0 : reworked / total;
}

export function revertCount(details: LocalCommitDetail[]): number {
  return details.filter((d) => d.is_revert).length;
}

/**
 * Doc 2 §6 Quality — test-file ratio from paths alone.
 *
 * This needs no toolchain, which is why it is available even when the deep
 * analysis pass has not run. It measures whether tests move alongside source,
 * which is a better signal of engineering habit than test *count*: a repo with
 * 400 stale tests nobody touches scores worse here than one whose tests change
 * with the code, and that ordering is the correct one.
 */
/**
 * Re-exported, not redefined.
 *
 * This was the original home and the copy the Claude adapter was written from.
 * Two copies plus Cursor's looser substring test meant the same file could be
 * a test file to one source and not to another. It lives in @builder/types now,
 * which is the only package every adapter shares.
 */
import { isTestPath } from "@builder/types";
export { isTestPath };

export function testFileRatio(details: LocalCommitDetail[]): number {
  let test = 0;
  let total = 0;
  for (const d of details) {
    for (const f of d.files) {
      total++;
      if (isTestPath(f.path)) test++;
    }
  }
  return total === 0 ? 0 : test / total;
}

export interface AggregateOptions {
  repoCount: number;
}

export function aggregateGitMetrics(
  commits: CommitRef[],
  options: AggregateOptions,
): Omit<GitMetrics, "repo_count"> & { repo_count: number } {
  const nonMerge = commits.filter((c) => !c.is_merge);
  const corroborated = nonMerge.filter((c) => c.session_corroborated).length;

  return {
    commit_count: nonMerge.length,
    active_days: activeDays(nonMerge.map((c) => c.timestamp)),
    files_changed: nonMerge.reduce((a, c) => a + c.files_changed, 0),
    lines_added: nonMerge.reduce((a, c) => a + c.lines_added, 0),
    lines_removed: nonMerge.reduce((a, c) => a + c.lines_removed, 0),
    repo_count: options.repoCount,
    session_corroborated_commit_rate: nonMerge.length === 0 ? 0 : corroborated / nonMerge.length,
  };
}
