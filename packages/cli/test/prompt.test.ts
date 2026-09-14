import { describe, expect, test } from "bun:test";
import { bar } from "../src/render.ts";
import { confirm, decide, hasTty, NoTerminalError } from "../src/prompt.ts";

describe("confirm", () => {
  test("--yes skips the prompt", async () => {
    expect(await confirm("proceed?", { assumeYes: true })).toBe(true);
  });

  test("refuses to proceed with no terminal", async () => {
    // The bug this prevents: under `curl | sh`, stdin is the script itself.
    // A prompt reading stdin would consume script bytes and return instantly,
    // so every confirmation would appear answered. For a tool that uploads data
    // and publishes a public profile, silent consent is the worst failure mode.
    if (await hasTty()) return; // meaningful only where no tty exists
    await expect(confirm("proceed?")).rejects.toThrow(NoTerminalError);
  });

  test("headless default can be opted into explicitly", async () => {
    if (await hasTty()) return;
    expect(await confirm("proceed?", { defaultWhenHeadless: true })).toBe(true);
  });
});

describe("bar", () => {
  test.each([
    [0, "░".repeat(20)],
    [100, "█".repeat(20)],
    [50, "█".repeat(10) + "░".repeat(10)],
  ])("renders %d correctly", (v, expected) => {
    expect(bar(v)).toBe(expected);
  });

  test("clamps out-of-range values", () => {
    expect(bar(-50)).toBe("░".repeat(20));
    expect(bar(500)).toBe("█".repeat(20));
  });
});

describe("the consent policy", () => {
  /**
   * `--yes` means "I know what this scans". It is not consent to put a score on
   * a public website, and `curl … | sh -s -- --yes` is exactly what people
   * paste into CI. Tested through `decide` rather than `confirm` so the
   * assertion holds on a developer's machine, where /dev/tty is open and a real
   * `confirm` would block waiting for a keypress.
   */
  test.each([true, false])("--yes never publishes (tty: %p)", (tty) => {
    expect(decide({ assumeYes: true, irreversible: true }, tty)).toBe(tty ? "ask" : "refuse");
  });

  test.each([true, false])("a headless default never publishes either (tty: %p)", (tty) => {
    expect(decide({ defaultWhenHeadless: true, irreversible: true }, tty)).toBe(
      tty ? "ask" : "refuse",
    );
  });

  test("--yes still answers an ordinary prompt", () => {
    expect(decide({ assumeYes: true }, false)).toBe("yes");
    expect(decide({ assumeYes: true }, true)).toBe("yes");
  });

  test("silence is never consent", () => {
    expect(decide({}, false)).toBe("refuse");
  });

  test("a terminal is always asked, never assumed", () => {
    expect(decide({}, true)).toBe("ask");
    expect(decide({ irreversible: true }, true)).toBe("ask");
  });

  test("the refusal explains why --yes did not work", async () => {
    const err = await confirm("publish?", { assumeYes: true, irreversible: true })
      .then(() => undefined)
      .catch((e: unknown) => e as Error);
    // Only meaningful where confirm actually reached the refusal branch.
    if (err === undefined) return;
    expect(err).toBeInstanceOf(NoTerminalError);
    expect(err.message).toContain("--yes");
    expect(err.message).toContain("public");
  });
});
