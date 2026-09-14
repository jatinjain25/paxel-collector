/**
 * Canonical JSON serialization.
 *
 * A signature is only meaningful if the same logical payload always produces the
 * same bytes. `JSON.stringify` preserves *insertion* order, so a payload built by
 * two different code paths — or round-tripped through a parse — serializes
 * differently and the signature spuriously fails. Sorting keys removes that.
 *
 * Rules, chosen so the server can reimplement this in any language:
 *   - object keys sorted by UTF-16 code unit (JS default `sort()`)
 *   - `undefined` properties omitted, matching JSON.stringify
 *   - `undefined` inside arrays becomes `null`, matching JSON.stringify
 *   - no whitespace
 *   - non-finite numbers rejected rather than silently becoming `null`, which
 *     would let two different payloads share a serialization
 */

export class CanonicalizationError extends Error {
  override readonly name = "CanonicalizationError";
}

export function canonicalize(value: unknown): string {
  return write(value, new WeakSet(), "$");
}

function write(value: unknown, seen: WeakSet<object>, path: string): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new CanonicalizationError(
          `Non-finite number at ${path}. NaN and Infinity serialize to null, which would ` +
            `let two different payloads share one signature.`,
        );
      }
      // Normalize -0 to 0 so they cannot produce differing bytes.
      return Object.is(value, -0) ? "0" : String(value);
    case "string":
      return JSON.stringify(value);
    case "bigint":
      throw new CanonicalizationError(`BigInt at ${path} is not representable in JSON.`);
    case "undefined":
    case "function":
    case "symbol":
      throw new CanonicalizationError(`Cannot serialize ${typeof value} at ${path}.`);
  }

  const obj = value as object;
  if (seen.has(obj)) throw new CanonicalizationError(`Circular reference at ${path}.`);
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      const parts = obj.map((v, i) =>
        v === undefined ? "null" : write(v, seen, `${path}[${i}]`),
      );
      return `[${parts.join(",")}]`;
    }

    const entries = Object.entries(obj as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

    const parts = entries.map(
      ([k, v]) => `${JSON.stringify(k)}:${write(v, seen, `${path}.${k}`)}`,
    );
    return `{${parts.join(",")}}`;
  } finally {
    seen.delete(obj);
  }
}
