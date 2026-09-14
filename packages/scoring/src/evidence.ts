import { SIGNALS, type FeatureVector } from "@builder/types";
import { DIMENSION_FUNCTIONS } from "./dimensions.ts";

/**
 * Every string that may legitimately appear in `DimensionScore.evidence_refs`.
 *
 * This exists for the upload boundary. `evidence_refs` is a `string[]` sitting
 * inside the signed payload, and `assertUploadSafe` checks KEY names, not
 * values — so it is the one channel through which a modified client could push
 * arbitrary text at a server whose product promise is that it never receives
 * anyone's work. A server that stores whatever it is handed breaks that promise
 * from its own side, however honest the collector is.
 *
 * Derived by running every dimension function rather than written out by hand,
 * so it cannot drift from the components it describes. A new component is
 * automatically permitted; a renamed one automatically stops being.
 */

/** A feature vector of zeroes, observing everything. Produces every component. */
function probeVector(): FeatureVector {
  return {
    feature_version: "probe",
    scope: { kind: "window", from: 0, to: 0 },
    // All signals, so `availableComponents` filters nothing out.
    observed_signals: [...SIGNALS],
    interaction: {
      prompt_count: 0,
      tool_call_count: 0,
      assistant_turn_count: 0,
      active_ms: 0,
      files_touched: 0,
      distinct_extensions: 0,
      mean_prompt_words: 0,
      prompt_words_stddev: 0,
      session_count: 0,
      active_days: 0,
    },
    planning: {
      plan_mode_used: false,
      plan_before_execution_rate: 0,
      planned_episode_count: 0,
      upfront_exploration_share: 0,
      exploration_tool_ratio: 0,
    },
    steering: {
      steering_event_rate: 0,
      correction_count: 0,
      interrupt_count: 0,
      rejected_output_count: 0,
      fast_correction_rate: 0,
    },
    debugging: {
      failure_count: 0,
      retry_count: 0,
      debug_recovery_rate: 0,
      repeated_failure_rate: 0,
      mean_recovery_ms: 0,
      error_rate: 0,
    },
    delegation: {
      subagent_spawn_count: 0,
      background_task_count: 0,
      max_spawn_depth: 0,
      delegation_completion_rate: 0,
    },
    git: {
      commit_count: 0,
      lines_added: 0,
      lines_removed: 0,
      files_changed: 0,
      mean_commit_size: 0,
      session_corroborated_commit_rate: 0,
      rework_ratio: 0,
      revert_count: 0,
    },
    quality: {
      deep_analysis_ran: false,
      read_edit_ratio: 0,
      write_share_of_mutations: 0,
      test_file_ratio: 0,
      test_success_rate: 0,
      test_run_count: 0,
    },
    outcome: {
      episode_count: 0,
      completed_episode_rate: 0,
      deployment_count: 0,
    },
    extra: {},
  };
}

function deriveEvidenceRefIds(): ReadonlySet<string> {
  const ids = new Set<string>();
  const probe = probeVector();
  for (const fn of Object.values(DIMENSION_FUNCTIONS)) {
    for (const c of fn(probe).components) ids.add(c.feature);
  }
  return ids;
}

export const EVIDENCE_REF_IDS: ReadonlySet<string> = deriveEvidenceRefIds();

/** Doc 3 §5 caps evidence at the four strongest contributors per dimension. */
export const MAX_EVIDENCE_REFS_PER_DIMENSION = 4;

export function isEvidenceRef(value: string): boolean {
  return EVIDENCE_REF_IDS.has(value);
}
