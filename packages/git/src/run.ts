import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Run git read-only, with every code-execution path a repository can control
 * turned off.
 *
 * Doc 5 §7: "Never execute arbitrary project scripts during analysis." Reading a
 * repo is not obviously dangerous until you notice how much of git is
 * configurable into running commands:
 *
 *   core.fsmonitor  — a command git runs to detect changes
 *   core.pager      — a command git pipes output through
 *   core.hooksPath  — a directory of scripts git may invoke
 *   core.editor     — invoked by some subcommands
 *   alias.*         — `!sh -c ...` aliases execute shells
 *
 * A hostile or merely unusual repo could set any of these in .git/config. We
 * override them per invocation rather than trusting that `git log` is inert, and
 * we never pass a subcommand that could be an alias.
 */
const SAFE_FLAGS = [
  "-c", "core.fsmonitor=false",
  "-c", "core.pager=cat",
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.editor=false",
  "-c", "protocol.ext.allow=never",
  "--no-pager",
];

/** Environment with repo-location and prompt-triggering variables removed. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY"]) {
    delete env[key];
  }
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_OPTIONAL_LOCKS = "0";
  return env;
}

export class GitError extends Error {
  override readonly name = "GitError";
}

export interface GitRunOptions {
  cwd: string;
  /** Output cap. A very large history should be truncated, not OOM the process. */
  maxBuffer?: number;
  timeoutMs?: number;
}

export async function git(args: string[], options: GitRunOptions): Promise<string> {
  try {
    const { stdout } = await exec("git", [...SAFE_FLAGS, ...args], {
      cwd: options.cwd,
      maxBuffer: options.maxBuffer ?? 256 * 1024 * 1024,
      timeout: options.timeoutMs ?? 60_000,
      encoding: "utf8",
      // Neutralize the ambient environment: a stray GIT_DIR or credential helper
      // in the user's shell should not change what we read.
      //
      // These must be DELETED, not set to "". Git treats an empty GIT_DIR as a
      // literal path of "", which breaks repository discovery entirely rather
      // than falling back to the default search.
      env: cleanEnv(),
    });
    return stdout;
  } catch (cause) {
    throw new GitError(`git ${args[0] ?? ""} failed in ${options.cwd}`, { cause });
  }
}

/** Is this directory inside a git work tree? */
export async function isRepo(cwd: string): Promise<boolean> {
  try {
    return (await git(["rev-parse", "--is-inside-work-tree"], { cwd })).trim() === "true";
  } catch {
    return false;
  }
}

/** Repository root, used to key episodes to a project without naming it. */
export async function repoRoot(cwd: string): Promise<string | undefined> {
  try {
    const out = (await git(["rev-parse", "--show-toplevel"], { cwd })).trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}
