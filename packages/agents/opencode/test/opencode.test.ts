import { describe, expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { assertUploadSafe, toWire, type LocalEvent } from "@builder/types";
import { OPENCODE_DB, OpencodeAdapter } from "../src/adapter.ts";
import { classifyOpencodeTool } from "../src/classify.ts";

describe("classifyOpencodeTool", () => {
  test.each([
    ["read", undefined, "file_read"],
    ["grep", undefined, "file_read"],
    ["write", undefined, "file_write"],
    ["edit", undefined, "file_edit"],
    ["task", undefined, "agent_spawn"],
    ["bash", undefined, "terminal_command"],
    ["bash", "test", "test_run"],
    ["bash", "git_commit", "git_commit"],
    ["bash", "deploy", "deployment"],
  ] as const)("%s/%s -> %s", (tool, family, expected) => {
    expect(classifyOpencodeTool(tool, family as never)).toBe(expected);
  });

  test("todowrite is planning, not a file write", () => {
    // Classifying it as file_write would credit somebody for editing files
    // they never touched.
    expect(classifyOpencodeTool("todowrite")).toBe("tool_call");
  });

  test("names are matched case-insensitively", () => {
    expect(classifyOpencodeTool("Read")).toBe("file_read");
  });
});

/**
 * Against the real store, because every adapter in this repo written without
 * real data has needed correction. Skips cleanly where opencode is absent.
 */
const hasStore = await stat(OPENCODE_DB).then(() => true).catch(() => false);

describe.if(hasStore)("against a real opencode store", () => {
  const adapter = new OpencodeAdapter();

  async function everything(): Promise<LocalEvent[]> {
    const out: LocalEvent[] = [];
    for (const project of await adapter.discover()) {
      for (const ref of project.session_refs) {
        const parsed = await adapter.parseSession(ref, project);
        if (parsed !== undefined) out.push(...parsed.events);
      }
    }
    return out;
  }

  test("detects and discovers projects", async () => {
    expect(await adapter.detect()).toBe(true);
    const projects = await adapter.discover();
    expect(projects.length).toBeGreaterThan(0);
    expect(projects.some((p) => p.session_refs.length > 0)).toBe(true);
  });

  test("parses without malformed records", async () => {
    const [project] = await adapter.discover();
    const parsed = await adapter.parseSession(project!.session_refs[0]!, project!);
    expect(parsed).toBeDefined();
    expect(parsed!.stats.malformed).toBe(0);
  });

  test("every tool use is exactly one invocation and one result", async () => {
    // The invariant the whole taxonomy rests on: Doc 2 §4 names the action, not
    // the direction, so counting by event_type alone double-counts every tool
    // use. This is the check that caught it in Claude Code.
    const pairs = new Map<string, { calls: number; results: number }>();
    for (const e of await everything()) {
      if (e.correlation_id === undefined) continue;
      const key = `${e.session_id}:${e.correlation_id}`;
      const c = pairs.get(key) ?? { calls: 0, results: 0 };
      if (e.actor === "agent") c.calls++;
      if (e.actor === "tool") c.results++;
      pairs.set(key, c);
    }
    expect(pairs.size).toBeGreaterThan(100);
    expect([...pairs.values()].filter((c) => c.calls !== 1 || c.results !== 1)).toHaveLength(0);
  });

  test("test_run equals test_success plus test_failure", async () => {
    // Holds exactly on real Claude Code data too, and it is an independent
    // check that call-to-result correlation is sound.
    const events = await everything();
    const n = (t: string) => events.filter((e) => e.event_type === t).length;
    expect(n("test_run")).toBe(n("test_success") + n("test_failure"));
  });

  test("a failing test run is not reported as a pass", async () => {
    // `state.status` is "error" only when the TOOL failed; a suite that ran and
    // reported failures exits non-zero with status "completed". Keying on
    // status reported all 43 runs in this store as passes when some had failed.
    const events = await everything();
    expect(events.filter((e) => e.event_type === "test_failure").length).toBeGreaterThan(0);
  });

  test("no local content survives the wire projection", async () => {
    const events = await everything();
    let checkedTokens = 0;
    for (const e of events) {
      const wire = JSON.stringify(toWire(e));
      expect(wire).not.toContain('"local"');
      const blob = [
        e.local.text ?? "",
        e.local.command ?? "",
        (e.local.absolute_paths ?? []).join("\n"),
        JSON.stringify(e.local.tool_args ?? {}),
        JSON.stringify(e.local.tool_result ?? ""),
      ].join("\n");
      for (const token of blob.split("\n").map((l) => l.trim()).filter((l) => l.length >= 24).slice(0, 40)) {
        checkedTokens++;
        expect(wire).not.toContain(token);
      }
    }
    expect(events.length).toBeGreaterThan(50);
    expect(checkedTokens).toBeGreaterThan(50);
  });

  test("the wire projection passes assertUploadSafe", async () => {
    const events = (await everything()).map(toWire);
    expect(() => assertUploadSafe({ events })).not.toThrow();
  });
});
