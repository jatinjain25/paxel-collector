/**
 * Compile the collector into standalone binaries.
 *
 * `bun build --compile` embeds the Bun runtime, so each artifact is 50-100 MB.
 * That is real friction for a one-line install over a hotel connection, and it
 * is why these go to GitHub Releases rather than into the site's public
 * directory: four targets would exceed a Vercel deployment on their own.
 *
 * Usage:  bun run infra/build-binaries.ts [--host]
 *         --host  build only this machine's target, which takes seconds
 */
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const TARGETS = [
  { target: "bun-darwin-arm64", name: "builder-darwin-arm64" },
  { target: "bun-darwin-x64", name: "builder-darwin-x64" },
  { target: "bun-linux-x64", name: "builder-linux-x64" },
  { target: "bun-linux-arm64", name: "builder-linux-arm64" },
] as const;

const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, "dist");
const ENTRY = join(ROOT, "packages/cli/src/main.ts");

function hostTarget(): string {
  const os = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `builder-${os}-${arch}`;
}

const hostOnly = process.argv.includes("--host");
const wanted = hostOnly ? TARGETS.filter((t) => t.name === hostTarget()) : TARGETS;

await mkdir(OUT, { recursive: true });

for (const { target, name } of wanted) {
  const started = Date.now();
  const proc = Bun.spawn(
    ["bun", "build", "--compile", `--target=${target}`, ENTRY, "--outfile", join(OUT, name)],
    { cwd: ROOT, stdout: "inherit", stderr: "inherit" },
  );
  const code = await proc.exited;
  if (code !== 0) {
    process.stderr.write(`\nbuild failed for ${target}\n`);
    process.exit(1);
  }
  process.stdout.write(`  ${name}  ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
}

/**
 * A checksum file the installer verifies before it runs anything.
 *
 * Without this, `curl | sh` trusts whatever the network returns. With it, a
 * corrupted or substituted download stops the install rather than executing.
 */
const lines: string[] = [];
for (const entry of (await readdir(OUT)).sort()) {
  if (entry === "SHA256SUMS") continue;
  const bytes = await Bun.file(join(OUT, entry)).arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  lines.push(`${hex}  ${entry}`);
  process.stdout.write(`  ${hex.slice(0, 16)}…  ${entry}  ${(bytes.byteLength / 1e6).toFixed(1)} MB\n`);
}
await writeFile(join(OUT, "SHA256SUMS"), `${lines.join("\n")}\n`);
process.stdout.write(`\nwrote ${OUT}/SHA256SUMS\n`);
