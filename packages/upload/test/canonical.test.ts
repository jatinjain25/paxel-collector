import { describe, expect, test } from "bun:test";
import { canonicalize, CanonicalizationError } from "../src/canonical.ts";

describe("canonicalize", () => {
  test("key insertion order does not change the output", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });

  test("sorts nested keys too", () => {
    const x = { outer: { z: 1, a: { y: 2, b: 3 } } };
    const y = { outer: { a: { b: 3, y: 2 }, z: 1 } };
    expect(canonicalize(x)).toBe(canonicalize(y));
  });

  test("array order is significant", () => {
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });

  test("survives a JSON round trip unchanged", () => {
    const v = { b: [3, { d: 4, c: "x" }], a: true, n: null };
    expect(canonicalize(JSON.parse(canonicalize(v)))).toBe(canonicalize(v));
  });

  test("omits undefined properties, matching JSON.stringify", () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  test("undefined inside an array becomes null, matching JSON.stringify", () => {
    expect(canonicalize([1, undefined, 2])).toBe("[1,null,2]");
  });

  test("normalizes -0 so it cannot produce distinct bytes", () => {
    expect(canonicalize({ a: -0 })).toBe(canonicalize({ a: 0 }));
  });

  test.each([Number.NaN, Number.POSITIVE_INFINITY, -Number.POSITIVE_INFINITY])(
    "rejects the non-finite number %p rather than emitting null",
    (n) => {
      expect(() => canonicalize({ a: n })).toThrow(CanonicalizationError);
    },
  );

  test("rejects circular structures", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => canonicalize(a)).toThrow(CanonicalizationError);
  });

  test("allows the same object to appear twice at different paths", () => {
    const shared = { x: 1 };
    expect(() => canonicalize({ a: shared, b: shared })).not.toThrow();
  });

  test("escapes strings so delimiters cannot be smuggled", () => {
    expect(canonicalize({ 'a"b': 'c"d' })).toBe('{"a\\"b":"c\\"d"}');
  });
});
