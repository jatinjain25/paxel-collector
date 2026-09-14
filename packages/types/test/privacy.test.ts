import { describe, expect, test } from "bun:test";
import {
  assertUploadSafe,
  toWire,
  UploadSafetyError,
  type LocalEvent,
  type UploadPayload,
} from "../src/index.ts";

/** Stand-ins for what must never be uploaded: source, prompts, paths, commands. */
const SENTINELS = {
  source_code: "SENTINEL_SOURCE_const apiKey = 'hunter2'",
  prompt_text: "SENTINEL_PROMPT_refactor the auth module please",
  absolute_path: "/Users/SENTINEL_USER/secret-project/src/billing.ts",
  shell_command: "SENTINEL_CMD_curl -H 'Authorization: Bearer cfoat_live'",
  cwd: "/Users/SENTINEL_USER/secret-project",
  commit_subject: "SENTINEL_SUBJECT_fix the billing overflow",
} as const;

function localEventCarryingEverything(): LocalEvent {
  return {
    event_id: "e1",
    source: "claude_code",
    session_id: "s1",
    timestamp: 1_757_000_000_000,
    project_id: "proj_abc",
    event_type: "file_edit",
    actor: "agent",
    seq: 0,
    parent_event_id: "e0",
    correlation_id: "toolu_1",
    is_sidechain: false,
    metadata: {
      raw_kind: "tool_use",
      tool_name: "Edit",
      arg_bytes: 4096,
      lines_added: 12,
      lines_removed: 3,
      paths: [{ path_hash: "ab12cd", ext: ".ts", depth: 3, is_test: false }],
    },
    local: {
      text: SENTINELS.prompt_text,
      tool_args: { old_string: SENTINELS.source_code },
      tool_result: { stdout: SENTINELS.source_code },
      command: SENTINELS.shell_command,
      absolute_paths: [SENTINELS.absolute_path],
      cwd: SENTINELS.cwd,
      commit_subject: SENTINELS.commit_subject,
    },
  };
}

describe("wire projection", () => {
  test("drops every local-only field", () => {
    const wire = toWire(localEventCarryingEverything());
    expect(wire).not.toHaveProperty("local");
    const serialized = JSON.stringify(wire);
    for (const [name, value] of Object.entries(SENTINELS)) {
      expect(serialized, `sentinel "${name}" survived projection`).not.toContain(value);
    }
  });

  test("preserves the metadata scoring actually needs", () => {
    const wire = toWire(localEventCarryingEverything());
    expect(wire.metadata.tool_name).toBe("Edit");
    expect(wire.metadata.lines_added).toBe(12);
    expect(wire.metadata.paths?.[0]?.ext).toBe(".ts");
    expect(wire.correlation_id).toBe("toolu_1");
    expect(wire.event_type).toBe("file_edit");
  });

  test("is an allowlist, so an unknown local field cannot leak", () => {
    const evt = localEventCarryingEverything() as LocalEvent & { rogue_field: string };
    evt.rogue_field = SENTINELS.source_code;
    expect(JSON.stringify(toWire(evt))).not.toContain(SENTINELS.source_code);
  });
});

/**
 * The excerpt approval gate was tested here and the module is gone.
 *
 * It let a user approve short, redacted snippets of their own text for upload.
 * Nothing ever produced a candidate, `packages/redaction` was never written,
 * and the payload stopped having anywhere to put one in the 2026-09-09
 * reversal. The site now says "We never receive a line of what you wrote", so
 * the feature is not pending, it is decided against.
 *
 * What must NOT go with it is the enforcement. `excerpt`, `excerpts`,
 * `content_excerpt` and `text` stay in FORBIDDEN_KEYS and the cases below still
 * assert they are rejected. Deleting a type that promised to upload text is a
 * statement of intent; deleting the check that stops it would be the opposite.
 */

describe("assertUploadSafe", () => {
  const payload = (): UploadPayload => ({
    upload_id: "up_deterministic",
    device_id: "dev_abc",
    generated_at: 1_757_000_000_000,
    sessions: [],
    events: [toWire(localEventCarryingEverything())],
    commits: [],
    sources: ["claude_code", "cursor"],
    unobserved_signals: ["event_timing"],
    pipeline_version: "1.0.0",
    client_version: "1.0.0",
    feature_version: "1.0.0",
  });

  test("accepts evidence that has been through the projection", () => {
    expect(() => assertUploadSafe(payload())).not.toThrow();
  });

  /**
   * The reason the payload carries evidence rather than a score: there is no
   * number in it for a machine to edit. The server computes every one.
   */
  test.each(["score", "composite_score", "proof_score", "rank", "percentile"])(
    "rejects a client-supplied %s",
    (field) => {
      const p = payload() as unknown as Record<string, unknown>;
      p[field] = 9999;
      expect(() => assertUploadSafe(p)).toThrow(UploadSafetyError);
    },
  );

  test.each([
    ["local", { local: { text: SENTINELS.prompt_text } }],
    ["raw source", { original_file: SENTINELS.source_code }],
    ["a shell command", { command: SENTINELS.shell_command }],
    ["an absolute path", { cwd: SENTINELS.cwd }],
    ["a raw excerpt", { content_excerpt: SENTINELS.prompt_text }],
    ["prompt text", { text: SENTINELS.prompt_text }],
    ["a commit subject", { commit_subject: SENTINELS.commit_subject }],
  ])("rejects an event carrying %s", (_label, leak) => {
    const p = payload() as unknown as Record<string, unknown>;
    p.events = [{ ...toWire(localEventCarryingEverything()), ...leak }];
    expect(() => assertUploadSafe(p)).toThrow(UploadSafetyError);
  });

  test("scans nested arrays and objects, not just the top level", () => {
    const p = payload() as unknown as Record<string, unknown>;
    p.sessions = [{ meta: { nested: { stdout: SENTINELS.source_code } } }];
    expect(() => assertUploadSafe(p)).toThrow(UploadSafetyError);
  });

  test("does not mistake a legitimate `source` field for a leak", () => {
    const evt = toWire(localEventCarryingEverything());
    expect(() => assertUploadSafe({ events: [evt] })).not.toThrow();
    expect(evt.source).toBe("claude_code");
  });

  /**
   * The whole privacy argument in one assertion: every event that reaches the
   * wire went through `toWire`, and `toWire` is an allowlist.
   */
  test("no sentinel from a rich local event survives into the payload", () => {
    const serialized = JSON.stringify(payload());
    for (const [name, value] of Object.entries(SENTINELS)) {
      expect(serialized, `sentinel "${name}" reached the payload`).not.toContain(value);
    }
  });
});
