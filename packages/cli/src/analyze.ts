import { derive } from "@builder/derive";
import { collectAll, type CollectionSummary } from "@builder/discovery";
import {
  SIGNALS,
  type EvidenceCounts,
  type ScoreRecord,
  type Signal,
  type UploadPayload,
} from "@builder/types";
import { CLIENT_VERSION, FEATURE_VERSION, PIPELINE_VERSION } from "./version.ts";

/**
 * The full local pipeline: collect → episodes → features → score.
 *
 * Everything here runs on the developer's machine and nothing leaves it. The
 * upload step is deliberately separate, so `analyze` can be run by someone who
 * has no intention of ever uploading and still get their profile.
 *
 * It scores THE WIRE PAYLOAD, through the same `derive` the server runs, and
 * that is the whole design of this file. It used to build its own feature
 * vector from the local collection, which had richer inputs: `test_file_ratio`
 * came from git commit numstat over real paths, where the server can only see
 * the paths the agent actually opened. Same feature name, different population,
 * and the terminal printed 6,992 while the profile said 6,964.
 *
 * A preview that is not the published number is not a preview. Anything the
 * server cannot see must not reach this number either, or the disagreement
 * comes back the moment the two definitions drift again.
 */

export interface AnalyzeResult {
  record: ScoreRecord;
  /** Exactly the counts the server will publish, not a second local tally. */
  evidence: EvidenceCounts;
  collection: CollectionSummary;
  episodes: number;
  missingSignals: Signal[];
  /** The bytes that were scored, so a caller can sign and send the same ones. */
  payload: UploadPayload;
}

export interface AnalyzeOptions {
  builderId?: string;
  scanRepos?: boolean;
  onProgress?: (message: string) => void;
  /**
   * Evidence the caller has already gathered.
   *
   * `builder analyze` prints a summary and asks for confirmation before
   * scoring, which means it has already read every session. Without this,
   * `analyze` collected a second time and a real corpus (1.1 GB, 272 sessions)
   * was parsed twice per run for no benefit.
   */
  collection?: CollectionSummary;
}

export async function analyze(options: AnalyzeOptions = {}): Promise<AnalyzeResult> {
  const collection =
    options.collection ??
    (await collectAll({
      ...(options.scanRepos !== undefined && { scanRepos: options.scanRepos }),
      ...(options.onProgress !== undefined && { onProgress: options.onProgress }),
    }));

  const observed = new Set(collection.observed_signals);
  const missingSignals = SIGNALS.filter((s) => !observed.has(s));
  const builderId = options.builderId ?? "BLDR-LOCAL";

  // Shaped exactly as an upload, because that is what gets scored. `upload_id`
  // and `device_id` are placeholders: `derive` never reads them, and minting a
  // real device here would mean `analyze` touching the network, which it must
  // never do.
  const payload: UploadPayload = {
    upload_id: "local",
    device_id: builderId,
    generated_at: Date.now(),
    sessions: collection.sessions,
    events: collection.events,
    commits: collection.commits,
    sources: collection.sources.map((x) => x.source),
    unobserved_signals: missingSignals,
    pipeline_version: PIPELINE_VERSION,
    client_version: CLIENT_VERSION,
    feature_version: FEATURE_VERSION,
  };

  const derived = derive(payload, builderId, PIPELINE_VERSION, FEATURE_VERSION);

  return {
    record: derived.record,
    evidence: derived.evidence,
    collection,
    episodes: derived.episodes,
    missingSignals,
    payload,
  };
}
