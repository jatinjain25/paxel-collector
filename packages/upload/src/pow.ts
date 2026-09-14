import { createHash } from "node:crypto";

/**
 * The registration puzzle, shared by both sides of it.
 *
 * It lives in `upload` rather than in `api` because the collector has to solve
 * what the server sets, and the collector must never depend on the server
 * package: that would pull the store, the Postgres driver and the whole API
 * into a binary whose privacy argument rests on how little it contains. It is
 * not in `api` and copied here either, because two definitions of one puzzle
 * drift and the symptom is every registration failing.
 *
 * Issuing and verifying a CHALLENGE stays server-side, in packages/api, since
 * that needs a secret the client must not hold.
 */

export function powHash(challenge: string, solution: string): Buffer {
  return createHash("sha256").update(`${challenge}:${solution}`).digest();
}

/**
 * Leading zero BITS, not bytes or hex characters.
 *
 * Bits make the difficulty adjustable in single doublings. Counting hex zeros
 * moves the cost 16x per step, which is not a dial anybody can tune against
 * live traffic.
 */
export function hasLeadingZeroBits(hash: Buffer, bits: number): boolean {
  if (bits <= 0) return true;
  const whole = bits >> 3;
  for (let i = 0; i < whole; i++) if (hash[i] !== 0) return false;
  const rest = bits & 7;
  if (rest === 0) return true;
  return (hash[whole]! >> (8 - rest)) === 0;
}

export function verifySolution(challenge: string, solution: string, bits: number): boolean {
  return hasLeadingZeroBits(powHash(challenge, solution), bits);
}

/** Find a solution. At zero bits this returns on the first attempt. */
export function solveChallenge(challenge: string, bits: number, limit = 50_000_000): string {
  for (let n = 0; n < limit; n++) {
    const s = n.toString(36);
    if (hasLeadingZeroBits(powHash(challenge, s), bits)) return s;
  }
  throw new Error(`no proof-of-work solution found for ${bits} bits`);
}
