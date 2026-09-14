import type { SignedEnvelope, UploadPayload } from "@builder/types";
import { canonicalize } from "./canonical.ts";

/**
 * Payload signing.
 *
 * Paxel's July 2026 forgery worked because their nonce was HMAC'd over the
 * request id ALONE — the score fields sat outside the signature, so a client
 * could keep a legitimately issued nonce and swap in any numbers it liked.
 *
 * Here the signature covers the canonical serialization of the ENTIRE payload
 * with the nonce bound in. Changing any byte of any field invalidates it.
 *
 * Note honestly what this does and does not buy, because after the 2026-09-09
 * reversal it buys less than it used to. The collector is open source and the
 * key lives on the user's machine, so HMAC cannot prove authorship against
 * someone willing to read their own key out of `~/.builder/`. It gives
 * integrity in transit and replay protection, and nothing more.
 *
 * The architectural defence is gone: the payload now carries the score the
 * machine computed rather than the features the server would have scored, so a
 * determined user can sign whatever number they like. That was the price of
 * being able to say truthfully that nothing but the score leaves the machine.
 * The replacement control is at the eligibility gate rather than here — ranking
 * requires GitHub-verified commits, so a forged rank costs about what an earned
 * one does. Keys stay per-builder rather than baked into the binary, so a
 * compromised key still costs one account rather than the system.
 */

const ALG = { name: "HMAC", hash: "SHA-256" } as const;

export class SignatureError extends Error {
  override readonly name = "SignatureError";
}

async function importKey(secret: string): Promise<CryptoKey> {
  if (secret.length === 0) {
    throw new SignatureError("Refusing to sign with an empty key.");
  }
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), ALG, false, [
    "sign",
    "verify",
  ]);
}

/**
 * Bytes actually signed: the nonce and key id are prefixed so a signature
 * captured under one nonce cannot be replayed under another, and length-prefixed
 * so `nonce="ab", keyId="c"` cannot collide with `nonce="a", keyId="bc"`.
 */
function signingInput(
  payload: UploadPayload,
  nonce: string,
  keyId: string,
): Uint8Array<ArrayBuffer> {
  const body = canonicalize(payload);
  const preamble = `v1.${nonce.length}.${nonce}.${keyId.length}.${keyId}.`;
  // TextEncoder always allocates a fresh, non-shared buffer, so narrowing away
  // ArrayBufferLike (which admits SharedArrayBuffer) is sound here.
  return new TextEncoder().encode(preamble + body) as Uint8Array<ArrayBuffer>;
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) {
    throw new SignatureError("Signature is not valid hex.");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export interface SigningKey {
  /** Server-issued, per builder. Stored at ~/.builder/key with mode 0600. */
  secret: string;
  key_id: string;
}

/** Wrap a payload in a signed envelope. `nonce` must be server-issued and single-use. */
export async function signPayload(
  payload: UploadPayload,
  key: SigningKey,
  nonce: string,
): Promise<SignedEnvelope> {
  if (nonce.length === 0) throw new SignatureError("Refusing to sign without a nonce.");
  const ck = await importKey(key.secret);
  const sig = await crypto.subtle.sign(ALG, ck, signingInput(payload, nonce, key.key_id));
  return {
    payload,
    signature: { alg: "hmac-sha256", value: toHex(sig), nonce, key_id: key.key_id },
  };
}

/**
 * Verify an envelope. Uses `crypto.subtle.verify` rather than comparing strings,
 * so the comparison is constant-time and does not leak the expected value.
 */
export async function verifyEnvelope(
  envelope: SignedEnvelope,
  secret: string,
): Promise<boolean> {
  const { payload, signature } = envelope;
  if (signature.alg !== "hmac-sha256") return false;
  let sigBytes: Uint8Array<ArrayBuffer>;
  try {
    sigBytes = fromHex(signature.value);
  } catch {
    return false;
  }
  const ck = await importKey(secret);
  return crypto.subtle.verify(
    ALG,
    ck,
    sigBytes,
    signingInput(payload, signature.nonce, signature.key_id),
  );
}
