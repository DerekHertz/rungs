import { describe, expect, test } from "vitest";
import { compare, pictureOf } from "../src/compare.ts";
import { extract } from "../src/extract/extract.ts";
import type { FileTree, NodeId } from "../src/graph.ts";
import { testChanges } from "../src/test-changes.ts";
import { testMarks, titlesOf } from "../src/test-marks.ts";
import { insideOf, marksOf } from "../src/town-inside.ts";

const treeOf = (files: Record<string, string>): FileTree => new Map(Object.entries(files));

const BASE = `import test from "node:test";
import assert from "node:assert/strict";
test("adds", () => { assert.equal(1 + 1, 2); });
test("subtracts", () => { assert.equal(2 - 1, 1); });
test("multiplies", () => { assert.equal(2 * 2, 4); });
`;

function marksFor(base: Record<string, string>, head: Record<string, string>) {
  const baseTree = treeOf(base);
  const headTree = treeOf(head);
  const comparison = compare(extract(baseTree), extract(headTree), { base: baseTree, head: headTree });
  return testMarks(comparison, testChanges(baseTree, headTree));
}

describe("testMarks", () => {
  test("a removed, weakened or newly skipped test marks its file weakened", () => {
    const removed = marksFor({ "t.test.mjs": BASE }, { "t.test.mjs": BASE.replace(/test\("multiplies".*\n/, "") });
    expect(removed.files.get("t.test.mjs")).toBe("weakened");
    const skipped = marksFor({ "t.test.mjs": BASE }, { "t.test.mjs": BASE.replace('test("adds"', 'test.skip("adds"') });
    expect(skipped.files.get("t.test.mjs")).toBe("weakened");
    expect([...skipped.tests.get("t.test.mjs")!]).toEqual(["adds"]);
    const weakened = marksFor({ "t.test.mjs": BASE }, { "t.test.mjs": BASE.replace("assert.equal(1 + 1, 2)", "assert.ok(1 + 1)") });
    expect(weakened.files.get("t.test.mjs")).toBe("weakened");
    expect([...weakened.tests.get("t.test.mjs")!]).toEqual(["adds"]);
  });

  test("a removed test marks its file but no room: the head has none", () => {
    const marks = marksFor({ "t.test.mjs": BASE }, { "t.test.mjs": BASE.replace(/test\("multiplies".*\n/, "") });
    expect(marks.tests.size).toBe(0);
  });

  test("an edited base test file with nothing lost is marked edited", () => {
    const marks = marksFor({ "t.test.mjs": BASE }, { "t.test.mjs": `${BASE}test("divides", () => { assert.equal(4 / 2, 2); });\n` });
    expect(marks.files.get("t.test.mjs")).toBe("edited");
    expect(marks.tests.size).toBe(0);
  });

  test("weakened outranks edited, and an untouched test file or a source file has no mark", () => {
    const marks = marksFor(
      { "t.test.mjs": BASE, "u.test.mjs": BASE, "a.js": "export const a = 1;\n" },
      { "t.test.mjs": BASE.replace('test("adds"', 'test.todo("adds"'), "u.test.mjs": BASE, "a.js": "export const a = 2;\n" },
    );
    expect([...marks.files]).toEqual([["t.test.mjs", "weakened"]]);
  });

  test("a new test file, a renamed test alone and no changes mark nothing weakened", () => {
    expect(marksFor({ "a.js": "export const a = 1;\n" }, { "a.js": "export const a = 1;\n", "t.test.mjs": BASE }).files.size).toBe(0);
    const renamed = marksFor({ "t.test.mjs": BASE }, { "t.test.mjs": BASE.replace('"multiplies"', '"times"') });
    expect(renamed.files.get("t.test.mjs")).toBe("edited");
    expect(marksFor({ "t.test.mjs": BASE }, { "t.test.mjs": BASE }).files.size).toBe(0);
  });
});

describe("titlesOf", () => {
  test("reads the titles a test function's qualified name carries", () => {
    expect(titlesOf('describe("a") callback.test("b") callback')).toEqual(["a", "b"]);
    expect(titlesOf("map() callback")).toBeUndefined();
  });
});

describe("a marked test's room", () => {
  const SHEET = new Set(["floor", "floor-changed", "floor-test", "wall-x", "wall-y", "door-outside", "cone", "sign-test"]);
  const file = "file:t.test.mjs" as NodeId;
  const head = BASE.replace("assert.equal(1 + 1, 2)", "assert.ok(1 + 1)");

  function inside(sheet: ReadonlySet<string>) {
    const baseTree = treeOf({ "t.test.mjs": BASE });
    const headTree = treeOf({ "t.test.mjs": head });
    const graph = extract(headTree);
    const comparison = compare(extract(baseTree), graph, { base: baseTree, head: headTree });
    const marks = { ...marksOf(comparison, pictureOf(graph, comparison).overlay!, file, "t.test.mjs"), tests: testMarks(comparison, testChanges(baseTree, headTree)).tests.get("t.test.mjs") };
    return insideOf(graph, file, sheet, marks)!;
  }

  test("has the test floor and one sign; the other tests' rooms have neither", () => {
    const result = inside(SHEET);
    const room = result.rooms.find((candidate) => candidate.name === '"test(\\"adds\\") callback"')!;
    expect(room.testMarked).toBe(true);
    expect(result.rooms.filter((candidate) => candidate.testMarked)).toHaveLength(1);
    expect(result.floors.filter((tile) => tile.sprite === "floor-test").map((tile) => tile.room)).toEqual(Array(room.side * room.side).fill(room.id));
    expect(result.cones.filter((tile) => tile.sprite === "sign-test").map((tile) => tile.room)).toEqual([room.id]);
  });

  test("draws nothing the sheet has no sprite for", () => {
    const result = inside(new Set(["floor", "wall-x", "wall-y"]));
    expect(result.floors.every((tile) => tile.sprite === "floor")).toBe(true);
    expect(result.cones).toEqual([]);
  });
});
