#!/usr/bin/env node
import { analyze, type AnalyzeResult } from "./analyze.ts";
import { ApiClient, ApiRequestError } from "./api.ts";
import { parseArgs } from "./args.ts";
import { rm } from "node:fs/promises";
import { BUILDER_DIR, ensureConfig, readSecret, TOKEN_PATH } from "./config.ts";
import { confirm, NoTerminalError } from "./prompt.ts";
import { renderProfile } from "./render.ts";
import {
  buildPayload,
  deterministicUploadId,
  ensureDevice,
  newSessionsOnly,
  previewPayload,
  publish,
} from "./upload.ts";
import { collectAll, type CollectionSummary } from "@builder/discovery";
import { CLIENT_VERSION } from "./version.ts";

/**
 * `builder` — the collector CLI.
 *
 * Argument parsing is hand-rolled deliberately: this ships as a standalone
 * binary that reads people's session history, and every dependency is another
 * thing a security-minded user has to audit before trusting it.
 */

const USAGE = `builder ${CLIENT_VERSION}

  builder discover        show what would be analyzed, and analyze nothing
  builder analyze         analyze locally and print your profile
  builder status          show local configuration
  builder publish         publish your score to the leaderboard
  builder claim           put your name on a published score
  builder unlink          take this machine off your profile, keep the evidence
  builder forget          delete this machine's evidence and score

Options
  --all-repos             scan the whole machine for git repositories
  --yes                   skip the scope confirmation (never the publish one)
  --api URL               the service to talk to, remembered for later runs
  --help
`;

async function main(argv: string[]): Promise<number> {
  const { command, flag, option } = parseArgs(argv.slice(2));
  const api = option("api");

  if (flag("help") || command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }

  switch (command) {
    case "discover":
      return discover(flag("all-repos"));
    case "analyze":
      return runAnalyze(flag("all-repos"), flag("yes"));
    case "status":
      return status(api);
    case "publish":
    case "upload":
      return runPublish(flag("all-repos"), flag("yes"), api);
    case "claim":
      return runClaim(api);
    case "unlink":
      return runUnlink(api);
    case "forget":
      return runForget(api);
    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

/** Doc 2 §3 — report what was detected before processing anything. */
async function discover(allRepos: boolean): Promise<number> {
  const t0 = Date.now();
  const c = await collectAll({ scanRepos: allRepos, onProgress: note });
  process.stdout.write("\n");
  for (const s of c.sources) {
    const unverified = s.verified ? "" : "  (unverified adapter)";
    process.stdout.write(
      `  ${s.source.padEnd(16)} ${String(s.sessions).padStart(4)} sessions  ` +
        `${s.events.toLocaleString().padStart(9)} events${unverified}\n`,
    );
  }
  process.stdout.write(
    `\n  ${c.projects} projects · ${c.repos} repositories · ${c.commits.length} commits\n` +
      `  ${c.observed_signals.length} signals observable · ${((Date.now() - t0) / 1000).toFixed(1)}s\n\n` +
      `  Nothing was uploaded. Run 'builder analyze' to score locally.\n\n`,
  );
  return 0;
}

async function runAnalyze(allRepos: boolean, yes: boolean): Promise<number> {
  const config = await ensureConfig();
  note("discovering sources");
  const c = await collectAll({ scanRepos: allRepos, onProgress: note });

  if (c.sessions.length === 0) {
    process.stderr.write("\n  No agent sessions found on this machine.\n\n");
    return 1;
  }

  printSources(c);

  // Doc 2 §9 — the user confirms scope before processing.
  const proceed = await confirm("  Analyze this evidence?", { assumeYes: yes });
  if (!proceed) {
    process.stdout.write("\n  Cancelled. Nothing was analyzed.\n\n");
    return 0;
  }

  // Reuse the evidence already gathered above. Collecting again would re-parse
  // the entire corpus to produce a byte-identical result.
  const result = await analyze({
    scanRepos: allRepos,
    onProgress: note,
    collection: c,
    ...(config.builder_id !== undefined && { builderId: config.builder_id }),
  });

  printProfile(result);
  process.stdout.write("  Everything above was computed on this machine. Nothing was uploaded.\n\n");
  return 0;
}

function printProfile(result: AnalyzeResult): void {
  process.stdout.write(
    renderProfile({
      record: result.record,
      sources: result.collection.sources.map((s) => ({
        source: s.source,
        sessions: s.sessions,
        events: s.events,
      })),
      episodes: result.episodes,
      commits: result.collection.commits.length,
      repos: result.collection.repos,
      missingSignals: result.missingSignals,
    }),
  );
}

/**
 * Scan, score, show exactly what would be sent, ask, and only then publish.
 *
 * The confirmation is `irreversible`, so `--yes` cannot answer it. `--yes` means
 * "I know what this scans"; it is not consent to put a score on a public
 * website, and `curl … | sh -s -- --yes` is exactly what ends up in CI.
 */
async function runPublish(allRepos: boolean, yes: boolean, api?: string): Promise<number> {
  const config = await ensureConfig(undefined, api);
  const client = new ApiClient(config.api_base_url);

  note("discovering sources");
  const c: CollectionSummary = await collectAll({ scanRepos: allRepos, onProgress: note });
  if (c.sessions.length === 0) {
    process.stderr.write("\n  No agent sessions found on this machine.\n\n");
    return 1;
  }

  printSources(c);
  if (!(await confirm("  Analyze this evidence?", { assumeYes: yes }))) {
    process.stdout.write("\n  Cancelled. Nothing was analyzed.\n\n");
    return 0;
  }

  const result = await analyze({ scanRepos: allRepos, onProgress: note, collection: c });
  printProfile(result);

  const { credentials, registered, nonce } = await ensureDevice(client, config);

  // Only what the server has not already accepted. The first publish sends a
  // whole history; every later one sends a handful of sessions.
  const known = new Set(await client.knownSessions(credentials.device_token));
  const fresh = newSessionsOnly(c, known);

  if (fresh.sessions.length === 0) {
    process.stdout.write("\n  Nothing new since your last publish.\n\n");
    return 0;
  }

  const slice = { ...c, sessions: fresh.sessions, events: fresh.events };
  const uploadId = await deterministicUploadId(credentials.device_id, slice);
  const payload = buildPayload(credentials, slice, uploadId, Date.now(), result.missingSignals);

  // 109,000 events cannot be shown, so this shows the shape, the guarantee, and
  // real samples — enough for somebody to see for themselves that there is no
  // text in them.
  process.stdout.write(`\n${previewPayload(payload, fresh.skipped)}\n`);
  if (registered) process.stdout.write(`  This machine registered as ${credentials.device_id}.\n`);

  // Declining must leave nothing behind, including the registration that had
  // to happen before the payload could be shown. Without this, "nothing left
  // this machine" was false: a device row stayed on the server, created by
  // somebody who then said no.
  const ok = await confirm("\n  Publish this score to the public leaderboard?", {
    assumeYes: yes,
    irreversible: true,
  }).catch(async (err: unknown) => {
    if (registered) await forget(client, credentials.device_token);
    throw err;
  });

  if (!ok) {
    if (registered) await forget(client, credentials.device_token);
    process.stdout.write("\n  Not published. Nothing about your work left this machine.\n\n");
    return 0;
  }

  const res = await publish({ client, credentials, payload, nonce });
  const verb = res.status === "duplicate" ? "already published" : "published";
  process.stdout.write(
    `\n  ${verb}: ${res.proof_score.toLocaleString()}` +
      (res.ranked_population > 0
        ? `  ·  that would rank you ${ordinal(res.provisional_rank)} of ${res.ranked_population}\n`
        : "\n") +
      (res.claimed
        ? `  Your profile: @${res.handle ?? ""}\n\n`
        : claimLines(config.api_base_url, res.claim)),
  );
  return 0;
}

/**
 * Mint a fresh claim code.
 *
 * Minted on demand rather than handed out at upload, because the code is the
 * only secret this tool ever prints. One that lives forever sits in scrollback,
 * screenshots and CI logs and cannot be rotated; this one dies in ten minutes
 * and can always be replaced, from a device token that is never displayed.
 */
async function runClaim(api?: string): Promise<number> {
  const config = await ensureConfig(undefined, api);
  const client = new ApiClient(config.api_base_url);
  const token = await readSecret(TOKEN_PATH);

  if (token === undefined) {
    process.stderr.write("\n  This machine has not published anything yet. Run 'builder publish'.\n\n");
    return 1;
  }

  const res = await client.startClaim(token);
  if (res.already_claimed === true) {
    process.stdout.write("\n  This machine is already claimed.\n\n");
    return 0;
  }

  const minutes = Math.round(((res.expires_at ?? Date.now()) - Date.now()) / 60_000);
  process.stdout.write(
    `\n  Claim your score at  ${config.api_base_url}/claim/${(res.code ?? "").replace("-", "")}\n` +
      `  Your code            ${res.code ?? ""}   (expires in ${minutes} minutes)\n\n` +
      "  Lost it? Run 'builder claim' again for a new one.\n\n",
  );
  return 0;
}

/**
 * Delete this machine's evidence and score, on request.
 *
 * Every welcome mail has told people to run this since Phase 6, and until now
 * it answered `unknown command: forget`. Telling somebody how to withdraw and
 * then not implementing it is the worst version of this to get wrong.
 *
 * Unlike the private `forget` below — which cleans up after a declined publish
 * and must stay silent — this one reports what happened. A deletion that
 * quietly failed would leave a score on a public board that its owner believes
 * is gone.
 */
/**
 * Detach this machine, keeping what it sent.
 *
 * The narrower of the two withdrawals, and the one the hazard list describes:
 * publishing from a fresh VM replaces the score earned on your own machine,
 * and until now the only remedy was destroying that evidence outright.
 *
 * Not `irreversible`: unlinking deletes nothing, and a machine can be claimed
 * again. Reserving that prompt for the things that cannot be undone is what
 * keeps it meaning something.
 */
async function runUnlink(api?: string): Promise<number> {
  const config = await ensureConfig(undefined, api);
  const token = await readSecret(TOKEN_PATH);

  if (token === undefined) {
    process.stdout.write("\n  Nothing was ever published from this machine.\n\n");
    return 0;
  }

  const ok = await confirm("\n  Take this machine off your public profile?");
  if (!ok) {
    process.stdout.write("\n  Cancelled. Nothing changed.\n\n");
    return 0;
  }

  let unlinked: boolean;
  try {
    ({ unlinked } = await new ApiClient(config.api_base_url).unlinkDevice(token));
  } catch (err) {
    const detail = err instanceof ApiRequestError ? err.message : String(err);
    process.stderr.write(`\n  Could not reach ${config.api_base_url}: ${detail}\n\n`);
    return 1;
  }

  if (!unlinked) {
    process.stdout.write("\n  This machine was not attached to a profile. Nothing changed.\n\n");
    return 0;
  }

  process.stdout.write(
    "\n  Unlinked. This machine's score no longer appears under your handle.\n\n" +
      "  The evidence is still here, measured anonymously, and is deleted after\n" +
      "  thirty days unless it is claimed again. To remove it now, run\n" +
      "  `builder forget`.\n\n",
  );
  return 0;
}

async function runForget(api?: string): Promise<number> {
  const config = await ensureConfig(undefined, api);
  const token = await readSecret(TOKEN_PATH);

  if (token === undefined) {
    await rm(BUILDER_DIR, { recursive: true, force: true });
    process.stdout.write(
      "\n  Nothing was ever published from this machine.\n" +
        "  Local state in ~/.builder has been removed.\n\n",
    );
    return 0;
  }

  const ok = await confirm(
    "\n  Delete this machine's evidence and its published score?",
    { irreversible: true },
  );
  if (!ok) {
    process.stdout.write("\n  Cancelled. Nothing was removed.\n\n");
    return 0;
  }

  // The server first. Removing ~/.builder first would discard the only token
  // that can prove which device to delete, stranding the score permanently.
  try {
    await new ApiClient(config.api_base_url).forgetDevice(token);
  } catch (err) {
    const detail = err instanceof ApiRequestError ? err.message : String(err);
    process.stderr.write(
      `\n  Could not reach ${config.api_base_url}: ${detail}\n` +
        "  Nothing was deleted. Your local state was left in place so you can retry.\n\n",
    );
    return 1;
  }

  await rm(BUILDER_DIR, { recursive: true, force: true });
  process.stdout.write(
    "\n  Deleted. This machine's sessions, events and score are gone from the\n" +
      "  server, and the profile no longer appears on the leaderboard.\n\n" +
      "  If this was the last machine on your profile, the handle and the email\n" +
      "  address went with it and the handle is free for somebody else. Another\n" +
      "  machine still publishing keeps the profile alive; run this there too.\n\n",
  );
  return 0;
}

/**
 * Undo a registration the user then declined.
 *
 * Best effort. Failing to clean up must not turn a polite "no" into an error,
 * and the row expires on its own regardless.
 */
async function forget(client: ApiClient, token: string): Promise<void> {
  try {
    await client.forgetDevice(token);
    await rm(BUILDER_DIR, { recursive: true, force: true });
  } catch {
    // Nothing the person can act on.
  }
}

/**
 * The claim link, printed with the score rather than after a second command.
 *
 * Publishing used to end in "now run `builder claim`", which is a step for no
 * reason: the code is ten minutes and single-use whether it is minted with the
 * upload or forty seconds later.
 */
function claimLines(baseUrl: string, claim?: { code: string; expires_at: number }): string {
  if (claim === undefined) {
    return "\n  Measured anonymously. Run 'builder claim' to put your name on it.\n\n";
  }
  const minutes = Math.max(1, Math.round((claim.expires_at - Date.now()) / 60_000));
  return (
    `\n  Claim it at  ${baseUrl}/claim/${claim.code.replace("-", "")}\n` +
    `  Your code    ${claim.code}   (expires in ${minutes} minutes)\n\n`
  );
}

function printSources(c: CollectionSummary): void {
  process.stdout.write("\n");
  for (const s of c.sources) {
    process.stdout.write(
      `  ${s.source.padEnd(16)} ${String(s.sessions).padStart(4)} sessions  ${s.events.toLocaleString().padStart(9)} events\n`,
    );
  }
  process.stdout.write(`  ${c.projects} projects · ${c.repos} repositories\n\n`);
}

function ordinal(n: number): string {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return `${n}${suffix}`;
}

async function status(api?: string): Promise<number> {
  const config = await ensureConfig(undefined, api);
  process.stdout.write(
    `\n  client        ${CLIENT_VERSION}\n` +
      `  builder id    ${config.builder_id ?? "(not registered)"}\n` +
      `  device id     ${config.device_id}\n` +
      `  api           ${config.api_base_url}\n` +
      `  repo reading  ${config.repo_analysis_enabled ? "enabled" : "disabled"}\n` +
      `  deep analysis ${config.deep_analysis_enabled ? "enabled" : "disabled"}\n\n`,
  );
  return 0;
}

function note(message: string): void {
  if (process.stdout.isTTY) process.stdout.write(`\r  ${message}...`.padEnd(60));
}

main(process.argv)
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    if (err instanceof NoTerminalError) {
      process.stderr.write(`\n  ${err.message}\n\n`);
      process.exit(3);
    }
    if (err instanceof ApiRequestError) {
      process.stderr.write(`\n  ${err.message}\n\n`);
      process.exit(4);
    }
    process.stderr.write(`\n  ${err instanceof Error ? err.message : String(err)}\n\n`);
    process.exit(1);
  });
