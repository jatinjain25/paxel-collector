import type { EventType } from "@builder/types";
import { classifyCommand, type CommandFamily } from "@builder/agent-core";

// Re-exported so this module stays the one import site for the Claude adapter,
// which used to own both halves.
export { classifyCommand };
export type { CommandFamily };

/**
 * Doc 2 §4's taxonomy is semantic, but agents record mechanics: Claude Code
 * writes a `Bash` tool call, not a `test_run`. Classification bridges that gap.
 *
 * This runs on the LOCAL record, before the wire projection, which is the whole
 * reason it is safe: it reads the command string to decide `test_run` and emits
 * a `command_family` enum. The string itself never leaves the machine.
 */

const READ_TOOLS = new Set(["Read", "Glob", "Grep", "NotebookRead"]);
const WRITE_TOOLS = new Set(["Write"]);
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "NotebookEdit"]);
const SPAWN_TOOLS = new Set(["Agent", "Task"]);

/** Map a tool call to its Doc 2 §4 event type. */
export function classifyToolCall(toolName: string, commandFamily?: CommandFamily): EventType {
  if (READ_TOOLS.has(toolName)) return "file_read";
  if (WRITE_TOOLS.has(toolName)) return "file_write";
  if (EDIT_TOOLS.has(toolName)) return "file_edit";
  if (SPAWN_TOOLS.has(toolName)) return "agent_spawn";
  if (toolName === "Bash") {
    switch (commandFamily) {
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
  return "tool_call";
}

/** Claude Code writes these verbatim into user content when a turn is cancelled. */
export const INTERRUPT_SENTINELS = [
  "[Request interrupted by user]",
  "[Request interrupted by user for tool use]",
] as const;

export function isInterruptMarker(text: string): boolean {
  return INTERRUPT_SENTINELS.some((s) => text.includes(s));
}

/**
 * Doc 2 §6 steering — was this instruction a correction?
 *
 * Two signals, and the structural one is far stronger than the lexical one: an
 * instruction directly following an interrupt or a failed tool call is a
 * correction almost by definition. Phrasing is a weak fallback that misfires on
 * other languages and on polite users, so it only applies to short instructions
 * where a corrective opener is the whole message.
 */
const CORRECTION_OPENERS =
  /^\s*(no[,.! ]|nope\b|actually[,. ]|wait[,.! ]|stop\b|don'?t\b|revert\b|undo\b|that'?s (wrong|not)\b|instead[,. ])/i;

export function looksLikeCorrection(text: string, afterFailureOrInterrupt: boolean): boolean {
  if (afterFailureOrInterrupt) return true;
  return text.length <= 200 && CORRECTION_OPENERS.test(text);
}
