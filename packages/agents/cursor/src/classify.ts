import type { EventType } from "@builder/types";

/**
 * Cursor tool names → Doc 2 §4 event types.
 *
 * Cursor's vocabulary is entirely its own — `run_terminal_cmd` where Claude Code
 * says `Bash`, `search_replace` where it says `Edit`. Normalizing here is the
 * point of the event taxonomy: everything downstream sees `file_edit` and never
 * learns which editor produced it.
 *
 * Names are versioned in place (`read_file_v2`, `run_terminal_command_v2`), so
 * the suffix is stripped before lookup. Otherwise every Cursor release silently
 * moves tools into the unclassified bucket.
 */
const READ = new Set([
  "read_file", "codebase_search", "grep", "grep_search", "ripgrep_raw_search",
  "file_search", "glob_file_search", "list_dir", "semantic_search", "web_search",
  "fetch_rules", "read_lints",
]);
const WRITE = new Set(["create_file", "write", "write_file"]);
const EDIT = new Set([
  "edit_file", "search_replace", "apply_patch", "reapply", "multi_edit",
  // Deleting is a mutation of existing files, which is what file_edit covers in
  // Doc 2 §4's taxonomy; there is no dedicated delete type.
  "delete_file",
]);
const TERMINAL = new Set(["run_terminal_cmd", "run_terminal_command", "terminal"]);

/** Strip a trailing version suffix and any stray whitespace Cursor embeds. */
export function normalizeToolName(raw: string): string {
  return raw.split(/[\n\r]/)[0]!.trim().toLowerCase().replace(/_v\d+$/, "");
}

export function classifyCursorTool(name: string): EventType {
  const n = normalizeToolName(name);
  if (READ.has(n)) return "file_read";
  if (WRITE.has(n)) return "file_write";
  if (EDIT.has(n)) return "file_edit";
  if (TERMINAL.has(n)) return "terminal_command";
  return "tool_call";
}

/** MCP tools arrive as `mcp_<server>_<tool>`; the server is worth keeping. */
export function mcpNamespace(name: string): string | undefined {
  const m = /^mcp_([^_]+(?:-[^_]+)*)_/.exec(name);
  return m?.[1];
}

/** Cursor records the developer's accept/reject decision on proposed edits. */
export function isRejection(userDecision: unknown): boolean {
  return typeof userDecision === "string" && /reject|cancel|denied/i.test(userDecision);
}

/** Statuses that mean the tool did not succeed. */
export function isFailedStatus(status: unknown): boolean {
  return typeof status === "string" && /error|fail|cancel|abort/i.test(status);
}
