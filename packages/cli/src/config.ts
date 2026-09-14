import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * On-disk state for the collector, under ~/.builder.
 *
 * Doc 5 §7 requires hashed/protected credentials. Anything secret is written
 * 0600 inside a 0700 directory, and secrets are never placed in the config file
 * so that a user pasting their config for support cannot leak a token.
 */
export const BUILDER_DIR = join(homedir(), ".builder");
export const CONFIG_PATH = join(BUILDER_DIR, "config.json");
export const TOKEN_PATH = join(BUILDER_DIR, "token");
export const KEY_PATH = join(BUILDER_DIR, "key");
/** Doc 2 §9 — failed uploads leave a protected local payload for replay. */
export const PENDING_DIR = join(BUILDER_DIR, "pending");
export const CACHE_DIR = join(BUILDER_DIR, "cache");

export interface BuilderConfig {
  builder_id?: string;
  device_id: string;
  api_base_url: string;
  /** Doc 2 §7 — repo reading is opt-out; the deep quality pass is opt-in. */
  repo_analysis_enabled: boolean;
  deep_analysis_enabled: boolean;
  /** Local model to use for prose. Absent means numbers-only, which is supported. */
  local_model?: string;
  last_upload_at?: number;
}

/**
 * `api_base_url` defaults to a local API, not to a domain nobody owns. It was
 * `https://api.builder.local` — a `.local` TLD that resolves to nothing, printed
 * to users by `builder status` as though it were somewhere real.
 */
export const DEFAULT_API_BASE_URL = "http://127.0.0.1:8787";

/**
 * Precedence: environment, then the saved config, then the default.
 *
 * The environment has to win. Once `ensureConfig` writes a config file the
 * stored `api_base_url` would otherwise be pinned forever, so pointing the
 * collector at a local server for development became impossible without hand
 * editing JSON — which is exactly how you end up debugging a connection refused
 * against a URL you thought you had changed.
 */
export function resolveApiBaseUrl(stored?: string): string {
  return process.env.BUILDER_API_URL ?? stored ?? DEFAULT_API_BASE_URL;
}

export const DEFAULT_CONFIG: Omit<BuilderConfig, "device_id"> = {
  api_base_url: DEFAULT_API_BASE_URL,
  repo_analysis_enabled: true,
  deep_analysis_enabled: false,
};

/** Directory that must exist before secrets are written, with restrictive mode. */
export async function ensureBuilderDir(root: string = BUILDER_DIR): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  // mkdir honours the process umask, so set the mode explicitly afterwards.
  await chmod(root, 0o700);
}

export async function writeSecret(path: string, value: string): Promise<void> {
  await ensureBuilderDir(dirname(path));
  await writeFile(path, value, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

export async function readSecret(path: string): Promise<string | undefined> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch {
    return undefined;
  }
}

async function readConfigFile(path: string): Promise<Partial<BuilderConfig> | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Partial<BuilderConfig>;
  } catch {
    return undefined;
  }
}

/**
 * Read the config without touching disk.
 *
 * `device_id` is spread LAST. It used to be spread before `...raw`, so a config
 * file that existed but had no `device_id` overwrote the freshly minted one with
 * `undefined`.
 */
export async function loadConfig(path: string = CONFIG_PATH): Promise<BuilderConfig> {
  const raw = await readConfigFile(path);
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    api_base_url: resolveApiBaseUrl(raw?.api_base_url),
    device_id: raw?.device_id ?? newDeviceId(),
  };
}

/**
 * Read the config, creating and persisting it on first run.
 *
 * This exists because nothing ever called `saveConfig`, so `~/.builder` was
 * never created and `device_id` was minted fresh on every invocation: two
 * consecutive `builder status` runs printed two different ids, silently
 * breaking the stability contract stated on `newDeviceId` below.
 *
 * That is not cosmetic. Upload idempotency keys on `device_id`, so without
 * persistence every upload from one machine would look like a new device and
 * the leaderboard would count one person N times.
 *
 * `loadConfig` stays a pure read; commands that need identity call this.
 *
 * `apiBaseUrl` is the `--api` flag, and unlike the environment variable it is
 * meant to STICK. The installer passes the origin it was served from, and a
 * value that lived only for that one process would leave every later
 * `builder publish` talking to the default again — which is how a binary
 * installed from a real site ends up calling 127.0.0.1.
 */
export async function ensureConfig(
  path: string = CONFIG_PATH,
  apiBaseUrl?: string,
): Promise<BuilderConfig> {
  const raw = await readConfigFile(path);
  const resolved = apiBaseUrl ?? resolveApiBaseUrl(raw?.api_base_url);

  if (raw?.device_id !== undefined) {
    const config: BuilderConfig = {
      ...DEFAULT_CONFIG,
      ...raw,
      api_base_url: resolved,
      device_id: raw.device_id,
    };
    // Only rewrite when it actually changed: this is the common path and it
    // runs on every command.
    if (apiBaseUrl !== undefined && raw.api_base_url !== apiBaseUrl) {
      await saveConfig(config, path);
    }
    return config;
  }

  const config: BuilderConfig = {
    ...DEFAULT_CONFIG,
    ...raw,
    api_base_url: resolved,
    device_id: newDeviceId(),
  };
  await saveConfig(config, path);
  return config;
}

export async function saveConfig(
  config: BuilderConfig,
  path: string = CONFIG_PATH,
): Promise<void> {
  await ensureBuilderDir(dirname(path));

  // An api_base_url that came from the environment must not become sticky.
  // Otherwise a one-off `BUILDER_API_URL=localhost:3241 builder publish` writes
  // localhost into the config permanently, and every later run silently talks
  // to a dev server that is no longer listening.
  const toWrite: BuilderConfig = { ...config };
  if (process.env.BUILDER_API_URL !== undefined && toWrite.api_base_url === process.env.BUILDER_API_URL) {
    delete (toWrite as Partial<BuilderConfig>).api_base_url;
  }

  await writeFile(path, `${JSON.stringify(toWrite, null, 2)}\n`, "utf8");
}

/**
 * Minted once per machine and persisted by `ensureConfig`.
 *
 * It identifies WHICH machine a score came from. It does not enable merging
 * counts across machines: the payload carries no day or commit identifiers by
 * design, so two devices each reporting 200 active days cannot be resolved into
 * 200 or 400. Uploads replace per device; they never sum.
 */
export function newDeviceId(): string {
  return `dev_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}
