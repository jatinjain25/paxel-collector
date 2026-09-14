import { describe, expect, test } from "bun:test";
import { REQUIRED_SIGNALS } from "@builder/types";
import {
  classifyCursorTool,
  CURSOR_CAPABILITIES,
  CursorAdapter,
  isFailedStatus,
  isRejection,
  mcpNamespace,
  normalizeToolName,
  plausibleEpochMs,
} from "../src/index.ts";

describe("tool classification", () => {
  test.each([
    ["read_file", "file_read"], ["grep", "file_read"], ["grep_search", "file_read"],
    ["glob_file_search", "file_read"], ["ripgrep_raw_search", "file_read"], ["list_dir", "file_read"],
    ["search_replace", "file_edit"], ["edit_file", "file_edit"], ["apply_patch", "file_edit"],
    ["delete_file", "file_edit"], ["write", "file_write"], ["run_terminal_cmd", "terminal_command"],
    ["todo_write", "tool_call"],
  ])("maps %s to %s", (name, expected) => {
    expect(classifyCursorTool(name)).toBe(expected as never);
  });

  test("strips version suffixes so releases do not break classification", () => {
    // Both were landing in the unclassified bucket before normalization.
    expect(classifyCursorTool("read_file_v2")).toBe("file_read");
    expect(classifyCursorTool("run_terminal_command_v2")).toBe("terminal_command");
    expect(normalizeToolName("read_file_v10")).toBe("read_file");
  });

  test("tolerates embedded newlines in a name", () => {
    // Observed in real data: a name field containing a name plus stray params.
    expect(classifyCursorTool("search_replace\n_file_path\nREADME.md")).toBe("file_edit");
  });

  test("extracts the MCP server name", () => {
    expect(mcpNamespace("mcp_cursor-ide-browser_browser_navigate")).toBe("cursor-ide-browser");
    expect(mcpNamespace("read_file")).toBeUndefined();
  });
});

describe("status interpretation", () => {
  test.each(["error", "failed", "cancelled", "aborted"])("%s is a failure", (s) => {
    expect(isFailedStatus(s)).toBe(true);
  });
  test("completed is not a failure", () => {
    expect(isFailedStatus("completed")).toBe(false);
  });
  test.each(["rejected", "user_rejected", "cancelled"])("%s is a rejection", (d) => {
    expect(isRejection(d)).toBe(true);
  });
  test("accepted is not a rejection", () => {
    expect(isRejection("accepted")).toBe(false);
  });
});

describe("capabilities", () => {
  test("declares the required signals", () => {
    for (const s of REQUIRED_SIGNALS) expect(CURSOR_CAPABILITIES.has(s)).toBe(true);
  });

  test("does not claim interrupts", () => {
    // Cursor has no equivalent of Claude Code's interrupt sentinel. Claiming it
    // would make every Cursor user's interrupt count a real zero.
    expect(CURSOR_CAPABILITIES.has("interrupts")).toBe(false);
  });

  test("does not claim per-event timing", () => {
    // Only ~9% of real messages carry a timestamp; the rest are interpolated
    // from conversation bounds. Ordering is real, durations are not.
    expect(CURSOR_CAPABILITIES.has("event_timing")).toBe(false);
  });

  test("does claim what it genuinely records", () => {
    for (const s of ["tool_calls", "file_paths", "commands", "permission_denials"] as const) {
      expect(CURSOR_CAPABILITIES.has(s)).toBe(true);
    }
  });
});

const adapter = new CursorAdapter();
const installed = await adapter.detect();
// Hoisted: describe() callbacks cannot be async.
const projects = installed ? await adapter.discover() : [];

describe.if(installed)("against the real Cursor store", () => {

  test("discovers projects with decoded paths", () => {
    expect(projects.length).toBeGreaterThan(0);
    const withPaths = projects.filter((p) => p.path);
    expect(withPaths.length).toBeGreaterThan(0);
    // Paths arrive URL-encoded; a space must survive as a space or it will never
    // match a git root.
    for (const p of withPaths) expect(p.path).not.toContain("%20");
  });

  test("skips composers with no conversation", () => {
    // 88 of 101 composers on a real machine are empty shells.
    for (const p of projects) expect(p.session_refs.length).toBeGreaterThan(0);
  });

  test("emits no tool event without an identified tool", async () => {
    // The bug this pins: 723 toolFormerData objects carry only additionalData
    // and are not tool calls. Emitting events for them inflated tool_call_count
    // by 43% and corrupted every ratio built on it.
    let toolEvents = 0;
    let unknown = 0;
    for (const p of projects.slice(0, 4)) {
      for (const ref of p.session_refs) {
        const parsed = await adapter.parseSession(ref, p);
        if (!parsed) continue;
        for (const e of parsed.events) {
          if (!e.metadata.tool_name) continue;
          toolEvents++;
          if (e.metadata.tool_name === "unknown") unknown++;
        }
      }
    }
    expect(toolEvents).toBeGreaterThan(0);
    expect(unknown).toBe(0);
  });

  test("tool calls and results pair up", async () => {
    const p = projects.find((x) => x.session_refs.length > 0)!;
    const parsed = await adapter.parseSession(p.session_refs[0]!, p);
    if (!parsed) return;
    const calls = parsed.events.filter((e) => e.actor === "agent" && e.metadata.tool_name);
    const results = parsed.events.filter((e) => e.actor === "tool");
    expect(results.length).toBe(calls.length);
  });

  test("timestamps are ordered and inside the conversation window", async () => {
    const p = projects.find((x) => x.session_refs.length > 0)!;
    const parsed = await adapter.parseSession(p.session_refs[0]!, p);
    if (!parsed) return;
    const ts = parsed.events.map((e) => e.timestamp);
    expect(Math.min(...ts)).toBeGreaterThanOrEqual(parsed.session.started_at);
    expect(Math.max(...ts)).toBeLessThanOrEqual(parsed.session.ended_at);
  });
});

describe.if(!installed)("against the real Cursor store", () => {
  test.skip("Cursor is not installed on this machine", () => {});
});

describe("timestamp plausibility", () => {
  test("rejects relative timings masquerading as epoch ms", () => {
    // Real values from Cursor's timingInfo.clientStartTime. They look like
    // timestamps and are performance counters; trusting them put 45 events in
    // 1970 and stretched the observation window to 20,706 days.
    for (const v of [18596.69999998808, 94963.09999996424, 158778, 205822.1]) {
      expect(plausibleEpochMs(v)).toBeUndefined();
    }
  });

  test("accepts a real epoch millisecond value", () => {
    const t = Date.parse("2026-06-11T10:00:00Z");
    expect(plausibleEpochMs(t)).toBe(t);
  });

  test("rejects future timestamps", () => {
    expect(plausibleEpochMs(Date.now() + 30 * 86_400_000)).toBeUndefined();
  });

  test.each([null, undefined, "2026-01-01", Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects non-numeric input %p",
    (v) => {
      expect(plausibleEpochMs(v)).toBeUndefined();
    },
  );
});
