import { createHash } from "node:crypto";
import type { CommitRef, SessionRecord } from "@builder/types";
import { git } from "./run.ts";

/**
 * Commit history as metadata (Doc 2 §2 — git is *supporting* evidence).
 *
 * Doc 2 §7 forbids uploading diffs or working-tree content, so we read
 * `--numstat` (per-file line counts) and never `-p`. Commit subjects are read
 * only to measure their length; the text itself stays local. Author emails are
 * hashed immediately — they are third-party PII, and Paxel's privacy policy
 * conceding it uploads "names and email addresses of repository contributors"
 * is exactly the exposure worth not having.
 */

/** ASCII record/unit separators: cannot occur in a commit subject. */
const RS = "\x1e";
const US = "\x1f";

/** Doc 2 §8 caps evidence per upload; 1000 commits is ample for a scoring window. */
export const DEFAULT_MAX_COMMITS = 1000;

export function hashAuthor(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 32);
}

export interface ReadCommitsOptions {
  cwd: string;
  maxCommits?: number;
  /** ISO date or git approxidate, e.g. "3 months ago". */
  since?: string;
}

export async function readCommitsDetailed(
  options: ReadCommitsOptions,
): Promise<LocalCommitDetail[]> {
  const args = [
    "log",
    `-n${options.maxCommits ?? DEFAULT_MAX_COMMITS}`,
    "--numstat",
    // %P is the parent list: more than one parent means a merge.
    `--format=${RS}%H${US}%aI${US}%aE${US}%P${US}%s`,
  ];
  if (options.since) args.push(`--since=${options.since}`);

  let stdout: string;
  try {
    stdout = await git(args, { cwd: options.cwd });
  } catch {
    // An empty repo has no HEAD and `git log` exits non-zero. Not an error.
    return [];
  }
  return parseLogDetailed(stdout);
}

export async function readCommits(options: ReadCommitsOptions): Promise<CommitRef[]> {
  return (await readCommitsDetailed(options)).map((d) => d.commit);
}

/**
 * Per-commit detail that stays on the machine.
 *
 * File paths and subjects are needed to compute rework and revert signals, but
 * neither may be uploaded. They live in this local-only type; `CommitRef` is its
 * projection, carrying counts and a subject *length*.
 */
export interface LocalCommitDetail {
  commit: CommitRef;
  files: { path: string; added: number; removed: number }[];
  is_revert: boolean;
}

const REVERT_SUBJECT = /^\s*revert[\s":]/i;

export function parseLogDetailed(stdout: string): LocalCommitDetail[] {
  const out: LocalCommitDetail[] = [];

  for (const chunk of stdout.split(RS)) {
    if (chunk.trim().length === 0) continue;

    const newline = chunk.indexOf("\n");
    const headerLine = newline === -1 ? chunk : chunk.slice(0, newline);
    const body = newline === -1 ? "" : chunk.slice(newline + 1);

    const [sha, authorDate, authorEmail, parents, subject] = headerLine.split(US);
    if (!sha || !authorDate) continue;

    const timestamp = Date.parse(authorDate);
    if (Number.isNaN(timestamp)) continue;

    let lines_added = 0;
    let lines_removed = 0;
    const files: { path: string; added: number; removed: number }[] = [];

    for (const line of body.split("\n")) {
      if (line.length === 0) continue;
      const [addedStr, removedStr, path] = line.split("\t");
      if (addedStr === undefined || removedStr === undefined || path === undefined) continue;
      // Binary files report "-" for both counts.
      const added = Number.parseInt(addedStr, 10);
      const removed = Number.parseInt(removedStr, 10);
      const a = Number.isFinite(added) ? added : 0;
      const r = Number.isFinite(removed) ? removed : 0;
      lines_added += a;
      lines_removed += r;
      files.push({ path, added: a, removed: r });
    }

    out.push({
      commit: {
        sha,
        timestamp,
        author_hash: hashAuthor(authorEmail ?? ""),
        lines_added,
        lines_removed,
        files_changed: files.length,
        // Length only. The subject itself never leaves this function.
        subject_length: (subject ?? "").length,
        // Classified here, from that same subject, so the server can know a
        // revert happened without ever seeing what was reverted.
        is_revert: REVERT_SUBJECT.test(subject ?? ""),
        is_merge: (parents ?? "").trim().split(/\s+/).filter(Boolean).length > 1,
        session_corroborated: false,
      },
      files,
      is_revert: REVERT_SUBJECT.test(subject ?? ""),
    });
  }

  return out;
}

/** Uploadable projection: counts only, no paths, no subjects. */
export function parseLog(stdout: string): CommitRef[] {
  return parseLogDetailed(stdout).map((d) => d.commit);
}

/**
 * Doc 3 §11 — "Repository activity without matching local evidence gets limited
 * weight."
 *
 * A commit is corroborated when it lands inside, or shortly after, an observed
 * agent session for the same project. This is the check that stops someone
 * importing a repository full of other people's commits and having it score as
 * their own work: without a session that produced it, a commit carries little.
 *
 * The trailing window exists because commits usually land a little after the
 * session that wrote the code, not during it.
 */
export const CORROBORATION_TRAILING_MS = 30 * 60 * 1000;

export function markCorroboration(
  commits: CommitRef[],
  sessions: Pick<SessionRecord, "started_at" | "ended_at">[],
  trailingMs: number = CORROBORATION_TRAILING_MS,
): CommitRef[] {
  if (sessions.length === 0) return commits.map((c) => ({ ...c, session_corroborated: false }));

  const windows = sessions
    .map((s) => ({ from: s.started_at, to: s.ended_at + trailingMs }))
    .sort((a, b) => a.from - b.from);

  return commits.map((c) => ({
    ...c,
    session_corroborated: coveredBy(windows, c.timestamp),
  }));
}

/** Binary search over sorted, possibly overlapping windows. */
function coveredBy(windows: { from: number; to: number }[], t: number): boolean {
  let lo = 0;
  let hi = windows.length - 1;
  let candidate = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (windows[mid]!.from <= t) {
      candidate = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  // Overlapping windows mean an earlier one may still cover t, so scan back.
  for (let i = candidate; i >= 0; i--) {
    const w = windows[i]!;
    if (w.to >= t) return true;
    // Windows are sorted by start; once starts fall far behind t, none can reach.
    if (t - w.from > 24 * 60 * 60 * 1000) break;
  }
  return false;
}
