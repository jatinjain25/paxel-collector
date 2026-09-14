import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The collector reaches exactly one host, from exactly one file.
 *
 * The README used to argue that the CLI structurally could not reach a cloud
 * provider, and the argument rested on there being no `fetch` anywhere in
 * packages/cli. Publishing needs one, so the guarantee is restated as something
 * a test can enforce rather than quietly abandoned.
 *
 * If this fails, do not add the file to the allowlist. Route the call through
 * api.ts, or the sentence in the README stops being true.
 */

const SRC = join(import.meta.dir, "..", "src");
const ALLOWED = new Set(["api.ts"]);
const NETWORK = /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(|from\s+["']node:(?:http|https|net|dgram|dns|tls)["']/;

async function sources(dir: string, prefix = ""): Promise<{ name: string; body: string }[]> {
  const out: { name: string; body: string }[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...(await sources(join(dir, entry.name), rel)));
    } else if (entry.name.endsWith(".ts")) {
      out.push({ name: rel, body: await readFile(join(dir, entry.name), "utf8") });
    }
  }
  return out;
}

describe("network confinement", () => {
  test("only api.ts can reach the network", async () => {
    const offenders = (await sources(SRC))
      .filter((f) => !ALLOWED.has(f.name))
      .filter((f) => NETWORK.test(f.body))
      .map((f) => f.name);
    expect(offenders).toEqual([]);
  });

  test("api.ts really is the one that does", async () => {
    const api = (await sources(SRC)).find((f) => f.name === "api.ts");
    expect(api).toBeDefined();
    expect(NETWORK.test(api?.body ?? "")).toBe(true);
  });

  test("no token is ever placed in a URL", async () => {
    // A token in a query string reaches access logs, CDNs and Referer headers.
    for (const f of await sources(SRC)) {
      expect(f.body, `${f.name} builds a URL with a token in it`).not.toMatch(
        /[?&](?:token|access_token|key|secret)=/,
      );
    }
  });

  test("the CLI depends on no HTTP client library", async () => {
    const pkg = JSON.parse(
      await readFile(join(import.meta.dir, "..", "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      expect(dep).not.toMatch(/axios|got|undici|node-fetch|superagent|ky$/);
    }
  });
});
