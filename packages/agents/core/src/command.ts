/**
 * Shell command -> `CommandFamily`, shared by every adapter.
 *
 * A command string is a command string: `bun test` means the same thing
 * whether Claude Code, opencode or anything else recorded it. This lived in
 * packages/agents/claude, so opencode could only have it by depending on
 * another adapter or by keeping a copy, and a copy is how two sources start
 * disagreeing about what counts as a test run. It classifies shell commands,
 * not Claude, so `agent-core` is where it belongs.
 *
 * It runs on the LOCAL record, before the wire projection, which is what makes
 * it safe: it reads the command string to decide `test_run` and emits an enum.
 * The string itself never leaves the machine.
 */

export type CommandFamily =
  | "inspect"
  | "test"
  | "git_commit"
  | "git_branch"
  | "git_checkout"
  | "deploy"
  | "build"
  | "package_manager"
  | "other";

const TEST_RUNNERS =
  /(^|[;&|\s])(pytest|jest|vitest|mocha|rspec|phpunit|tox|nose2?|ava|karma|cypress|playwright)\b|(^|[;&|\s])(go|cargo|dotnet|gradle|mvn|swift)\s+test\b|(^|[;&|\s])(npm|pnpm|yarn|bun|deno)\s+(run\s+)?test\b|(^|[;&|\s])make\s+test\b/;

const DEPLOY =
  /(^|[;&|\s])(vercel|netlify|flyctl|fly|wrangler|serverless|eb|heroku)\s+\S*\s*deploy\b|(^|[;&|\s])(vercel|netlify)\s+--prod\b|(^|[;&|\s])kubectl\s+apply\b|(^|[;&|\s])docker\s+push\b/;

const BUILD =
  /(^|[;&|\s])(npm|pnpm|yarn|bun|deno)\s+(run\s+)?build\b|(^|[;&|\s])(cargo|go|dotnet|gradle|mvn)\s+build\b|(^|[;&|\s])make\b(?!\s+test)/;

const PACKAGE_MANAGER =
  /(^|[;&|\s])(npm|pnpm|yarn|bun|pip|pip3|poetry|cargo|go|gem|composer)\s+(install|add|i|get|sync)\b/;

/**
 * Reading the codebase through the shell.
 *
 * This exists because read:edit ratio is otherwise a measure of TOOL CHOICE
 * rather than of care. Somebody who reads with the Read tool looks
 * research-first; somebody who reads the same files with `cat` and `sed -n`
 * looks edit-first, because every one of those lands in `other`. On one real
 * corpus that was 29,488 commands, and it dragged the ratio from research-first
 * to apparently degraded.
 *
 * That is the same defect the capability model exists to prevent — ranking
 * people by their tooling — so it is fixed the same way: classify what the
 * command actually did.
 */
const INSPECT =
  /(^|[;&|\s])(cat|bat|head|tail|less|more|wc|file|stat|tree)\s/.source +
  "|" +
  /(^|[;&|\s])(grep|rg|ag|ack)\s/.source +
  "|" +
  /(^|[;&|\s])(ls|find|fd)\s/.source +
  "|" +
  /(^|[;&|\s])sed\s+-n\b/.source +
  "|" +
  /(^|[;&|\s])git\s+(log|show|diff|status|blame)\b/.source;

const INSPECT_RE = new RegExp(INSPECT);

/**
 * Output redirection or a heredoc means the command WRITES, whatever it starts
 * with. `cat > file <<EOF` is how a file gets created from a shell, and reading
 * it as "looking around" would count writing as care — inverting the very
 * signal read:edit is meant to carry. `2>` and `>&` are error plumbing, not a
 * file being produced.
 */
const WRITES_FILE = /(^|[^0-9&>])>{1,2}(?![&>])|<<-?\s*['"\w]/;

export function classifyCommand(command: string): CommandFamily {
  // Order matters: `npm test` must not be caught by the package-manager rule,
  // and `git commit` must be distinguished from other git subcommands.
  if (TEST_RUNNERS.test(command)) return "test";
  if (/(^|[;&|\s])git\s+commit\b/.test(command)) return "git_commit";
  if (/(^|[;&|\s])git\s+(checkout|switch)\b/.test(command)) return "git_checkout";
  if (/(^|[;&|\s])git\s+branch\b/.test(command)) return "git_branch";
  if (DEPLOY.test(command)) return "deploy";
  if (BUILD.test(command)) return "build";
  if (PACKAGE_MANAGER.test(command)) return "package_manager";
  // Last of the specific rules: a command is only "looking around" if none of
  // the above claimed it, so `git commit` and `npm test` keep their families.
  if (INSPECT_RE.test(command) && !WRITES_FILE.test(command)) return "inspect";
  return "other";
}

/** Tools that only read. Used for Doc 2's planning/exploration ratio. */
export const EXPLORATION_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "NotebookRead",
  "WebFetch",
  "WebSearch",
  "ToolSearch",
  "ListAgents",
]);
