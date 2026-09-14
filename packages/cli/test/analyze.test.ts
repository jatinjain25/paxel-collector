import { describe, expect, test } from "bun:test";
import type { CollectionSummary } from "@builder/discovery";
import { analyze } from "../src/analyze.ts";

/**
 * A collection that could not possibly come from this machine.
 *
 * `builder analyze` prints an evidence summary and asks for confirmation before
 * scoring, so by the time it scores it has already read everything. It used to
 * call `collectAll` a second time anyway, re-parsing the whole corpus (1.1 GB,
 * 272 sessions here) to produce a byte-identical result.
 *
 * If that regressed, `analyze` would ignore what it was handed, scan the real
 * machine, and come back with hundreds of sessions instead of zero.
 */
function emptyCollection(): CollectionSummary {
  return {
    sources: [],
    observed_signals: [],
    projects: 0,
    repos: 0,
    sessions: [],
    events: [],
    commits: [],
    rework_ratio: 0,
    revert_count: 0,
    test_file_ratio: 0,
    duration_ms: 0,
  };
}

describe("analyze", () => {
  test("uses the collection it was given instead of collecting again", async () => {
    const result = await analyze({ collection: emptyCollection() });
    expect(result.collection.sessions).toHaveLength(0);
    expect(result.collection.sources).toHaveLength(0);
    expect(result.episodes).toBe(0);
  });

  test("still produces a scored record from an empty machine", async () => {
    const { record } = await analyze({ collection: emptyCollection(), builderId: "BLDR-TEST" });
    expect(record.builder_id).toBe("BLDR-TEST");
    expect(record.composite_score).toBeGreaterThanOrEqual(0);
    expect(record.confidence).toBeGreaterThanOrEqual(0);
  });
});
