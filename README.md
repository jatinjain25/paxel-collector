# Builder — the collector

This is the part that runs on your machine.

It reads your local Claude Code, Cursor, Codex and opencode sessions plus git metadata, works out
how you build with AI coding agents, and — if you ask it to — sends measurements to a leaderboard.
You can read all of it here before you run any of it. That is the entire reason this repository
exists.

```bash
curl -fsSL <site>/run.sh | sh     # installs a standalone binary, checksum verified
builder discover                   # report what is detectable, analyse nothing
builder analyze                    # full local pipeline, prints your profile, uploads nothing
builder publish                    # scans, shows exactly what would be sent, asks
builder forget                     # deletes what was published
```

`builder analyze` needs no account, no network and no server. It is a complete local report.

## What leaves your machine

Counts and measurements. Never your source code, never your prompts, never a commit message.

- **Scoring is arithmetic, not a language model.** There is nothing to send to one.
- **The collector structurally cannot reach a cloud provider.** The guarantee is a missing
  dependency edge, not a runtime flag, and a test enforces it: exactly one file in `packages/cli`
  may touch the network (`packages/cli/test/network-confinement.test.ts`).
- **The wire projection is an allowlist.** `LocalEvent` is exactly `WireEvent` plus a single `local`
  key, so dropping local-only data is one omission an exhaustive test verifies
  (`packages/types/test/privacy.test.ts`).
- **Git is read for metadata only.** `git log --numstat`, never `-p`. Commit subjects are measured
  then discarded; author emails are SHA-256'd before they are counted.
- **Nothing is sent without being shown first.** `publish` prints the shape of the payload, the
  guarantee, and real samples from your own stream, then asks. Prompts read `/dev/tty`, never
  stdin, because under `curl | sh` stdin is the script itself. Silence is never consent.
- **Declining leaves nothing behind**, including the device registration that had to happen before
  the payload could be shown.

## What is not here

The server. The leaderboard, the claim flow, the scoring that runs on uploaded evidence, the
integrity checks that look for fabricated corpora, the database schema and the mail path all live
in a private repository.

That is a deliberate asymmetry, and worth stating plainly rather than leaving you to notice it. The
code that reads your machine is the code you are entitled to audit, so it is here. The code that
decides whether an upload looks fabricated is not, because publishing it would tell somebody
building a fake corpus exactly what is looked for.

## What you can check

- The score is computed on the server from evidence. This collector states no number, so there is
  none for it to have edited on the way out. `packages/derive` computes a local preview using the
  same pure functions the server runs, which is why the preview matches.
- The upload payload has no `score`, `composite`, `points` or `rank` field anywhere in its type,
  and `assertUploadSafe` rejects one if it appears at any depth.
- Adapters declare which of the signals they can observe. Scoring drops components whose signal was
  not observable and renormalises the rest, so a missing signal costs confidence, never points.
  Nobody is penalised for their editor.

## Running from source

Bun for development; the CLI also runs on Node. There is no build step — the TypeScript executes
directly.

```bash
bun install
bun test
bun run typecheck
bun packages/cli/src/main.ts analyze
```

## About this repository

Generated from the private monorepo, one way, at each release — this tree is cut from `72ab8f7`.
Nothing is edited here directly, so pull requests against it cannot be merged as-is; open an issue
instead and the fix will arrive on the next sync.

The binaries published in Releases are built by this repository's own CI from this source, so the
artifact the install line downloads is the code above.

MIT — see [LICENSE](LICENSE). The scoring anchors in `packages/scoring` are calibrated against a
very small population and say so in the code.
