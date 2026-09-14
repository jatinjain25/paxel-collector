import { createReadStream } from "node:fs";

/**
 * Streaming JSONL reader built for the shape of real Claude Code data.
 *
 * Measured on one developer machine: 900 files, 278,459 records, 1.8 GB, with
 * single files at 135 MB / 63 MB / 49 MB and individual *lines* in the megabytes
 * (a Read tool result on a large file is one line). Loading a file into memory
 * and splitting is therefore not viable.
 *
 * Roughly 25% of records are types we never need. Deciding that with a substring
 * scan before calling JSON.parse is the single biggest win available: scanning a
 * 5 MB line costs a memory sweep, parsing it allocates a 5 MB object graph we
 * immediately discard.
 */

/** Record types carrying no behavioral signal (measured ~25% of all records). */
const SKIP_TYPES = [
  "attachment",
  "ai-title",
  "atis-latch",
  "bridge-session",
  "last-prompt",
  "queue-operation",
  "frame-link",
  "history-suppression",
  "artifact-autoreact-ledger",
  "artifact-comment-monitor",
] as const;

const SKIP_MARKERS = SKIP_TYPES.map((t) => `"type":"${t}"`);

export interface JsonlStats {
  lines: number;
  parsed: number;
  skipped: number;
  /** Lines that were not valid JSON. Tolerated: a session may be mid-write. */
  malformed: number;
  bytes: number;
}

export interface JsonlOptions {
  /** Lines longer than this are counted and skipped rather than parsed. */
  maxLineBytes?: number;
}

/** 32 MB. Well above any legitimate record; guards against a pathological line. */
const DEFAULT_MAX_LINE_BYTES = 32 * 1024 * 1024;

/**
 * Yield parsed records from a JSONL file.
 *
 * Splits on newlines manually rather than using readline, so the skip decision
 * happens on the raw string before any parse and the buffer never accumulates
 * more than one line.
 */
export async function* readJsonl(
  path: string,
  stats: JsonlStats,
  options: JsonlOptions = {},
): AsyncGenerator<Record<string, unknown>> {
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const stream = createReadStream(path, { encoding: "utf8", highWaterMark: 1 << 20 });

  let buffer = "";
  for await (const chunk of stream) {
    buffer += chunk as string;
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const record = handleLine(line, stats, maxLineBytes);
      if (record) yield record;
      nl = buffer.indexOf("\n");
    }
  }
  if (buffer.length > 0) {
    const record = handleLine(buffer, stats, maxLineBytes);
    if (record) yield record;
  }
}

function handleLine(
  line: string,
  stats: JsonlStats,
  maxLineBytes: number,
): Record<string, unknown> | undefined {
  if (line.length === 0) return undefined;
  stats.lines++;
  stats.bytes += line.length;

  if (line.length > maxLineBytes) {
    stats.skipped++;
    return undefined;
  }
  if (shouldSkip(line)) {
    stats.skipped++;
    return undefined;
  }

  try {
    const parsed = JSON.parse(line) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      stats.malformed++;
      return undefined;
    }
    stats.parsed++;
    return parsed as Record<string, unknown>;
  } catch {
    // A session file being written right now can end mid-line. Tolerate it
    // rather than failing the whole run over one truncated record.
    stats.malformed++;
    return undefined;
  }
}

/**
 * Cheap pre-parse filter. Only inspects the head of the line: the `type` field
 * appears early in every record, so a bounded scan avoids sweeping a 5 MB line.
 */
function shouldSkip(line: string): boolean {
  const head = line.length > 512 ? line.slice(0, 512) : line;
  return SKIP_MARKERS.some((m) => head.includes(m));
}

export function newStats(): JsonlStats {
  return { lines: 0, parsed: 0, skipped: 0, malformed: 0, bytes: 0 };
}
