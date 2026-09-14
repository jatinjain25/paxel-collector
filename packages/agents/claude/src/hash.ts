import { createHash } from "node:crypto";

/** Truncated sha256. 128 bits is far beyond collision risk at our cardinality. */
export function hashId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}
