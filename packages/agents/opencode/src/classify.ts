import type { EventType } from "@builder/types";
import type { CommandFamily } from "@builder/agent-core";

/**
 * opencode tool names -> Doc 2 §4 event types.
 *
 * Its vocabulary is its own again: `edit` where Claude Code says `Edit`,
 * `bash` where it says `Bash`, `todowrite` where it says `TodoWrite`. Verified
 * against the real store, where the whole set is: bash, read, edit, grep,
 * webfetch, glob, write, todowrite, task, question, skill, websearch, invalid.
 */
const READ = new Set(["read", "grep", "glob", "list", "webfetch", "websearch", "question"]);
const WRITE = new Set(["write"]);
const EDIT = new Set(["edit", "patch", "multiedit"]);
const SPAWN = new Set(["task", "agent", "subagent"]);

export function normalizeToolName(raw: string): string {
  return raw.trim().toLowerCase();
}

export function classifyOpencodeTool(name: string, family?: CommandFamily): EventType {
  const n = normalizeToolName(name);
  if (n === "bash") {
    switch (family) {
      case "test":
        return "test_run";
      case "git_commit":
        return "git_commit";
      case "git_branch":
        return "git_branch";
      case "git_checkout":
        return "git_checkout";
      case "deploy":
        return "deployment";
      default:
        return "terminal_command";
    }
  }
  if (READ.has(n)) return "file_read";
  if (WRITE.has(n)) return "file_write";
  if (EDIT.has(n)) return "file_edit";
  if (SPAWN.has(n)) return "agent_spawn";
  // `todowrite` is planning, not a file write. Misclassifying it as file_write
  // would credit somebody for editing files they never touched.
  if (n === "todowrite" || n === "todoread") return "tool_call";
  return "tool_call";
}
