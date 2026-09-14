import { open } from "node:fs/promises";

/**
 * Confirmation prompts that survive `curl … | sh`.
 *
 * When the installer is piped into a shell, stdin is the pipe carrying the
 * script, not the keyboard. A prompt reading stdin would consume script bytes
 * and return immediately — every confirmation would appear to pass without
 * anyone answering them. For a tool that uploads data and publishes a public
 * profile, that is the worst available bug, so prompts read /dev/tty directly.
 *
 * When there is no terminal at all, the answer is NO. Silence is never consent.
 */

export class NoTerminalError extends Error {
  override readonly name = "NoTerminalError";
}

export async function hasTty(): Promise<boolean> {
  try {
    const fh = await open("/dev/tty", "r");
    await fh.close();
    return true;
  } catch {
    return false;
  }
}

/** Read one line from the controlling terminal, never from stdin. */
export async function readLineFromTty(): Promise<string> {
  const fh = await open("/dev/tty", "r");
  try {
    const buf = Buffer.alloc(4096);
    const { bytesRead } = await fh.read(buf, 0, buf.length, null);
    return buf.subarray(0, bytesRead).toString("utf8").trim();
  } finally {
    await fh.close();
  }
}

export interface ConfirmOptions {
  /** Used when no terminal exists. Defaults to false — never assume yes. */
  defaultWhenHeadless?: boolean;
  /** Skip the prompt entirely, e.g. an explicit --yes flag. */
  assumeYes?: boolean;
  /**
   * This action cannot be undone from the outside, so `assumeYes` does not
   * satisfy it and a missing terminal is fatal rather than defaultable.
   *
   * Publishing is the case this exists for. `--yes` is a convenience for "I
   * know what this scans"; it is not consent to put a score on a public
   * website. Without this distinction `curl … | sh -s -- --yes`, which is
   * exactly what people paste into CI, would publish silently, and "it uploaded
   * without asking me" is the worst headline this product can earn.
   */
  irreversible?: boolean;
}

/** What a prompt should do, given its options and whether a terminal exists. */
export type PromptDecision = "yes" | "ask" | "refuse";

/**
 * The whole consent policy, as a pure function.
 *
 * Extracted from `confirm` so it can be tested exhaustively without a terminal.
 * The alternative was guarding every test with `if (await hasTty()) return`,
 * which silently skips exactly the assertion that matters most on exactly the
 * machines where a developer runs the suite.
 */
export function decide(options: ConfirmOptions, ttyAvailable: boolean): PromptDecision {
  const irreversible = options.irreversible === true;
  if (options.assumeYes === true && !irreversible) return "yes";
  if (ttyAvailable) return "ask";
  if (options.defaultWhenHeadless === true && !irreversible) return "yes";
  return "refuse";
}

export async function confirm(question: string, options: ConfirmOptions = {}): Promise<boolean> {
  const decision = decide(options, await hasTty());

  if (decision === "yes") {
    const why = options.assumeYes === true ? "  (--yes)" : "";
    process.stdout.write(`${question} [y/N] y${why}\n`);
    return true;
  }

  if (decision === "refuse") {
    throw new NoTerminalError(
      options.irreversible === true
        ? "No terminal available to confirm publishing. This step cannot be skipped with --yes, " +
          "because it puts a score on a public website. Re-run in an interactive shell."
        : "No terminal available to confirm. Refusing to continue without an answer — " +
          "re-run in an interactive shell, or pass --yes if you intend to skip the prompt.",
    );
  }

  process.stdout.write(`${question} [y/N] `);
  return /^y(es)?$/i.test(await readLineFromTty());
}
