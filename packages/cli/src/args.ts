/**
 * Argument parsing, hand-rolled for the same reason the rest of this CLI is:
 * it ships as a standalone binary that reads people's session history, and
 * every dependency is another thing a security-minded user has to audit.
 *
 * Its own module rather than living in `main.ts`, because `main.ts` runs the
 * CLI at import and a parser that cannot be tested without booting the program
 * is how `--claim CODE` shipped broken for two phases.
 */

/** Options that take a value. Everything else is a boolean flag. */
const VALUED = new Set(["api"]);

export interface Parsed {
  command: string;
  flag(name: string): boolean;
  option(name: string): string | undefined;
}

export function parseArgs(args: readonly string[]): Parsed {
  const values = new Map<string, string>();
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      values.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const name = arg.slice(2);
    if (VALUED.has(name)) {
      // Consume the next argument, so a URL is never left behind to be
      // mistaken for the command.
      values.set(name, args[i + 1] ?? "");
      i++;
      continue;
    }
    values.set(name, "");
  }

  return {
    command: positional[0] ?? "help",
    flag: (name) => values.has(name),
    option: (name) => {
      const v = values.get(name);
      // `--api` with nothing after it is absent, not empty: an empty string
      // would be written to the config and crash every later request.
      return v === undefined || v === "" ? undefined : v;
    },
  };
}
