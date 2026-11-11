import { describe, expect, test } from "vitest";
import { testChanges } from "../src/test-changes.ts";
import type { FileTree } from "../src/graph.ts";

const tree = (files: Record<string, string>): FileTree => new Map(Object.entries(files));
const T = "test/a.test.mjs";
const file = (...tests: string[]) => `import { test, describe, it } from "node:test";\nimport assert from "node:assert/strict";\n${tests.join("\n")}\n`;
const change = (before: string, after: string) => testChanges(tree({ [T]: before }), tree({ [T]: after }));

describe("tests and suites are keyed by kind, describe path and name", () => {
  const run = "() => { assert.equal(f(), 1); }";

  test("a describe titled with the separator does not take another path's losses", () => {
    const before = file(`describe("a > b", () => { test("dup", ${run}); });`, `describe("a", () => { describe("b", () => { test("dup", ${run}); test("dup", ${run}); test("old", ${run}); }); });`);
    const after = file(`describe("a > b", () => { test("dup", ${run}); });`, `describe("a", () => { describe("b", () => { test("dup", ${run}); test("new", ${run}); }); });`);
    const result = change(before, after);
    expect(result.renamed).toEqual([]);
    expect(result.removedTests.map((r) => r.name).sort()).toEqual(["a > b > dup", "a > b > old"]);
  });

  test("a skipped suite does not pass its skip to a renamed test of the same name", () => {
    const before = file(`describe.skip("old", () => {});`, `test("old", ${run});`);
    const after = file(`describe.skip("old", () => {});`, `test.skip("new", ${run});`);
    const result = change(before, after);
    expect(result.renamed).toEqual([{ file: T, from: "old", to: "new" }]);
    expect(result.markers).toEqual([{ file: T, name: "new", marker: "skip" }]);
  });

  test("a suite's assertions are not counted for a test of the same name", () => {
    const before = file(`describe("old", () => { assert.equal(g(), 1); });`, `test("old", () => { assert.equal(f(), 1); assert.equal(f(), 2); });`);
    const after = file(`describe("old", () => { assert.equal(g(), 1); });`, `test("new", () => { assert.equal(f(), 1); });`);
    expect(change(before, after).weakened).toEqual([{ file: T, name: "new", why: 'renamed from "old"; 2 assertions became 1' }]);
  });

  test("with the places, a rename carries both describe paths as arrays and the weakened flag", () => {
    const before = file(`describe("a > b", () => { test("old", () => { assert.equal(f(), 1); assert.equal(f(), 2); }); });`);
    const after = file(`describe("a > b", () => { test("new", () => { assert.equal(f(), 1); }); });`);
    const result = testChanges(tree({ [T]: before }), tree({ [T]: after }), { places: true });
    expect(result.renamed).toMatchObject([{ from: "a > b > old", to: "a > b > new", fromTitles: ["a > b", "old"], toTitles: ["a > b", "new"], weakened: true }]);
  });
});

describe("callback lines follow lines.ts", () => {
  test("U+2028 does not end a line, so a test's callback lines are the file's lines", () => {
    const text = (head: string): string => `import test from "node:test";\u2028\n${head}("a", () => {\n  x();\n});\ntest("b", () => {\n  y();\n});\n`;
    const result = testChanges(tree({ [T]: text("test") }), tree({ [T]: text("test.skip") }), { places: true });
    expect(result.markers).toEqual([{ file: T, name: "a", marker: "skip", callback: { start: 2, end: 4 } }]);
  });

  test("U+2029 and a lone carriage return do not end a line either", () => {
    const text = `import test from "node:test";\u2029\rtest.skip("a", () => {\n  x();\n});\n`;
    const result = testChanges(tree({ [T]: text.replace(".skip", "") }), tree({ [T]: text }), { places: true });
    expect(result.markers[0]?.callback).toEqual({ start: 1, end: 3 });
  });
});

describe("the real test callbacks of changed source files", () => {
  test("lists the calls the runner reads, by lines and a label, for each side", () => {
    const before = `import { test } from "vitest";\ntest.each([1])("works %s", (x) => {\n  f(x);\n});\nstream.skip("data", () => {\n  g();\n});\n`;
    const after = before.replace("f(x)", "h(x)");
    const result = testChanges(tree({ [T]: before }), tree({ [T]: after }), { places: true });
    expect(result.callbacks).toEqual([{ file: T, base: [{ start: 2, end: 4, label: 'test.each("works %s")' }], head: [{ start: 2, end: 4, label: 'test.each("works %s")' }] }]);
  });
});
