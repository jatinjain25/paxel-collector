import { describe, expect, test } from "bun:test";
import type { UploadPayload } from "@builder/types";
import { signPayload, SignatureError, verifyEnvelope, type SigningKey } from "../src/index.ts";

const KEY: SigningKey = { secret: "server-issued-secret-for-one-builder", key_id: "k1" };
const NONCE = "nonce-abc-123";

function payload(): UploadPayload {
  return {
    upload_id: "up_deterministic",
    device_id: "dev_abc",
    generated_at: 1_757_000_000_000,
    sessions: [],
    events: [
      {
        event_id: "e1",
        source: "claude_code",
        session_id: "s1",
        timestamp: 1_757_000_000_000,
        project_id: "proj_abc",
        event_type: "file_edit",
        actor: "agent",
        seq: 0,
        is_sidechain: false,
        metadata: { tool_name: "Edit", lines_added: 12, lines_removed: 3 },
      },
    ],
    commits: [],
    sources: ["claude_code"],
    unobserved_signals: ["event_timing"],
    pipeline_version: "1.0.0",
    client_version: "1.0.0",
    feature_version: "1.0.0",
  };
}

describe("sign / verify", () => {
  test("round trips", async () => {
    const env = await signPayload(payload(), KEY, NONCE);
    expect(await verifyEnvelope(env, KEY.secret)).toBe(true);
  });

  test("is deterministic for the same payload, key and nonce", async () => {
    const a = await signPayload(payload(), KEY, NONCE);
    const b = await signPayload(payload(), KEY, NONCE);
    expect(a.signature.value).toBe(b.signature.value);
  });

  test("is insensitive to key insertion order in the payload", async () => {
    // Rebuild every object with its keys inserted in the opposite order. Same
    // content, different insertion order — the case plain JSON.stringify breaks on.
    const reorder = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(reorder);
      if (v === null || typeof v !== "object") return v;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as object).sort().reverse()) {
        out[k] = reorder((v as Record<string, unknown>)[k]);
      }
      return out;
    };
    const p1 = payload();
    const a = await signPayload(p1, KEY, NONCE);
    const b = await signPayload(reorder(p1) as UploadPayload, KEY, NONCE);
    expect(a.signature.value).toBe(b.signature.value);
  });

  test("a wrong key does not verify", async () => {
    const env = await signPayload(payload(), KEY, NONCE);
    expect(await verifyEnvelope(env, "some-other-secret")).toBe(false);
  });
});

describe("the Paxel forgery scenario", () => {
  /**
   * Paxel's nonce was HMAC'd over the request id only, so an attacker could hold
   * a legitimately issued nonce, rewrite the body, and have the server accept it.
   * These tests assert that exact attack fails here.
   */
  test("keeping a valid nonce and signature but rewriting the payload fails", async () => {
    const env = await signPayload(payload(), KEY, NONCE);
    const tampered = {
      ...env,
      payload: { ...env.payload, builder_id: "BLDR-ATTACKER" },
    };
    expect(await verifyEnvelope(tampered, KEY.secret)).toBe(false);
  });

  test("smuggling an extra field in fails", async () => {
    const env = await signPayload(payload(), KEY, NONCE);
    const tampered = {
      ...env,
      payload: { ...env.payload, rank: 1 } as unknown as UploadPayload,
    };
    expect(await verifyEnvelope(tampered, KEY.secret)).toBe(false);
  });

  /**
   * The honest limit of signing, kept as a test so it cannot be quietly
   * forgotten. Somebody holding their own key can sign whatever they like, so a
   * signature proves integrity in transit and nothing about authorship.
   *
   * What changed on 2026-09-10 is what there is to lie about. There is no score
   * in the payload any more, so re-signing buys the ability to assert evidence
   * rather than a number — and the catcher checks whether that evidence looks
   * like a person worked.
   */
  test("a re-signed fabricated payload verifies, because the key is the user's own", async () => {
    const p = payload();
    p.events[0]!.metadata.lines_added = 999_999;
    const env = await signPayload(p, KEY, NONCE);
    expect(await verifyEnvelope(env, KEY.secret)).toBe(true);
  });

  test.each([
    ["a nested metric", (p: UploadPayload) => { p.events[0]!.metadata.lines_added = 99_999; }],
    ["an array", (p: UploadPayload) => { p.events = []; }],
    ["a version", (p: UploadPayload) => { p.pipeline_version = "9.9.9"; }],
    ["a timestamp", (p: UploadPayload) => { p.generated_at = 0; }],
    ["the source list", (p: UploadPayload) => { p.sources = ["cursor"]; }],
  ])("changing %s invalidates the signature", async (_label, mutate) => {
    const env = await signPayload(payload(), KEY, NONCE);
    mutate(env.payload);
    expect(await verifyEnvelope(env, KEY.secret)).toBe(false);
  });

  test("replaying under a different nonce fails", async () => {
    const env = await signPayload(payload(), KEY, NONCE);
    env.signature.nonce = "a-different-nonce";
    expect(await verifyEnvelope(env, KEY.secret)).toBe(false);
  });

  test("swapping the key id fails", async () => {
    const env = await signPayload(payload(), KEY, NONCE);
    env.signature.key_id = "k2";
    expect(await verifyEnvelope(env, KEY.secret)).toBe(false);
  });

  test("nonce and key_id cannot be re-split to collide", async () => {
    // Without length prefixes, ("ab","c") and ("a","bc") would sign identical bytes.
    const a = await signPayload(payload(), { ...KEY, key_id: "c" }, "ab");
    const b = await signPayload(payload(), { ...KEY, key_id: "bc" }, "a");
    expect(a.signature.value).not.toBe(b.signature.value);
  });
});

describe("input validation", () => {
  test("refuses an empty key", async () => {
    await expect(signPayload(payload(), { secret: "", key_id: "k1" }, NONCE)).rejects.toThrow(
      SignatureError,
    );
  });

  test("refuses an empty nonce", async () => {
    await expect(signPayload(payload(), KEY, "")).rejects.toThrow(SignatureError);
  });

  test("returns false rather than throwing on a malformed signature", async () => {
    const env = await signPayload(payload(), KEY, NONCE);
    env.signature.value = "not-hex!!";
    expect(await verifyEnvelope(env, KEY.secret)).toBe(false);
  });

  test("rejects an unknown algorithm", async () => {
    const env = await signPayload(payload(), KEY, NONCE);
    (env.signature as { alg: string }).alg = "none";
    expect(await verifyEnvelope(env, KEY.secret)).toBe(false);
  });
});
