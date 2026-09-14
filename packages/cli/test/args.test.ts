import { describe, expect, test } from "bun:test";
import { parseArgs } from "../src/args.ts";

/**
 * The installer passed `--claim CODE` for two phases and the CLI silently
 * dropped it, because `flag()` only tested for presence and the command was
 * `args.find(a => !a.startsWith("-"))` — which happily returns an option's
 * value. One test at this level would have caught both.
 */
describe("parseArgs", () => {
  test("reads a value option in both spellings", () => {
    expect(parseArgs(["publish", "--api", "https://x.dev"]).option("api")).toBe("https://x.dev");
    expect(parseArgs(["publish", "--api=https://x.dev"]).option("api")).toBe("https://x.dev");
  });

  test("never mistakes an option value for the command", () => {
    // The live bug: the URL does not start with "-", so the old parser
    // returned it as the command and every run answered "unknown command".
    expect(parseArgs(["--api", "https://x.dev", "publish"]).command).toBe("publish");
    expect(parseArgs(["--api=https://x.dev", "publish"]).command).toBe("publish");
  });

  test("boolean flags stay boolean and carry no value", () => {
    const p = parseArgs(["analyze", "--yes", "--all-repos"]);
    expect(p.flag("yes")).toBe(true);
    expect(p.flag("all-repos")).toBe(true);
    expect(p.flag("api")).toBe(false);
    expect(p.option("yes")).toBeUndefined();
  });

  test("a value option with nothing after it is absent, not empty", () => {
    // `--api` alone must not resolve to "", which would be written to the
    // config as an api_base_url and turn every later request into a crash.
    expect(parseArgs(["publish", "--api"]).option("api")).toBeUndefined();
  });

  test("defaults to help with no arguments", () => {
    expect(parseArgs([]).command).toBe("help");
  });

  test("forget is dispatchable", () => {
    expect(parseArgs(["forget"]).command).toBe("forget");
  });
});
