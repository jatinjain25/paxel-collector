import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertUploadSafe, toWire } from "@builder/types";
import { CodexAdapter, classifyCodexTool } from "../src/adapter.ts";
import { CODEX_CAPABILITIES } from "../src/capabilities.ts";

/**
 * Codex is not installed on the machines this has run on, so these exercise the
 * adapter against a fixture built from the DOCUMENTED rollout format. That is
 * weaker evidence than the other two adapters have and the tests should not be
 * read as saying otherwise: they prove the parser does what the format
 * description implies, not that the format description is right.
 */
const ROOT = await mkdtemp(join(tmpdir(), "codex-fixture-"));
afterAll(() => rm(ROOT, { recursive: true, force: true }));

const CWD = "/Users/someone/project";
const lines = [
  { type: "session_meta", payload: { id: "sess-1", cwd: CWD, model: "gpt-5-codex", cli_version: "0.1.0" } },
  { timestamp: "2026-09-01T10:00:00Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Add a retry to the upload path please" }] } },
  { timestamp: "2026-09-01T10:00:05Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Looking at the upload module now." }] } },
  { timestamp: "2026-09-01T10:00:10Z", type: "response_item", payload: { type: "function_call", name: "read_file", call_id: "call_1", arguments: JSON.stringify({ path: `${CWD}/src/upload.ts` }) } },
  { timestamp: "2026-09-01T10:00:11Z", type: "response_item", payload: { type: "function_call_output", call_id: "call_1", output: "export async function upload() {}" } },
  { timestamp: "2026-09-01T10:00:20Z", type: "response_item", payload: { type: "function_call", name: "apply_patch", call_id: "call_2", arguments: JSON.stringify({ path: `${CWD}/src/upload.ts` }) } },
  { timestamp: "2026-09-01T10:00:21Z", type: "response_item", payload: { type: "function_call_output", call_id: "call_2", output: "ok" } },
  { timestamp: "2026-09-01T10:00:30Z", type: "response_item", payload: { type: "local_shell_call", call_id: "call_3", action: { command: ["bun", "test", "packages/upload"] } } },
  { timestamp: "2026-09-01T10:00:40Z", type: "response_item", payload: { type: "local_shell_call_output", call_id: "call_3", output: '{"success": false, "output": "1 failing"}' } },
  { timestamp: "2026-09-01T10:00:50Z", type: "response_item", payload: { type: "function_call", name: "read_file", call_id: "call_4", arguments: JSON.stringify({ path: `${CWD}/src/upload.test.ts` }) } },
  { timestamp: "2026-09-01T10:00:51Z", type: "response_item", payload: { type: "function_call_output", call_id: "call_4", output: "test(...)" } },
];

const dir = join(ROOT, "2026", "09", "01");
await mkdir(dir, { recursive: true });
await writeFile(
  join(dir, "rollout-2026-09-01T10-00-00-sess-1.jsonl"),
  lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
);
// A malformed line and an unrelated file, because real directories have both.
await writeFile(join(dir, "rollout-2026-09-01T11-00-00-sess-2.jsonl"), '{"broken\n{"type":"x"}\n');
await writeFile(join(dir, "notes.txt"), "ignore me");

const adapter = new CodexAdapter(ROOT);

describe("classifyCodexTool", () => {
  test.each([
    ["read_file", undefined, "file_read"],
    ["apply_patch", undefined, "file_edit"],
    ["write_file", undefined, "file_write"],
    ["shell", undefined, "terminal_command"],
    ["shell", "test", "test_run"],
    ["shell", "git_commit", "git_commit"],
    ["something_new", undefined, "tool_call"],
  ] as const)("%s/%s -> %s", (name, family, expected) => {
    expect(classifyCodexTool(name, family as never)).toBe(expected);
  });
});

describe("capabilities", () => {
  test("claims only what the format is documented to record", () => {
    // An over-claim becomes a real zero in the feature vector and penalizes
    // every Codex user for behaviour their tool never wrote down.
    expect([...CODEX_CAPABILITIES].sort()).toEqual([
      "commands",
      "file_paths",
      "model",
      "timestamps",
      "tool_calls",
    ]);
  });

  test("the adapter admits it is unverified", () => {
    // `builder discover` prints "(unverified adapter)" from this, so the
    // person whose data it is can see that nobody has run it for real.
    expect(adapter.verified).toBe(false);
  });
});

describe("parsing a documented rollout", () => {
  test("detects and groups sessions by cwd", async () => {
    expect(await adapter.detect()).toBe(true);
    const projects = await adapter.discover();
    const withPath = projects.find((p) => p.path === CWD);
    expect(withPath).toBeDefined();
    expect(withPath!.session_refs).toHaveLength(1);
    // notes.txt is not a rollout.
    expect(projects.flatMap((p) => p.session_refs).every((r) => r.locator.endsWith(".jsonl"))).toBe(true);
  });

  async function events() {
    const projects = await adapter.discover();
    const project = projects.find((p) => p.path === CWD)!;
    const parsed = await adapter.parseSession(project.session_refs[0]!, project);
    return parsed!;
  }

  test("a tool use is one invocation and one result", async () => {
    const { events: e } = await events();
    const pairs = new Map<string, { calls: number; results: number }>();
    for (const ev of e) {
      if (ev.correlation_id === undefined) continue;
      const c = pairs.get(ev.correlation_id) ?? { calls: 0, results: 0 };
      if (ev.actor === "agent") c.calls++;
      if (ev.actor === "tool") c.results++;
      pairs.set(ev.correlation_id, c);
    }
    expect(pairs.size).toBe(4);
    expect([...pairs.values()].filter((c) => c.calls !== 1 || c.results !== 1)).toHaveLength(0);
  });

  test("a failing shell test becomes test_failure, not test_success", async () => {
    const { events: e } = await events();
    expect(e.filter((x) => x.event_type === "test_run")).toHaveLength(1);
    expect(e.filter((x) => x.event_type === "test_failure")).toHaveLength(1);
    expect(e.filter((x) => x.event_type === "test_success")).toHaveLength(0);
  });

  test("an argv command is joined rather than dropped", async () => {
    const { events: e } = await events();
    const run = e.find((x) => x.event_type === "test_run")!;
    expect(run.metadata.command_family).toBe("test");
    expect(run.local.command).toBe("bun test packages/upload");
  });

  test("a test file is recognised", async () => {
    const { events: e } = await events();
    const paths = e.flatMap((x) => x.metadata.paths ?? []);
    expect(paths.some((p) => p.is_test)).toBe(true);
    expect(paths.some((p) => !p.is_test)).toBe(true);
  });

  test("counts prompts and produces a coherent session record", async () => {
    const { session, stats } = await events();
    expect(session.prompt_count).toBe(1);
    expect(session.source).toBe("codex_cli");
    expect(session.started_at).toBeLessThan(session.ended_at);
    expect(stats.malformed).toBe(0);
  });

  test("a malformed line is counted, not fatal", async () => {
    const projects = await adapter.discover();
    const other = projects.flatMap((p) => p.session_refs).find((r) => r.locator.includes("sess-2"))!;
    const parsed = await adapter.parseSession(other, projects[0]!);
    expect(parsed!.stats.malformed).toBeGreaterThan(0);
  });

  test("no local content survives the wire projection", async () => {
    const { events: e } = await events();
    for (const ev of e) {
      const wire = JSON.stringify(toWire(ev));
      expect(wire).not.toContain('"local"');
      for (const token of [ev.local.text, ev.local.command, ...(ev.local.absolute_paths ?? [])]) {
        if (token !== undefined && token.length >= 12) expect(wire).not.toContain(token);
      }
    }
    expect(() => assertUploadSafe({ events: e.map(toWire) })).not.toThrow();
  });
});
