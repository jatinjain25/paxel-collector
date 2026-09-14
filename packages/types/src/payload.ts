import type { AgentSource, Signal } from "./agent.ts";
import type { CommitRef, SessionRecord } from "./episode.ts";
import type { WireEvent } from "./event.ts";

/**
 * Counts the server derives and echoes back. NEVER sent by a client.
 *
 * Kept as a type because the profile and the eligibility gates are expressed in
 * these terms; it is simply computed from the uploaded evidence rather than
 * asserted by the machine that produced it.
 */
export interface EvidenceCounts {
  sessions: number;
  events: number;
  episodes: number;
  /**
   * Distinct projects, NOT repositories, and it was called repositories until
   * the label was checked against what produces it.
   *
   * The server counts distinct `project_id`, which is sha256 of the git root
   * when there is one and of the resolved path when there is not. So a scratch
   * directory with no `.git` was being reported as a repository, and the number
   * disagreed with the one the terminal prints, which counts work trees it
   * confirmed with `git rev-parse`.
   *
   * The wire payload carries no repository identifier at all: CommitRef has no
   * repo field, so commits cannot be attributed to one server-side even in
   * principle. Renaming is the honest fix; inventing a repo count from data
   * that does not contain one is not.
   */
  projects: number;
  commits: number;
  active_days: number;
  /** Span of the evidence window in days, for Doc 3 §8's temporal spread. */
  window_days: number;
  /**
   * Which tools were read, and which signals none of them could record.
   *
   * Part of the evidence description rather than a display concern, because
   * the profile cannot be honest without them. `toProfileView` hardcoded both
   * to `[]` under a comment claiming they were "recorded on the score", and
   * nothing recorded them: a profile could never say which sources it read,
   * and `unobserved_signals` was invisible. That second one is the whole
   * capability argument. Doc 4 §6 wants capability and confidence visibly
   * distinct, and a dimension whose component was dropped because the builder's
   * editor does not record interrupts should say so rather than look like a
   * lower score.
   */
  sources: AgentSource[];
  unobserved_signals: Signal[];
}

/**
 * The upload payload.
 *
 * REVERSED AGAIN 2026-09-10, back to evidence. It briefly carried the score the
 * machine computed, so that "only your score leaves" could be said literally.
 * The price was that a machine which computes its own score can edit it, which
 * meant the leaderboard needed an external cost — a GitHub account with real
 * history — to be worth anything at all.
 *
 * Removing that cost means removing the reason for it. **There is no score
 * here.** The client uploads what it observed and the server computes every
 * number, so a forged rank is not a matter of editing one integer: it requires
 * fabricating a hundred thousand internally consistent events with believable
 * timing, correct call/result pairing and a plausible multi-month window. The
 * catcher then checks exactly those properties, on the server, in a package
 * this one deliberately does not ship: naming what is looked for would be a
 * list of what to avoid.
 *
 * Be precise about what that is worth. Nobody can PREVENT edits on hardware
 * somebody else controls — the collector is open source, the signing key is on
 * their disk, and they need not touch the binary to POST whatever they like. It
 * is cost plus detection, never proof, and no copy may say otherwise.
 *
 * WHAT IS IN HERE, and what is not. Every `WireEvent` is text-free by
 * construction: commands and paths are hashes, and `toWire` is an allowlist
 * that a test verifies exhaustively against real transcripts. No code, no
 * prompts, no file names, no commit messages. It is the shape of the work,
 * never its content — which is a bigger claim than "only a score" and a
 * narrower one than it sounds, so the site must say it precisely.
 *
 * This restores Doc 5 §9's replay and Doc 4 §8's rescore-from-stored-evidence,
 * both lost in 1308eeb. Changing a weight is a recompute again, rather than
 * asking every builder to re-run the collector.
 */
export interface UploadPayload {
  /** Doc 2 §8 idempotency key, deterministic over the evidence. */
  upload_id: string;
  /** Per-machine. The server trusts its own token over this field. */
  device_id: string;
  generated_at: number;

  /**
   * Sessions in this upload. After the first publish this carries only what
   * the server has not already seen.
   */
  sessions: SessionRecord[];
  /** Text-free by construction. See `toWire`. */
  events: WireEvent[];
  /** Metadata only: hashed author, SHA, line counts. Never a message or a diff. */
  commits: CommitRef[];

  /** Which tools contributed, so the capability matrix is auditable. */
  sources: AgentSource[];
  /**
   * Signals no contributing tool could record. Present so a thin dimension is
   * explicable as "your tools do not write this down" rather than as a low
   * score — see the capability model in agent.ts.
   */
  unobserved_signals: Signal[];

  /** Doc 2 §8 idempotency key — a pipeline change invalidates prior derivations. */
  pipeline_version: string;
  client_version: string;
  feature_version: string;
}

/**
 * Signed transport envelope.
 *
 * The signature covers the canonical serialization of the WHOLE payload, so
 * nothing can be altered in flight. Paxel's covered only the request id, which
 * is why arbitrary scores could be swapped in beneath a legitimate signature.
 *
 * It still proves nothing about the author: the key is on the user's own disk.
 * What defends the board is that there is no number in here to swap.
 */
export interface SignedEnvelope {
  payload: UploadPayload;
  signature: {
    alg: "hmac-sha256";
    value: string;
    /** Single-use, server-issued. Replay protection. */
    nonce: string;
    key_id: string;
  };
}
