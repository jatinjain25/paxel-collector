import type {
  CommitRef,
  EpisodeRecord,
  FeatureScope,
  FeatureVector,
  SessionRecord,
  Signal,
  WireEvent,
} from "@builder/types";
import { isDeveloperTurn, isToolInvocation, isToolResult } from "@builder/types";
import { isExploration, isMutation } from "./taxonomy.ts";

/**
 * Deterministic feature extraction (Doc 3 §3, families per Doc 2 §6).
 *
 * These are the only inputs to the ranked score, so three rules hold throughout:
 *
 *  1. Count invocations with `isToolInvocation`, never by event_type alone.
 *     Every tool use emits both a call and a result under one event_type, so
 *     naive counting doubles every tool metric.
 *  2. Ship raw counts alongside every rate (Doc 3 §3 auditability). A rate on
 *     its own cannot be audited, and 1/1 is not the same claim as 400/400.
 *  3. Prefer rates over volumes wherever a score will read the value, because
 *     Doc 3 §11 requires that prompt and commit volume not raise a score.
 */

export interface ExtractInput {
  scope: FeatureScope;
  feature_version: string;
  /** Union of what the contributing sources could observe. */
  observed_signals: Signal[];
  sessions: SessionRecord[];
  episodes: EpisodeRecord[];
  events: WireEvent[];
  commits: CommitRef[];
  /** Churn signals computed locally in packages/git; absent if git was unavailable. */
  rework_ratio?: number;
  revert_count?: number;
  test_file_ratio?: number;
  /** Doc 5 §2 toolchain results; absent unless the deep pass ran. */
  quality?: {
    mean_complexity?: number;
    static_finding_count?: number;
    security_finding_count?: number;
    duplication_ratio?: number;
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A ratio, not a rate: the result may exceed 1 and legitimately does.
 *
 * Zero mutations means the ratio is undefined rather than infinite. Reporting 0
 * would say "edit-first" about somebody who only read, which is the opposite of
 * true, so it reports the numerator instead — reads with nothing to divide by.
 */
function safeRatio(numerator: number, denominator: number): number {
  if (denominator === 0) return numerator === 0 ? 0 : numerator;
  return numerator / denominator;
}

function safeRate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

function activeDays(timestamps: number[]): number {
  const days = new Set<string>();
  for (const t of timestamps) {
    const d = new Date(t);
    days.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
  }
  return days.size;
}

export function extractFeatures(input: ExtractInput): FeatureVector {
  const { events, sessions, episodes, commits } = input;

  const invocations = events.filter(isToolInvocation);
  // Reads through a Read tool AND reads through the shell. Counting only the
  // former measures tool choice rather than care: on one real corpus, 24,554
  // shell reads were invisible and dragged the ratio from 7.68 to 0.80.
  const reads = invocations.filter(
    (e) => e.event_type === "file_read" || e.metadata.command_family === "inspect",
  );
  // File mutations only: git_commit and deployment are mutations of the world,
  // not of a file, and including them would make the ratio track shipping
  // cadence rather than how carefully files are changed.
  const fileMutations = invocations.filter(
    (e) => e.event_type === "file_write" || e.event_type === "file_edit",
  );
  const wholeFileWrites = fileMutations.filter((e) => e.event_type === "file_write");
  const results = events.filter(isToolResult);
  const developerTurns = events.filter(isDeveloperTurn);

  const prompts = developerTurns.filter(
    (e) => e.event_type === "user_instruction" || e.event_type === "course_correction",
  );
  const corrections = developerTurns.filter((e) => e.event_type === "course_correction");
  const interrupts = events.filter((e) => e.metadata.interrupted === true);
  const denials = events.filter((e) => e.metadata.denial_kind !== undefined);

  const promptWords = prompts.map((e) => e.metadata.word_count ?? 0).filter((w) => w > 0);

  // Files touched: distinct path hashes across mutating invocations only. Reading
  // a file is not touching it, and counting reads would reward browsing.
  const touchedPaths = new Set<string>();
  const extensions = new Set<string>();
  for (const e of invocations) {
    if (!isMutation(e.event_type)) continue;
    for (const p of e.metadata.paths ?? []) {
      touchedPaths.add(p.path_hash);
      if (p.ext) extensions.add(p.ext);
    }
  }

  const testResults = results.filter(
    (e) => e.event_type === "test_success" || e.event_type === "test_failure",
  );
  const testSuccesses = testResults.filter((e) => e.event_type === "test_success");

  const spawns = invocations.filter((e) => e.event_type === "agent_spawn");
  const spawnReturns = results.filter((e) => e.event_type === "agent_spawn");

  const nonMergeCommits = commits.filter((c) => !c.is_merge);
  const corroborated = nonMergeCommits.filter((c) => c.session_corroborated);

  const allTimestamps = [...events.map((e) => e.timestamp), ...commits.map((c) => c.timestamp)];

  return {
    feature_version: input.feature_version,
    scope: input.scope,
    observed_signals: input.observed_signals,

    interaction: {
      prompt_count: prompts.length,
      tool_call_count: invocations.length,
      assistant_turn_count: events.filter((e) => e.event_type === "assistant_response").length,
      active_ms: sessions.reduce((a, s) => a + s.active_ms, 0),
      files_touched: touchedPaths.size,
      distinct_extensions: extensions.size,
      mean_prompt_words: mean(promptWords),
      prompt_words_stddev: stddev(promptWords),
      session_count: sessions.length,
      active_days: activeDays(allTimestamps),
    },

    planning: {
      plan_mode_used: events.some((e) => e.metadata.tool_name === "ExitPlanMode"),
      plan_before_execution_rate: planBeforeExecutionRate(episodes, events),
      planned_episode_count: episodes.filter((ep) => episodeExploredFirst(ep, events)).length,
      upfront_exploration_share: mean(
        episodes.map((ep) => upfrontExplorationShare(ep, events)),
      ),
      exploration_tool_ratio: safeRate(
        invocations.filter((e) => isExploration(e.event_type)).length,
        invocations.length,
      ),
    },

    steering: {
      // Corrections per developer turn, not per unit time: Doc 3 §11 forbids
      // prompt volume raising a score, and a rate is volume-invariant.
      steering_event_rate: safeRate(corrections.length + interrupts.length, prompts.length),
      correction_count: corrections.length,
      interrupt_count: interrupts.length,
      rejected_output_count: denials.length,
      fast_correction_rate: fastCorrectionRate(events),
    },

    debugging: debuggingFeatures(episodes, events),

    delegation: {
      subagent_spawn_count: spawns.length,
      background_task_count: events.filter((e) => e.metadata.agent_type !== undefined && isToolInvocation(e)).length,
      max_spawn_depth: Math.max(0, ...events.map((e) => e.metadata.spawn_depth ?? 0)),
      delegation_completion_rate: safeRate(spawnReturns.length, spawns.length),
    },

    git: {
      commit_count: nonMergeCommits.length,
      lines_added: nonMergeCommits.reduce((a, c) => a + c.lines_added, 0),
      lines_removed: nonMergeCommits.reduce((a, c) => a + c.lines_removed, 0),
      files_changed: nonMergeCommits.reduce((a, c) => a + c.files_changed, 0),
      mean_commit_size: mean(nonMergeCommits.map((c) => c.lines_added + c.lines_removed)),
      session_corroborated_commit_rate: safeRate(corroborated.length, nonMergeCommits.length),
      rework_ratio: input.rework_ratio ?? 0,
      revert_count: input.revert_count ?? 0,
    },

    quality: {
      deep_analysis_ran: input.quality !== undefined,
      // Invocations only. Every tool use emits a call and a result under one
      // event_type, so counting by type alone would double both sides.
      read_edit_ratio: safeRatio(reads.length, fileMutations.length),
      write_share_of_mutations: safeRate(wholeFileWrites.length, fileMutations.length),
      test_file_ratio: input.test_file_ratio ?? 0,
      test_success_rate: safeRate(testSuccesses.length, testResults.length),
      test_run_count: testResults.length,
      ...(input.quality ?? {}),
    },

    outcome: {
      episode_count: episodes.length,
      completed_episode_rate: safeRate(
        episodes.filter((ep) => ep.completed).length,
        episodes.length,
      ),
      deployment_count: invocations.filter((e) => e.event_type === "deployment").length,
    },

    extra: {
      // Raw counts kept for auditability where the named field is a rate.
      correction_denominator: prompts.length,
      failure_denominator: results.length,
      commit_denominator: nonMergeCommits.length,
      window_days: activeDays(allTimestamps) === 0 ? 0 : spanDays(allTimestamps),
    },
  };
}

function spanDays(timestamps: number[]): number {
  if (timestamps.length < 2) return 0;
  return (Math.max(...timestamps) - Math.min(...timestamps)) / DAY_MS;
}

function episodeEvents(ep: EpisodeRecord, events: WireEvent[]): WireEvent[] {
  const ids = new Set(ep.session_ids);
  return events.filter((e) => ids.has(e.session_id)).sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Share of an episode elapsing before the first change is made.
 *
 * Measures orienting before acting. Zero means the first thing that happened was
 * an edit; higher means time was spent reading first.
 */
export function upfrontExplorationShare(ep: EpisodeRecord, events: WireEvent[]): number {
  const evs = episodeEvents(ep, events).filter(isToolInvocation);
  if (evs.length === 0) return 0;
  const start = evs[0]!.timestamp;
  const end = evs[evs.length - 1]!.timestamp;
  const span = end - start;
  if (span <= 0) return 0;
  const firstMutation = evs.find((e) => isMutation(e.event_type));
  if (!firstMutation) return 1;
  return (firstMutation.timestamp - start) / span;
}

/** Did this episode read anything before it changed anything? */
function episodeExploredFirst(ep: EpisodeRecord, events: WireEvent[]): boolean {
  const evs = episodeEvents(ep, events).filter(isToolInvocation);
  const firstMutationIdx = evs.findIndex((e) => isMutation(e.event_type));
  if (firstMutationIdx === -1) return evs.some((e) => isExploration(e.event_type));
  return evs.slice(0, firstMutationIdx).some((e) => isExploration(e.event_type));
}

/** Doc 3 §3 — share of episodes that looked before they leapt. */
export function planBeforeExecutionRate(ep: EpisodeRecord[], events: WireEvent[]): number {
  if (ep.length === 0) return 0;
  return ep.filter((e) => episodeExploredFirst(e, events)).length / ep.length;
}

/**
 * Corrections landing close to the thing they correct.
 *
 * Catching a wrong turn on the next turn is a different skill from catching it
 * twenty turns later, and it is the one worth rewarding: a bad direction costs
 * more the longer it runs unchallenged.
 *
 * Measured as agent actions elapsed since the previous developer turn. The first
 * version asked whether any agent action preceded the correction, which is true
 * of essentially every correction — it returned 98.5% on real data, i.e. it was
 * measuring nothing.
 */
export const FAST_CORRECTION_ACTIONS = 6;

export function fastCorrectionRate(
  events: WireEvent[],
  threshold: number = FAST_CORRECTION_ACTIONS,
): number {
  const ordered = [...events].sort((a, b) => a.timestamp - b.timestamp);
  let sinceDeveloperTurn = 0;
  let fast = 0;
  let corrections = 0;

  for (const e of ordered) {
    if (e.event_type === "course_correction") {
      corrections++;
      if (sinceDeveloperTurn <= threshold) fast++;
      sinceDeveloperTurn = 0;
      continue;
    }
    if (isDeveloperTurn(e)) {
      sinceDeveloperTurn = 0;
      continue;
    }
    if (isToolInvocation(e) || e.event_type === "assistant_response") sinceDeveloperTurn++;
  }

  return safeRate(fast, corrections);
}

/**
 * What identifies the thing that failed.
 *
 * Without this, every Bash failure collapses to one key and "did the same thing
 * break twice" becomes unanswerable — the first version returned a 99.6%
 * repeated-failure rate because it was comparing everything to everything.
 * A command hash gives Bash a stable identity without the command text.
 */
function sameTarget(a: WireEvent, b: WireEvent): boolean {
  const pathA = a.metadata.paths?.[0]?.path_hash;
  const pathB = b.metadata.paths?.[0]?.path_hash;
  if (pathA && pathB) return pathA === pathB;
  // No file involved: fall back to the command family, so a corrected command
  // still counts as recovering from the broken one.
  if (a.metadata.command_family && b.metadata.command_family) {
    return a.metadata.command_family === b.metadata.command_family;
  }
  return true;
}

function failureSignature(e: WireEvent): string | undefined {
  const target = e.metadata.paths?.[0]?.path_hash ?? e.metadata.command_hash;
  if (!target) return undefined;
  return `${e.metadata.tool_name ?? "?"}:${target}`;
}

/**
 * Doc 2 §6 debugging family, computed WITHIN episodes.
 *
 * Scope is the whole point here. "Bash failed twice in 71 days" is noise;
 * "the same command failed twice inside one stretch of work" is signal. The
 * first version searched the entire corpus for a later success by the same tool
 * and reported a 98.5% recovery rate — it was asking whether a tool was ever
 * used successfully again, which for Bash is always yes.
 *
 * Both rates are needed together: a high recovery rate looks like skill until
 * you see it recovering from the same failure repeatedly, which is thrash.
 */
export const RECOVERY_WINDOW_MS = 20 * 60 * 1000;

export function debuggingFeatures(
  episodes: EpisodeRecord[],
  events: WireEvent[],
  recoveryWindowMs: number = RECOVERY_WINDOW_MS,
): FeatureVector["debugging"] {
  let failures = 0;
  let recovered = 0;
  let repeated = 0;
  let identifiable = 0;
  let retries = 0;
  let totalResults = 0;
  const recoveryTimes: number[] = [];

  const scopes: WireEvent[][] =
    episodes.length > 0 ? episodes.map((ep) => episodeEvents(ep, events)) : [events];

  for (const scope of scopes) {
    const results = scope.filter(isToolResult);
    totalResults += results.length;
    const errors = results.filter((r) => r.metadata.is_error === true);
    failures += errors.length;

    const seen = new Map<string, number>();

    for (const failure of errors) {
      const sig = failureSignature(failure);
      if (sig) {
        identifiable++;
        const prior = seen.get(sig) ?? 0;
        if (prior > 0) repeated++;
        seen.set(sig, prior + 1);
      }

      // Recovery uses a LOOSER identity than repetition, deliberately.
      //
      // "Did the same thing fail again" needs an exact match. "Did they recover"
      // does not: fixing a broken shell command changes its hash, so requiring an
      // exact match missed almost every Bash recovery and reported 14.9% on real
      // data. Recovery therefore matches the same kind of operation — same tool,
      // and same file or same command family — succeeding soon after.
      const fix = results.find(
        (r) =>
          r.timestamp > failure.timestamp &&
          r.timestamp - failure.timestamp <= recoveryWindowMs &&
          r.metadata.is_error !== true &&
          r.metadata.tool_name === failure.metadata.tool_name &&
          sameTarget(r, failure),
      );
      if (fix) {
        recovered++;
        recoveryTimes.push(fix.timestamp - failure.timestamp);
      }

      // A retry is the same target attempted again after failing — behavioral,
      // unlike the transport-level API retries which are infrastructure noise
      // and are deliberately not counted.
      if (sig !== undefined) {
        const again = scope.some(
          (e) => isToolInvocation(e) && e.timestamp > failure.timestamp && failureSignature(e) === sig,
        );
        if (again) retries++;
      }
    }
  }

  return {
    failure_count: failures,
    retry_count: retries,
    debug_recovery_rate: safeRate(recovered, failures),
    // Denominator is failures we could identify, not all failures: reporting a
    // rate over things we cannot tell apart would be a made-up number.
    repeated_failure_rate: safeRate(repeated, identifiable),
    mean_recovery_ms: mean(recoveryTimes),
    error_rate: safeRate(failures, totalResults),
  };
}
