import { describe, expect, test } from "vitest";
import { compare, pictureOf } from "../src/compare.ts";
import { extract } from "../src/extract/extract.ts";
import type { FileTree, NodeId } from "../src/graph.ts";
import { testChanges } from "../src/test-changes.ts";
import { testMarks, titlesOf } from "../src/test-marks.ts";
import { insideOf, marksOf } from "../src/town-inside.ts";
import { allBlocks, blockLabel, townOf } from "../src/town.ts";

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
  return testMarks(testChanges(baseTree, headTree, { places: true }));
}

describe("testMarks", () => {
  test("a removed, weakened or newly skipped test marks its file weakened", () => {
    const removed = marksFor({ "t.test.mjs": BASE }, { "t.test.mjs": BASE.replace(/test\("multiplies".*\n/, "") });
    expect(removed.files.get("t.test.mjs")).toBe("weakened");
    const skipped = marksFor({ "t.test.mjs": BASE }, { "t.test.mjs": BASE.replace('test("adds"', 'test.skip("adds"') });
    expect(skipped.files.get("t.test.mjs")).toBe("weakened");
    expect([...skipped.tests.get("t.test.mjs")!]).toEqual([{ start: 3, end: 3 }]);
    const weakened = marksFor({ "t.test.mjs": BASE }, { "t.test.mjs": BASE.replace("assert.equal(1 + 1, 2)", "assert.ok(1 + 1)") });
    expect(weakened.files.get("t.test.mjs")).toBe("weakened");
    expect([...weakened.tests.get("t.test.mjs")!]).toEqual([{ start: 3, end: 3 }]);
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

  test("a new test file is never marked, whatever it skips", () => {
    const marks = marksFor({ "a.js": "export const a = 1;\n" }, { "a.js": "export const a = 1;\n", "t.test.mjs": BASE.replace('test("adds"', 'test.skip("adds"') });
    expect(marks.files.size).toBe(0);
    expect(marks.tests.size).toBe(0);
  });

  test("a base test file named like a test outside a test folder is marked edited", () => {
    const marks = marksFor({ "test-foo.mjs": BASE }, { "test-foo.mjs": `${BASE}test("x", () => { assert.ok(1); });\n` });
    expect(marks.files.get("test-foo.mjs")).toBe("edited");
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
    const marks = { ...marksOf(comparison, pictureOf(graph, comparison).overlay!, file, "t.test.mjs"), tests: testMarks(testChanges(baseTree, headTree, { places: true })).tests.get("t.test.mjs") };
    return insideOf(graph, file, sheet, marks)!;
  }

  function markedRooms(base: string, headText: string): string[] {
    const baseTree = treeOf({ "t.test.mjs": base });
    const headTree = treeOf({ "t.test.mjs": headText });
    const graph = extract(headTree);
    const tests = testMarks(testChanges(baseTree, headTree, { places: true })).tests.get("t.test.mjs");
    const marks = { ...marksOf(compare(extract(baseTree), graph), pictureOf(graph, compare(extract(baseTree), graph)).overlay!, file, "t.test.mjs"), tests };
    return insideOf(graph, file, SHEET, marks)!.rooms.filter((room) => room.testMarked).map((room) => room.name);
  }

  test("two tests with one title: no room is marked, the file still is", () => {
    const base = 'import test from "node:test";\ntest("a", () => { 1; });\ntest("a", () => { 2; });\n';
    const next = 'import test from "node:test";\ntest("a", () => { 1; });\ntest.skip("a", () => { 2; });\n';
    expect(markedRooms(base, next)).toEqual([]);
    expect(marksFor({ "t.test.mjs": base }, { "t.test.mjs": next }).files.get("t.test.mjs")).toBe("weakened");
  });

  test("a skipped test whose callback is named, or which uses each, still has its room marked", () => {
    const base = 'import test from "node:test";\ntest("a", function check() { 1; });\ntest("b", () => { 2; });\n';
    expect(markedRooms(base, base.replace('test("a"', 'test.skip("a"'))).toEqual(["check"]);
    const withEach = 'import test from "node:test";\ntest("a", () => { 1; });\ntest("b", () => { 2; });\n';
    expect(markedRooms(withEach, withEach.replace('test("a", () => { 1; });', 'test.skip.each([1])("a", () => {\n  1;\n});'))).toHaveLength(1);
  });

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

describe("a block's count of marked test files", () => {
  const SHEET = new Set(["workshop-1", "lab-1", "scaffold-1", "crane"]);
  const before = treeOf({ "test/a.test.mjs": BASE, "test/deep/b.test.mjs": BASE, "test/c.test.mjs": BASE, "src/s.js": "export const s = 1;\n" });
  const after = treeOf({
    "test/a.test.mjs": BASE.replace('test("adds"', 'test.skip("adds"'),
    "test/deep/b.test.mjs": `${BASE}test("more", () => { assert.ok(1); });\n`,
    "test/c.test.mjs": BASE,
    "src/s.js": "export const s = 2;\n",
  });
  const comparison = compare(extract(before), extract(after), { base: before, head: after });
  const marks = testMarks(testChanges(before, after, { places: true }));

  test("counts weakened and edited test files, nested folders included, and no source file", () => {
    const town = townOf(extract(after), SHEET, comparison, [], new Set(marks.files.keys()));
    const block = (name: string) => allBlocks(town).find((candidate) => candidate.name === name)!;
    expect(block("test").testsChanged).toBe(2);
    expect(block("deep").testsChanged).toBe(1);
    expect(block("src").testsChanged).toBe(0);
    expect(blockLabel(block("test"), true, true)).toMatch(/ · ⚠ 2 tests changed$/);
    expect(blockLabel(block("deep"), true, true)).toMatch(/ · ⚠ 1 test changed$/);
    expect(blockLabel(block("src"), true, true)).not.toContain("⚠");
  });

  test("shows nothing without marked files", () => {
    expect(allBlocks(townOf(extract(after), SHEET, comparison)).every((block) => block.testsChanged === 0)).toBe(true);
  });
});
