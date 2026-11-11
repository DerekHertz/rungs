import { describe, expect, test } from "vitest";
import { testChanges } from "../src/test-changes.ts";
import type { FileTree } from "../src/graph.ts";

const tree = (files: Record<string, string>): FileTree => new Map(Object.entries(files));
const T = "test/a.test.mjs";

/** The test file's text with these bodies, written the way node's runner tests are. */
const file = (...tests: string[]) => `import { test, describe, it } from "node:test";\nimport assert from "node:assert/strict";\n${tests.join("\n")}\n`;
const change = (before: string, after: string) => testChanges(tree({ [T]: before }), tree({ [T]: after }));

describe("files", () => {
  test("a base test file the head no longer has is deleted, with the number of tests it held", () => {
    const base = tree({ [T]: file('test("one", () => { assert.equal(1, 1 + 0); });', 'test("two", () => { assert.equal(2, 1 + 1); });'), "src/a.ts": "export {};\n" });
    expect(testChanges(base, tree({ "src/a.ts": "export {};\n" }))).toMatchObject({ deletedFiles: [{ path: T, tests: 2 }] });
  });

  test("identical files do not hide a deletion: a move pairs one deleted file with one added file", () => {
    const text = file('test("one", () => { assert.equal(1, 1 + 0); });');
    const result = testChanges(tree({ "test/a.test.mjs": text, "test/b.test.mjs": text }), tree({ "test/b.test.mjs": text }));
    expect(result.deletedFiles).toEqual([{ path: "test/a.test.mjs", tests: 1 }]);
    const moved = testChanges(tree({ "test/a.test.mjs": text, "test/b.test.mjs": text }), tree({ "test/b.test.mjs": text, "test/c.test.mjs": text }));
    expect(moved.deletedFiles).toEqual([]);
    const twice = testChanges(tree({ "test/a.test.mjs": text, "test/b.test.mjs": text }), tree({ "test/c.test.mjs": text }));
    expect(twice.deletedFiles).toHaveLength(1);
  });

  test("a move counts only while the new path is still found as a test by node --test", () => {
    const text = file('test("one", () => { assert.equal(1, 1 + 0); });');
    const result = (to: string) => testChanges(tree({ "test/a.test.mjs": text }), tree({ [to]: text })).deletedFiles;
    expect(result("archived.mjs")).toEqual([{ path: "test/a.test.mjs", tests: 1, movedTo: "archived.mjs" }]);
    expect(result("tests/a.test.mjs.bak")).toEqual([{ path: "test/a.test.mjs", tests: 1, movedTo: "tests/a.test.mjs.bak" }]);
    expect(result("tests/foo.mjs")).toEqual([{ path: "test/a.test.mjs", tests: 1, movedTo: "tests/foo.mjs" }]);
    for (const found of ["test/b.test.mjs", "src/x.test.js", "lib/y-test.mjs", "test-z.cjs", "test/sub/anything.mjs", "src/a_test.mjs"]) expect([found, result(found)]).toEqual([found, []]);
  });

  test("a test file moved with its text unchanged is not deleted", () => {
    const text = file('test("one", () => { assert.equal(1, 1 + 0); });');
    expect(testChanges(tree({ [T]: text }), tree({ "test/b.test.mjs": text })).deletedFiles).toEqual([]);
  });

  test("a file that is not a test is never reported", () => {
    expect(testChanges(tree({ "src/a.ts": "test('x', () => {})" }), tree({})).deletedFiles).toEqual([]);
  });

  test("an unchanged tree has nothing to report", () => {
    const same = tree({ [T]: file('test("one", () => { assert.equal(1, 1 + 0); });') });
    expect(testChanges(same, same)).toEqual({ deletedFiles: [], removedTests: [], renamed: [], markers: [], weakened: [] });
  });
});

describe("removed tests", () => {
  test("a test gone from a file that stays is removed by name, with its suite", () => {
    const before = file('describe("sum", () => {\n it("adds", () => { assert.equal(add(1, 1), 2); });\n it("carries", () => { assert.equal(add(9, 1), 10); });\n});');
    const after = file('describe("sum", () => {\n it("adds", () => { assert.equal(add(1, 1), 2); });\n});');
    expect(change(before, after).removedTests).toEqual([{ file: T, name: "sum > carries" }]);
  });

  test("a renamed test is not a removal, and a renamed one beside others is paired only when unambiguous", () => {
    const before = file('test("old", () => { assert.equal(f(), 1); });');
    const after = file('test("new", () => { assert.equal(f(), 1); });');
    expect(change(before, after)).toMatchObject({ removedTests: [], renamed: [{ file: T, from: "old", to: "new" }] });
  });

  test("a test added is not a removal", () => {
    const before = file('test("one", () => { assert.equal(f(), 1); });');
    expect(change(before, file('test("one", () => { assert.equal(f(), 1); });', 'test("two", () => { assert.equal(f(), 2); });')).removedTests).toEqual([]);
  });

  test("a duplicated title removed once is still removed once", () => {
    const one = 'test("same", () => { assert.equal(f(), 1); });';
    expect(change(file(one, one), file(one)).removedTests).toEqual([{ file: T, name: "same" }]);
  });

  test("a deleted file is reported as deleted, not once per test", () => {
    const result = testChanges(tree({ [T]: file('test("one", () => { assert.equal(f(), 1); });') }), tree({}));
    expect(result.removedTests).toEqual([]);
  });
});

describe("skip, todo and only", () => {
  const body = 'assert.equal(f(), 1);';
  const cases: [string, string, string, "skip" | "todo" | "only"][] = [
    ["test.skip", `test("t", () => { ${body} });`, `test.skip("t", () => { ${body} });`, "skip"],
    ["it.todo", `it("t", () => { ${body} });`, `it.todo("t", () => { ${body} });`, "todo"],
    ["test.only", `test("t", () => { ${body} });`, `test.only("t", () => { ${body} });`, "only"],
    ["xit", `it("t", () => { ${body} });`, `xit("t", () => { ${body} });`, "skip"],
    ["fit", `it("t", () => { ${body} });`, `fit("t", () => { ${body} });`, "only"],
    ["the skip option", `test("t", () => { ${body} });`, `test("t", { skip: true }, () => { ${body} });`, "skip"],
    ["the skip option with a reason", `test("t", () => { ${body} });`, `test("t", { skip: "flaky" }, () => { ${body} });`, "skip"],
    ["skipIf", `test("t", () => { ${body} });`, `test.skipIf(process.env.CI)("t", () => { ${body} });`, "skip"],
    ["t.skip() inside the test", `test("t", (t) => { ${body} });`, `test("t", (t) => { t.skip(); ${body} });`, "skip"],
  ];
  test.each(cases)("%s is added", (_name, before, after, marker) => {
    expect(change(file(before), file(after)).markers).toEqual([{ file: T, name: "t", marker }]);
  });

  test("a skipped describe is reported on the describe", () => {
    const before = file('describe("s", () => { it("a", () => { assert.equal(f(), 1); }); });');
    const after = file('describe.skip("s", () => { it("a", () => { assert.equal(f(), 1); }); });');
    expect(change(before, after).markers).toEqual([{ file: T, name: "s", marker: "skip" }]);
  });

  test("a subtest of a node test is found by its name path, whatever the context is called", () => {
    const before = file('test("parent", async (t) => { await t.test("child", () => { assert.equal(f(), 1); }); });');
    const after = file('test("parent", async (t) => { await t.test("child", { skip: true }, () => { assert.equal(f(), 1); }); });');
    expect(change(before, after).markers).toEqual([{ file: T, name: "parent > child", marker: "skip" }]);
    expect(change(before, file('test("parent", async (ctx) => { await ctx.test.skip("child", () => { assert.equal(f(), 1); }); });')).markers).toEqual([{ file: T, name: "parent > child", marker: "skip" }]);
    expect(change(before, file('test("parent", async (t) => {});')).removedTests).toEqual([{ file: T, name: "parent > child" }]);
    expect(change(before, file('test("parent", async (t) => { await t.test("child", () => {}); });')).weakened).toEqual([{ file: T, name: "parent > child", why: "1 assertion became 0" }]);
  });

  test("skip() or todo() called on the test's context is found, whatever the parameter is called", () => {
    const before = (p: string) => file(`test("t", (${p}) => { assert.equal(f(), 1); });`);
    for (const [name, call, marker] of [["t", "t.skip()", "skip"], ["ctx", "ctx.skip('why')", "skip"], ["context", "context.todo()", "todo"], ["x", "x.todo('later')", "todo"]] as const) {
      expect([name, change(before(name), file(`test("t", (${name}) => { ${call}; assert.equal(f(), 1); });`)).markers]).toEqual([name, [{ file: T, name: "t", marker }]]);
    }
    const nested = file('test("parent", async (a) => { await a.test("child", (b) => { b.skip(); }); });');
    expect(change(file('test("parent", async (a) => { await a.test("child", (b) => {}); });'), nested).markers).toEqual([{ file: T, name: "parent > child", marker: "skip" }]);
    expect(change(before("t"), file('test("t", (t) => { other.skip(); assert.equal(f(), 1); });')).markers).toEqual([]);
  });

  test("a skip that was already there is not new", () => {
    const text = file('test.skip("t", () => { assert.equal(f(), 1); });');
    expect(change(text, text).markers).toEqual([]);
  });

  test("{ skip: false } skips nothing", () => {
    expect(change(file('test("t", () => { assert.equal(f(), 1); });'), file('test("t", { skip: false }, () => { assert.equal(f(), 1); });')).markers).toEqual([]);
  });

  test("a new test that is skipped is added as skipped", () => {
    expect(change(file(), file('test.skip("t", () => {});')).markers).toEqual([{ file: T, name: "t", marker: "skip" }]);
  });

  test("a skip in a new file is found too", () => {
    expect(testChanges(tree({}), tree({ [T]: file('test.only("t", () => {});') })).markers).toEqual([{ file: T, name: "t", marker: "only" }]);
  });
});

describe("weakened tests", () => {
  test("fewer assertions", () => {
    const before = file('test("t", () => { assert.equal(f(), 1); assert.equal(g(), 2); });');
    const after = file('test("t", () => { assert.equal(f(), 1); });');
    expect(change(before, after).weakened).toEqual([{ file: T, name: "t", why: "2 assertions became 1" }]);
  });

  test("expect chains count once each, whatever the modifiers", () => {
    const before = file('test("t", () => { expect(f()).toBe(1); expect(g()).not.toBe(2); expect(h()).resolves.toEqual(3); });');
    const after = file('test("t", () => { expect(f()).toBe(1); });');
    expect(change(before, after).weakened).toEqual([{ file: T, name: "t", why: "3 assertions became 1" }]);
  });

  test("the property: a test edited to assert.ok(true) is weakened though it has as many assertions", () => {
    const before = file('test("t", () => { assert.equal(f(), 1); });');
    const after = file('test("t", () => { assert.ok(true); });');
    const found = change(before, after).weakened;
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ file: T, name: "t" });
  });

  test("a constant assertion added", () => {
    const before = file('test("t", () => { assert.equal(f(), 1); });');
    expect(change(before, file('test("t", () => { assert.equal(f(), 1); assert.equal(1, 1); });')).weakened).toEqual([
      { file: T, name: "t", why: "1 assertion of constants added" },
    ]);
    expect(change(before, file('test("t", () => { assert.equal(f(), 1); expect(true).toBe(true); });')).weakened).toHaveLength(1);
  });

  test("an exact assertion swapped for a loose one", () => {
    const before = file('test("t", () => { assert.equal(f(), 1); });');
    expect(change(before, file('test("t", () => { assert.ok(f()); });')).weakened).toEqual([{ file: T, name: "t", why: "1 assertion loosened (ok, toBeTruthy, toBeDefined, a bare assert, or equal in place of strictEqual)" }]);
    expect(change(file('test("t", () => { expect(f()).toBe(1); });'), file('test("t", () => { expect(f()).toBeTruthy(); });')).weakened).toHaveLength(1);
    expect(change(file('test("t", () => { expect(f()).toBe(1); });'), file('test("t", () => { expect(f()).toBeDefined(); });')).weakened).toHaveLength(1);
    expect(change(before, file('test("t", () => { assert(f()); });')).weakened).toHaveLength(1);
  });

  test("a strict assertion swapped for its coercing twin is loosened", () => {
    for (const [strict, legacy] of [["strictEqual", "equal"], ["deepStrictEqual", "deepEqual"], ["notStrictEqual", "notEqual"], ["notDeepStrictEqual", "notDeepEqual"]]) {
      const head = `import assert from "node:assert";\n`;
      const before = `${head}import { test } from "node:test";\ntest("t", () => { assert.${strict}(f(), 1); });\n`;
      const after = `${head}import { test } from "node:test";\ntest("t", () => { assert.${legacy}(f(), 1); });\n`;
      expect([strict, change(before, after).weakened.length]).toEqual([strict, 1]);
    }
  });

  test("switching the import from node:assert/strict to node:assert loosens every equal in it", () => {
    const body = 'test("t", () => { assert.equal(f(), 1); });';
    const before = `import assert from "node:assert/strict";\nimport { test } from "node:test";\n${body}\n`;
    const after = `import assert from "node:assert";\nimport { test } from "node:test";\n${body}\n`;
    expect(change(before, after).weakened).toHaveLength(1);
    expect(change(after, after).weakened).toEqual([]);
    expect(change(after, before).weakened).toEqual([]);
  });

  test("what assert is bound to decides whether equal is strict, however it was imported", () => {
    const body = 'test("t", () => { assert.equal(f(), 1); });';
    const strict = [
      'import assert from "node:assert/strict";',
      'import { strict as assert } from "node:assert";',
      'import assert from "assert/strict";',
      'import * as assert from "node:assert/strict";',
      'const assert = require("node:assert").strict;',
      'const assert = require("node:assert/strict");',
      'const { strict: assert } = require("node:assert");',
      'import nodeAssert from "node:assert";\nconst assert = nodeAssert.strict;',
    ];
    const legacy = [
      'import assert from "node:assert";',
      'import * as assert from "assert";',
      'const assert = require("node:assert");',
    ];
    const make = (head: string) => `${head}\nimport { test } from "node:test";\n${body}\n`;
    for (const was of strict) {
      for (const now of legacy) expect([was, now, change(make(was), make(now)).weakened.length]).toEqual([was, now, 1]);
      for (const now of strict) expect([was, now, change(make(was), make(now)).weakened.length]).toEqual([was, now, 0]);
    }
    for (const was of legacy) for (const now of legacy) expect(change(make(was), make(now)).weakened).toEqual([]);
  });

  test("assertions imported by name and called bare are held to the same rule", () => {
    const make = (head: string, call: string) => `${head}\nimport { test } from "node:test";\ntest("t", () => { ${call}(f(), 1); });\n`;
    expect(change(make('import { strictEqual } from "node:assert";', "strictEqual"), make('import { equal } from "node:assert";', "equal")).weakened).toHaveLength(1);
    expect(change(make('import { equal } from "node:assert/strict";', "equal"), make('import { equal } from "node:assert";', "equal")).weakened).toHaveLength(1);
    expect(change(make('import { equal } from "node:assert";', "equal"), make('import { equal } from "node:assert";', "equal")).weakened).toEqual([]);
  });

  test("a stricter or equal test is not weakened", () => {
    const before = file('test("t", () => { assert.ok(f()); });');
    expect(change(before, file('test("t", () => { assert.ok(f()); assert.equal(g(), 2); });')).weakened).toEqual([]);
    expect(change(before, file('test("t", () => { assert.equal(f(), 1); });')).weakened).toEqual([]);
    expect(change(before, before).weakened).toEqual([]);
  });

  test("assertions outside any test are compared as one group", () => {
    const before = file('assert.equal(f(), 1);\ntest("t", () => {});');
    expect(change(before, file('test("t", () => {});')).weakened).toEqual([{ file: T, name: "(outside any test)", why: "1 assertion became 0" }]);
  });

  test("assertions in a nested test belong to it and not to the suite", () => {
    const before = file('describe("s", () => { it("a", () => { assert.equal(f(), 1); }); });');
    const after = file('describe("s", () => { it("a", () => { assert.equal(f(), 1); }); it("b", () => { assert.ok(true); }); });');
    expect(change(before, after).weakened).toEqual([]);
  });

  test("a test added with a constant assertion is not a weakening of anything", () => {
    expect(change(file(), file('test("t", () => { assert.ok(true); });')).weakened).toEqual([]);
  });

  test("assertion calls are recognised as t.assert, assert.strict and strict", () => {
    const before = file('test("t", (t) => { t.assert.equal(f(), 1); assert.strict.equal(g(), 1); strict.equal(h(), 1); });');
    expect(change(before, file('test("t", (t) => {});')).weakened).toEqual([{ file: T, name: "t", why: "3 assertions became 0" }]);
  });

  test("a function that merely has an assertion-like name is not an assertion", () => {
    const before = file('test("t", () => { assert.equal(f(), 1); });');
    expect(change(before, file('test("t", () => { assert.equal(f(), 1); notassert.ok(true); myexpect(true); });')).weakened).toEqual([]);
  });
});

describe("files that are not test code", () => {
  test("only JavaScript and TypeScript test files are read for tests", () => {
    const result = testChanges(tree({ "test/a_test.py": "def test_a():\n    assert f() == 1\n" }), tree({ "test/a_test.py": "def test_a():\n    pass\n" }));
    expect(result).toEqual({ deletedFiles: [], removedTests: [], renamed: [], markers: [], weakened: [] });
  });

  test("a test file that does not parse is read as far as it goes and never throws", () => {
    expect(() => change(file('test("t", () => { assert.equal(f(), 1); });'), 'test("t", () => { assert.equal(')).not.toThrow();
  });

  test("typescript test files and .spec files are read", () => {
    const before = tree({ "src/a.spec.ts": 'import { it } from "vitest";\nit("t", () => { expect(f()).toBe(1 as number); });\n' });
    const after = tree({ "src/a.spec.ts": 'import { it } from "vitest";\nit.skip("t", () => { expect(f()).toBe(1 as number); });\n' });
    expect(testChanges(before, after).markers).toEqual([{ file: "src/a.spec.ts", name: "t", marker: "skip" }]);
  });
});

describe("renamed tests", () => {
  const two = (name: string) => `test("${name}", () => { assert.equal(f(), 1); assert.equal(g(), 2); });`;

  test("one test lost and one gained in the same place is a rename, not a removal", () => {
    const result = change(file(two("a local require is not a resolution")), file(two("a local require is not a resolution or an effect")));
    expect(result.renamed).toEqual([{ file: T, from: "a local require is not a resolution", to: "a local require is not a resolution or an effect" }]);
    expect(result.removedTests).toEqual([]);
    expect(result.weakened).toEqual([]);
  });

  test("a rename that gains assertions is a stronger test and is not weakened", () => {
    const result = change(file(two("old")), file('test("new", () => { assert.equal(f(), 1); assert.equal(g(), 2); assert.equal(h(), 3); });'));
    expect(result).toMatchObject({ renamed: [{ from: "old", to: "new" }], removedTests: [], weakened: [] });
  });

  test("a rename that loses assertions is still reported as weakened", () => {
    const result = change(file(two("old")), file('test("new", () => { assert.equal(f(), 1); });'));
    expect(result.removedTests).toEqual([]);
    expect(result.weakened).toEqual([{ file: T, name: "new", why: 'renamed from "old"; 2 assertions became 1' }]);
  });

  test("the same body at another place in the describe is a rename too", () => {
    const before = file('describe("s", () => { test("x", () => { assert.equal(1, f()); }); test("old", () => { assert.equal(2, f()); }); });');
    const after = file('describe("s", () => { test("new", () => { assert.equal(2, f()); }); test("x", () => { assert.equal(1, f()); }); });');
    expect(change(before, after)).toMatchObject({ renamed: [{ from: "s > old", to: "s > new" }], removedTests: [] });
  });

  test("a different body at a different place is a removal and an addition, not a guess", () => {
    const before = file('describe("s", () => { test("x", () => { assert.equal(1, f()); }); test("old", () => { assert.equal(2, f()); }); });');
    const after = file('describe("s", () => { test("fresh", () => { assert.equal(3, f()); }); test("x", () => { assert.equal(1, f()); }); });');
    expect(change(before, after)).toMatchObject({ renamed: [], removedTests: [{ name: "s > old" }] });
  });

  test("several lost or gained in one describe is ambiguous and stays removed", () => {
    const result = change(file(two("a"), two("b")), file(two("c"), two("d")));
    expect(result.renamed).toEqual([]);
    expect(result.removedTests.map((r) => r.name)).toEqual(["a", "b"]);
    const oneForTwo = change(file(two("a"), two("b")), file(two("c")));
    expect(oneForTwo.renamed).toEqual([]);
    expect(oneForTwo.removedTests).toHaveLength(2);
  });

  test("a test lost in one describe and gained in another is not paired", () => {
    const result = change(file('describe("p", () => { test("a", () => { assert.equal(f(), 1); }); });'), file('describe("q", () => { test("a", () => { assert.equal(f(), 1); }); });'));
    expect(result.renamed).toEqual([]);
    expect(result.removedTests).toEqual([{ file: T, name: "p > a" }]);
  });

  test("a test that keeps its name is never paired", () => {
    const result = change(file(two("keep"), two("gone")), file(two("keep"), two("new")));
    expect(result.renamed).toEqual([{ file: T, from: "gone", to: "new" }]);
    expect(result.removedTests).toEqual([]);
  });
});

describe("renamed tests: when in doubt, removed", () => {
  test("callbacks whose text is unknown never establish equality", () => {
    const before = file('test("keep", () => {});', 'test("old", oldFn);');
    const after = file('test("new", newFn);', 'test("keep", () => {});');
    expect(change(before, after)).toMatchObject({ renamed: [], removedTests: [{ name: "old" }] });
  });

  test("empty bodies are not known, even at the same place", () => {
    const result = change(file('test("old", () => {});'), file('test("new", () => {});'));
    expect(result).toMatchObject({ renamed: [], removedTests: [{ name: "old" }] });
  });

  test("a renamed skipped test is not a newly skipped test", () => {
    const body = "() => { assert.equal(f(), 1); }";
    const result = change(file(`test.skip("old", ${body});`), file(`test.skip("new", ${body});`));
    expect(result.renamed).toEqual([{ file: T, from: "old", to: "new" }]);
    expect(result.markers).toEqual([]);
  });

  test("a renamed test that gains a skip is still reported as skipped", () => {
    const body = "() => { assert.equal(f(), 1); }";
    expect(change(file(`test("old", ${body});`), file(`test.skip("new", ${body});`)).markers).toEqual([{ file: T, name: "new", marker: "skip" }]);
  });

  test("duplicate names still advance the place, so a shifted test is not paired by ordinal", () => {
    const before = file('test("dup", () => { assert.equal(1, 1 + 0); });', 'test("dup", () => { assert.equal(2, 1 + 1); });', 'test("old", () => { assert.equal(f(), 1); });');
    const after = file('test("dup", () => { assert.equal(1, 1 + 0); });', 'test("new", () => { assert.equal(g(), 2); });', 'test("dup", () => { assert.equal(2, 1 + 1); });');
    expect(change(before, after)).toMatchObject({ renamed: [], removedTests: [{ name: "old" }] });
  });

  test("losing some of a duplicated name is a loss that makes the path ambiguous", () => {
    const run = "() => { assert.equal(f(), 1); }";
    const before = file(`test("dup", ${run});`, `test("dup", ${run});`, `test("old", ${run});`);
    const after = file(`test("dup", ${run});`, `test("new", ${run});`);
    const result = change(before, after);
    expect(result.renamed).toEqual([]);
    expect(result.removedTests.map((r) => r.name).sort()).toEqual(["dup", "old"]);
  });

  test("a describe titled with the separator is not the same path as a nested describe", () => {
    const run = "() => { assert.equal(f(), 1); }";
    const before = file(`describe("a > b", () => { test("old", ${run}); });`);
    const after = file(`describe("a", () => { describe("b", () => { test("new", ${run}); }); });`);
    expect(change(before, after)).toMatchObject({ renamed: [], removedTests: [{ name: "a > b > old" }] });
  });
});
