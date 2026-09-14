import { canonicalize, signPayload } from "@builder/upload";
import {
  assertUploadSafe,
  type SessionRecord,
  type Signal,
  type UploadPayload,
  type WireEvent,
} from "@builder/types";
import type { CollectionSummary } from "@builder/discovery";
import { ApiClient, ApiRequestError, type DeviceCredentials, type UploadResponse } from "./api.ts";
import {
  ensureBuilderDir,
  KEY_PATH,
  readSecret,
  saveConfig,
  TOKEN_PATH,
  writeSecret,
  type BuilderConfig,
} from "./config.ts";
import { CLIENT_VERSION, FEATURE_VERSION, PIPELINE_VERSION } from "./version.ts";

/**
 * Assembling and publishing a score.
 *
 * Nothing here decides whether to publish; that is the caller's confirmation
 * step, and it is deliberately not satisfiable by `--yes`.
 */

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * An id derived from the evidence, not from randomness.
 *
 * This is what makes re-running the collector on unchanged history a no-op
 * instead of a second row on the board. `generated_at` is excluded precisely
 * because it moves on every run and would otherwise make every upload unique.
 */
export async function deterministicUploadId(
  deviceId: string,
  payload: Pick<UploadPayload, "sessions" | "events" | "commits">,
): Promise<string> {
  const digest = await sha256Hex(
    canonicalize({
      device_id: deviceId,
      // Session content hashes, not the events themselves: identical evidence
      // produces identical hashes and this stays cheap on a large corpus.
      sessions: payload.sessions.map((x) => `${x.session_id}:${x.content_hash}`).sort(),
      events: payload.events.length,
      commits: payload.commits.map((c) => c.sha).sort(),
      pipeline_version: PIPELINE_VERSION,
      feature_version: FEATURE_VERSION,
    }),
  );
  return `up_${digest.slice(0, 32)}`;
}

/**
 * What actually leaves the machine.
 *
 * Every event has already been through `toWire`, which is an allowlist, so
 * there is no text here: commands and paths are hashes. The server derives the
 * score from this, which is why the client states no number.
 */
export function buildPayload(
  device: DeviceCredentials,
  collection: Pick<CollectionSummary, "sessions" | "events" | "commits" | "sources" | "observed_signals">,
  uploadId: string,
  now: number,
  missingSignals: Signal[],
): UploadPayload {
  return {
    upload_id: uploadId,
    device_id: device.device_id,
    generated_at: now,
    sessions: collection.sessions,
    events: collection.events,
    commits: collection.commits,
    sources: collection.sources.map((x) => x.source),
    unobserved_signals: missingSignals,
    pipeline_version: PIPELINE_VERSION,
    client_version: CLIENT_VERSION,
    feature_version: FEATURE_VERSION,
  };
}

/** Only what the server has not already accepted. */
/**
 * What the server has not already accepted.
 *
 * Keyed on session id AND content hash. A session id alone would mean the one
 * being worked in right now is sent once and never again, so the newest work,
 * which recency weighting counts most, would never reach a score.
 */
export function newSessionsOnly<T extends { sessions: SessionRecord[]; events: WireEvent[] }>(
  collection: T,
  known: ReadonlySet<string>,
): { sessions: SessionRecord[]; events: WireEvent[]; skipped: number } {
  const sessions = collection.sessions.filter(
    (s) => !known.has(`${s.session_id}:${s.content_hash}`),
  );
  const keep = new Set(sessions.map((s) => s.session_id));
  return {
    sessions,
    events: collection.events.filter((e) => keep.has(e.session_id)),
    skipped: collection.sessions.length - sessions.length,
  };
}

async function storedCredentials(config: BuilderConfig): Promise<DeviceCredentials | undefined> {
  const token = await readSecret(TOKEN_PATH);
  const keyRaw = await readSecret(KEY_PATH);
  if (token === undefined || keyRaw === undefined || config.device_id.length === 0) return undefined;

  const key = JSON.parse(keyRaw) as { key_id: string; secret: string };
  return {
    device_id: config.device_id,
    device_token: token,
    key_id: key.key_id,
    key_secret: key.secret,
  };
}

async function register(client: ApiClient, config: BuilderConfig): Promise<DeviceCredentials> {
  const creds = await client.registerDevice(CLIENT_VERSION);
  await ensureBuilderDir();
  // Secrets first. A crash after this still leaves a usable machine; a crash
  // before it would leave a device row the client can never authenticate
  // against, and no way to notice.
  await writeSecret(TOKEN_PATH, creds.device_token);
  await writeSecret(KEY_PATH, JSON.stringify({ key_id: creds.key_id, secret: creds.key_secret }));
  await saveConfig({ ...config, device_id: creds.device_id });
  return creds;
}

export interface DeviceSession {
  credentials: DeviceCredentials;
  registered: boolean;
  /** Fetched while proving the credentials work, so it is not a wasted round trip. */
  nonce: string;
}

/**
 * Settle this machine's identity, and prove it before anything is built on it.
 *
 * Stored credentials are not assumed to still work. The server can legitimately
 * no longer know this device — a wiped development database, a rotated
 * deployment, a revoked token — and the honest response is to register again
 * rather than to fail. Discovered by wiping the dev database and watching the
 * CLI die on a token it had no reason to trust.
 *
 * The identity is settled BEFORE the payload is built, because `device_id` is
 * inside the payload and inside the signature. Re-registering afterwards would
 * mean rebuilding and re-signing everything.
 *
 * Registration happens here and nowhere else: `builder analyze` must make no
 * network request at all, so a machine that never publishes never appears.
 */
export async function ensureDevice(client: ApiClient, config: BuilderConfig): Promise<DeviceSession> {
  const stored = await storedCredentials(config);

  if (stored !== undefined) {
    try {
      const { nonce } = await client.nonce(stored.device_token);
      return { credentials: stored, registered: false, nonce };
    } catch (err) {
      if (!(err instanceof ApiRequestError) || err.code !== "invalid_token") throw err;
      // The server does not know this machine any more. Fall through.
    }
  }

  const creds = await register(client, config);
  const { nonce } = await client.nonce(creds.device_token);
  return { credentials: creds, registered: true, nonce };
}

export interface PublishOptions {
  client: ApiClient;
  credentials: DeviceCredentials;
  payload: UploadPayload;
  /** Issued by `ensureDevice` while it proved the credentials work. */
  nonce: string;
}

export async function publish({ client, credentials, payload, nonce }: PublishOptions): Promise<UploadResponse> {
  // Defence in depth. The payload type already makes a leak unrepresentable,
  // but this runs on the developer's machine and fails there rather than
  // shipping something unexpected.
  assertUploadSafe(payload);

  const envelope = await signPayload(
    payload,
    { secret: credentials.key_secret, key_id: credentials.key_id },
    nonce,
  );
  return client.upload(credentials.device_token, envelope);
}

/**
 * The review step.
 *
 * It used to print the whole payload, which was honest when the payload was
 * eleven fields. It is now a hundred thousand events, so this prints the shape,
 * the guarantee, and three real events chosen from the middle of the stream. A
 * wall of JSON nobody reads is not consent; a sample somebody can actually
 * check is closer to it.
 */
export function previewPayload(payload: UploadPayload, skipped = 0): string {
  const samples = [0, Math.floor(payload.events.length / 2), payload.events.length - 1]
    .filter((i, at, all) => i >= 0 && all.indexOf(i) === at)
    .map((i) => `    ${JSON.stringify(payload.events[i])}`)
    .join("\n");

  const lines = [
    "  This is everything that would be sent:",
    "",
    `    sessions   ${payload.sessions.length.toLocaleString()}${skipped > 0 ? `  (${skipped.toLocaleString()} already sent)` : ""}`,
    `    events     ${payload.events.length.toLocaleString()}`,
    `    commits    ${payload.commits.length.toLocaleString()}`,
    "",
    "  No code, no prompts, no file names, no commit messages. Commands and",
    "  paths are hashes. Three real events from your own stream:",
    "",
    samples,
    "",
    "  The score is computed on the server from this, so this machine never",
    "  states a number that could be edited on the way out.",
  ];
  return lines.join("\n");
}
