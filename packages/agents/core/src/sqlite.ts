/**
 * Minimal SQLite access that works on both runtimes.
 *
 * Bun ships `bun:sqlite`; Node ships `node:sqlite`; neither has the other. Doc 5
 * §2 targets Node, development and tests run on Bun, so this picks whichever
 * exists rather than committing the collector to one runtime.
 *
 * Only read paths are exposed. Nothing here can write to a developer's editor
 * database, which matters because Cursor may have it open while we read.
 */

export interface ReadOnlyDb {
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[];
  close(): void;
}

interface NodeStatement {
  all(...params: unknown[]): unknown[];
}
interface NodeDb {
  prepare(sql: string): NodeStatement;
  close(): void;
}
interface BunDb {
  query(sql: string): { all(...params: unknown[]): unknown[] };
  close(): void;
}

/**
 * Open a database read-only and immutable.
 *
 * `immutable=1` tells SQLite the file will not change, so it neither takes locks
 * nor touches the WAL. Cursor is very likely running while we read; opening
 * normally risks contending with the editor over its own state, and a profiling
 * tool must never be the reason someone's editor misbehaves.
 */
export async function openReadOnly(path: string): Promise<ReadOnlyDb> {
  try {
    const { DatabaseSync } = (await import("node:sqlite")) as unknown as {
      DatabaseSync: new (p: string, o?: { readOnly?: boolean }) => NodeDb;
    };
    const db = new DatabaseSync(`file:${path}?immutable=1`, { readOnly: true });
    return {
      all: <T>(sql: string, ...params: unknown[]) => db.prepare(sql).all(...params) as T[],
      close: () => db.close(),
    };
  } catch {
    // Fall through to Bun.
  }

  const { Database } = (await import("bun:sqlite")) as unknown as {
    Database: new (p: string, o?: { readonly?: boolean }) => BunDb;
  };
  const db = new Database(`file:${path}?immutable=1`, { readonly: true });
  return {
    all: <T>(sql: string, ...params: unknown[]) => db.query(sql).all(...params) as T[],
    close: () => db.close(),
  };
}

/**
 * Values in VS Code-derived stores are BLOBs holding UTF-8 JSON.
 *
 * Returns undefined rather than throwing: a single unparseable row should cost
 * one message, not the whole session.
 */
export function parseBlobJson(value: unknown): unknown {
  try {
    if (value === null || value === undefined) return undefined;
    if (typeof value === "string") return JSON.parse(value);
    if (value instanceof Uint8Array) return JSON.parse(new TextDecoder().decode(value));
    if (value instanceof ArrayBuffer) return JSON.parse(new TextDecoder().decode(new Uint8Array(value)));
    return undefined;
  } catch {
    return undefined;
  }
}
