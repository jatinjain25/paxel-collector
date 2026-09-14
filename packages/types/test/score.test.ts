import { describe, expect, test } from "bun:test";
import {
  compositeScore,
  displayScore,
  DIMENSIONS,
  V1_WEIGHTS,
  type Dimension,
} from "../src/index.ts";

const flat = (v: number): Record<Dimension, number> =>
  Object.fromEntries(DIMENSIONS.map((d) => [d, v])) as Record<Dimension, number>;

describe("composite score (Doc 3 §6)", () => {
  test("V1 weights sum to 1", () => {
    const sum = DIMENSIONS.reduce((a, d) => a + V1_WEIGHTS[d], 0);
    expect(sum).toBeCloseTo(1, 10);
  });

  test("uniform dimensions produce that same composite", () => {
    expect(compositeScore(flat(80))).toBeCloseTo(80, 10);
  });

  test("stays within 0-100 at the extremes", () => {
    expect(compositeScore(flat(0))).toBe(0);
    expect(compositeScore(flat(100))).toBeCloseTo(100, 10);
  });

  test("applies the documented weighting", () => {
    // Execution 25, Steering 20, Engineering 25, Product 15, Planning 15
    const dims: Record<Dimension, number> = {
      execution: 100, steering: 0, engineering: 0, product: 0, planning: 0,
    };
    expect(compositeScore(dims)).toBeCloseTo(25, 10);
  });

  test("normalizes when a reweighting does not sum to 1", () => {
    const weights = { execution: 2, steering: 2, engineering: 2, product: 2, planning: 2 };
    expect(compositeScore(flat(70), weights)).toBeCloseTo(70, 10);
  });

  test("is deterministic — the same input scores identically every time", () => {
    const dims: Record<Dimension, number> = {
      execution: 91.4, steering: 87.2, engineering: 84.9, product: 76.1, planning: 89.3,
    };
    const runs = Array.from({ length: 50 }, () => compositeScore(dims));
    expect(new Set(runs).size).toBe(1);
  });
});

describe("display score (Doc 4 §4)", () => {
  test("91.42 renders as 9,142", () => {
    expect(displayScore(91.42)).toBe(9142);
  });

  test("spans 0-10,000", () => {
    expect(displayScore(0)).toBe(0);
    expect(displayScore(100)).toBe(10_000);
  });
});
