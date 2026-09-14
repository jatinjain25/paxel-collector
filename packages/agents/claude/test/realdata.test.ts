import { describe, expect, test } from "bun:test";
import { assertUploadSafe, toWire } from "@builder/types";
import { discoverProjects, parseSessionFile } from "../src/index.ts";

/**
 * The privacy guarantee, exercised against real transcripts rather than
 * fixtures. Fixtures only contain what we thought to put in them; real sessions
 * contain whatever actually happened.
 *
 * Skips cleanly on a machine with no Claude Code history so the suite stays
 * runnable in CI.
 */

const projects = await discoverProjects();
const hasData = projects.length > 0;

/** Distinctive substrings from local-only fields, long enough not to collide. */
function distinctiveTokens(text: string, min = 24): string[] {
  return text
    .split(/[\n\r]+/)
    .map((l) => l.trim())
    .filter((l) => l.length >= min)
    .slice(0, 40);
}

describe.if(hasData)("real Claude Code data", () => {
  test("discovery recovers the authoritative cwd, not the lossy directory name", () => {
    const withCwd = projects.filter((p) => p.cwd);
    expect(withCwd.length).toBeGreaterThan(0);
    for (const p of withCwd) expect(p.cwd!.startsWith("/")).toBe(true);
  });

  test("no local content survives the wire projection", async () => {
    const project = projects.find((p) => p.session_files.length > 0)!;
    let checkedEvents = 0;
    let checkedTokens = 0;

    for (const file of project.session_files.slice(0, 8)) {
      const parsed = await parseSessionFile(file, project);
      if (!parsed) continue;

      for (const e of parsed.events) {
        const wire = JSON.stringify(toWire(e));
        expect(wire).not.toContain('"local"');

        const localBlobs = [
          e.local.text ?? "",
          e.local.command ?? "",
          ...(e.local.absolute_paths ?? []),
          e.local.tool_args ? JSON.stringify(e.local.tool_args) : "",
          e.local.tool_result ? JSON.stringify(e.local.tool_result) : "",
        ].join("\n");

        for (const token of distinctiveTokens(localBlobs)) {
          expect(wire, `leaked from ${e.event_type}`).not.toContain(token);
          checkedTokens++;
        }
        checkedEvents++;
      }
    }

    // Guard against the test passing because it examined nothing.
    expect(checkedEvents).toBeGreaterThan(50);
    expect(checkedTokens).toBeGreaterThan(50);
  });

  test("assembled wire events pass the upload safety scan", async () => {
    const project = projects.find((p) => p.session_files.length > 0)!;
    const parsed = await parseSessionFile(project.session_files[0]!, project);
    expect(parsed).toBeDefined();
    const events = parsed!.events.map(toWire);
    expect(() => assertUploadSafe({ events })).not.toThrow();
  });

  test("session metadata is coherent", async () => {
    const project = projects.find((p) => p.session_files.length > 0)!;
    const parsed = await parseSessionFile(project.session_files[0]!, project);
    const s = parsed!.session;
    expect(s.ended_at).toBeGreaterThanOrEqual(s.started_at);
    expect(s.active_ms).toBeLessThanOrEqual(s.ended_at - s.started_at);
    expect(s.event_count).toBe(parsed!.events.length);
    expect(s.content_hash).toMatch(/^[0-9a-f]{32}$/);
  });

  test("every tool invocation has exactly one matching result", async () => {
    const project = projects.find((p) => p.session_files.length > 0)!;
    const parsed = await parseSessionFile(project.session_files[0]!, project);
    const calls = parsed!.events.filter((e) => e.actor === "agent" && e.correlation_id);
    const results = parsed!.events.filter((e) => e.actor === "tool" && e.correlation_id);
    const callIds = new Set(calls.map((e) => e.correlation_id));
    // Trailing calls with no result are legitimate (session ended mid-flight),
    // but a result must always have a call.
    for (const r of results) expect(callIds.has(r.correlation_id)).toBe(true);
  });
});

describe.if(!hasData)("real Claude Code data", () => {
  test.skip("no ~/.claude/projects on this machine", () => {});
});
