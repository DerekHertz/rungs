import { expect, test } from "vitest";
import { extract } from "../src/extract/extract.ts";
import type { FileTree } from "../src/graph.ts";
import { detectRunner, observedDocument, parseNodeEvents, parseVitestJson, treeDigest } from "../src/observed.ts";
import type { TestReport, TestRun } from "../src/observed.ts";

const pkg = (scripts: object, extra: object = {}) => JSON.stringify({ scripts, ...extra });

test("node --test and vitest scripts are read; anything else is unsupported, never guessed", () => {
  const lock = new Map([["package-lock.json", "{}"]]);
  const cases: [string | undefined, ReadonlyMap<string, string>, unknown][] = [
    [pkg({ test: "node --test" }), new Map(), { runner: "node", args: [], install: false }],
    [pkg({ test: "node --test 'test/*.test.mjs' tools/x.test.mjs --test-reporter=spec" }), new Map(), { runner: "node", args: ["test/*.test.mjs", "tools/x.test.mjs"], install: false }],
    [pkg({ test: "vitest run --reporter=dot" }, { devDependencies: { vitest: "5" } }), lock, { runner: "vitest", args: [], install: true }],
    [pkg({ test: "vitest" }, { devDependencies: { vitest: "5" } }), lock, { runner: "vitest", args: [], install: true }],
    [pkg({ test: "vitest" }, { devDependencies: { vitest: "5" } }), new Map(), { unsupported: "package.json has dependencies but no package-lock.json; Rungs installs only from a lockfile" }],
    [pkg({ test: "jest" }), new Map(), { unsupported: 'the test script runs "jest"; Rungs reads only node --test and vitest' }],
    [pkg({ test: "node --test && echo done" }), new Map(), { unsupported: 'the test script is not one plain command: "node --test && echo done"' }],
    [pkg({ test: "NODE_ENV=test node --test" }), new Map(), { unsupported: 'the test script is not one plain command: "NODE_ENV=test node --test"' }],
    [pkg({ test: "node test.js" }), new Map(), { unsupported: 'the test script runs "node" without --test; Rungs reads only node --test and vitest' }],
    [pkg({}), new Map(), { unsupported: "package.json has no test script" }],
    ["{ not json", new Map(), { unsupported: "package.json is not valid JSON" }],
    [undefined, new Map(), { unsupported: "the tree has no package.json" }],
  ];
  for (const [json, rest, expected] of cases) {
    const tree = new Map(json === undefined ? rest : [["package.json", json], ...rest]);
    expect([json, detectRunner(tree)]).toEqual([json, expected]);
  }
});

test("node's events become reports with each test's suite path, suites themselves left out", () => {
  const lines = [
    { type: "test:pass", file: "test/a.test.mjs", name: "one", nesting: 1, kind: "test", ms: 0.5 },
    { type: "test:fail", file: "test/a.test.mjs", name: "two", nesting: 2, kind: "test", ms: 0.25, error: "boom" },
    { type: "test:fail", file: "test/a.test.mjs", name: "inner", nesting: 1, kind: "suite", ms: 1, error: "1 subtest failed" },
    { type: "test:pass", file: "test/b.test.mjs", name: "lone", nesting: 0, kind: "test", ms: 3 },
    { type: "test:fail", file: "test/a.test.mjs", name: "outer", nesting: 0, kind: "suite", ms: 2, error: "1 subtest failed" },
    { type: "test:pass", file: "test/a.test.mjs", name: "sub", nesting: 1, kind: "test", ms: 0.1 },
    { type: "test:pass", file: "test/a.test.mjs", name: "top", nesting: 0, kind: "test", ms: 1.2 },
    { type: "test:pass", file: "test/a.test.mjs", name: "skipped", nesting: 0, kind: "test", ms: 0.1, skip: true },
    { type: "test:pass", file: "test/a.test.mjs", name: "later", nesting: 0, kind: "test", ms: 0.1, todo: true },
  ];
  expect(parseNodeEvents(lines.map((line) => JSON.stringify(line)).join("\n"))).toEqual<TestReport[]>([
    { file: "test/a.test.mjs", path: ["outer", "one"], outcome: "pass", ms: 0.5 },
    { file: "test/a.test.mjs", path: ["outer", "inner", "two"], outcome: "fail", ms: 0.25, message: "boom" },
    { file: "test/b.test.mjs", path: ["lone"], outcome: "pass", ms: 3 },
    { file: "test/a.test.mjs", path: ["top", "sub"], outcome: "pass", ms: 0.1 },
    { file: "test/a.test.mjs", path: ["top"], outcome: "pass", ms: 1.2 },
    { file: "test/a.test.mjs", path: ["skipped"], outcome: "skip", ms: 0.1 },
    { file: "test/a.test.mjs", path: ["later"], outcome: "skip", ms: 0.1 },
  ]);
});

test("a line that is not one of the reporter's events is refused, not skipped", () => {
  expect(() => parseNodeEvents('{"type":"test:pass","file":7}')).toThrow("unreadable test event on line 1");
});

test("vitest's JSON becomes reports; a file that failed to load is a report for the whole file", () => {
  const json = {
    testResults: [
      {
        name: "/work/test/a.test.ts",
        status: "failed",
        message: "",
        assertionResults: [
          { ancestorTitles: ["outer"], title: "one", status: "passed", duration: 1.5 },
          { ancestorTitles: ["outer", "inner"], title: "two", status: "failed", duration: 2, failureMessages: ["Error: boom\n    at x"] },
          { ancestorTitles: [], title: "skipped", status: "skipped" },
          { ancestorTitles: [], title: "later", status: "todo" },
        ],
      },
      { name: "/work/test/b.test.ts", status: "failed", message: "Cannot find module './missing.ts'", assertionResults: [] },
    ],
  };
  expect(parseVitestJson(JSON.stringify(json), "/work")).toEqual<TestReport[]>([
    { file: "test/a.test.ts", path: ["outer", "one"], outcome: "pass", ms: 1.5 },
    { file: "test/a.test.ts", path: ["outer", "inner", "two"], outcome: "fail", ms: 2, message: "Error: boom\n    at x" },
    { file: "test/a.test.ts", path: ["skipped"], outcome: "skip", ms: 0 },
    { file: "test/a.test.ts", path: ["later"], outcome: "skip", ms: 0 },
    { file: "test/b.test.ts", path: [], outcome: "fail", ms: 0, message: "Cannot find module './missing.ts'" },
  ]);
});

const tests: FileTree = new Map([
  [
    "test/a.test.mjs",
    `import { describe, it, test } from "node:test";
describe("outer", () => {
  it("one", () => {});
  describe("in.ner", () => {
    it("two", () => {});
  });
});
test("same", () => {});
test("same", () => {});
test.skip("skipped", () => {});
test("top", async (t) => {
  await t.test("sub", () => {});
});
`,
  ],
]);
const graph = extract(tests);

const ran = (reports: TestReport[]): TestRun => ({ status: "ran", runner: "node", isolation: "bwrap", seconds: 2, exitCode: 1, reports });

test("reports attach to their test functions by file and name; the rest are listed, never dropped", () => {
  const reports: TestReport[] = [
    { file: "test/a.test.mjs", path: ["outer", "one"], outcome: "pass", ms: 1 },
    { file: "test/a.test.mjs", path: ["outer", "in.ner", "two"], outcome: "fail", ms: 2, message: "boom" },
    { file: "test/a.test.mjs", path: ["same"], outcome: "pass", ms: 3 },
    { file: "test/a.test.mjs", path: ["skipped"], outcome: "skip", ms: 0 },
    { file: "test/a.test.mjs", path: ["top", "sub"], outcome: "pass", ms: 4 },
    { file: "test/a.test.mjs", path: ["top"], outcome: "pass", ms: 5 },
    { file: "test/a.test.mjs", path: ["made up"], outcome: "fail", ms: 6 },
    { file: "test/gone.test.mjs", path: ["outer", "one"], outcome: "pass", ms: 7 },
  ];
  expect(observedDocument(ran(reports), graph, "d1")).toEqual({
    tier: "observed",
    tree: "d1",
    status: "ran",
    runner: "node",
    sandbox: "bwrap",
    seconds: 2,
    exitCode: 1,
    counts: { pass: 5, fail: 2, skip: 1 },
    tests: {
      'function:test/a.test.mjs#"describe(\\"outer\\") callback"."it(\\"one\\") callback"': [{ name: "outer > one", outcome: "pass", ms: 1 }],
      'function:test/a.test.mjs#"describe(\\"outer\\") callback"."describe(\\"in.ner\\") callback"."it(\\"two\\") callback"': [
        { name: "outer > in.ner > two", outcome: "fail", ms: 2, message: "boom" },
      ],
      'function:test/a.test.mjs#"skip(\\"skipped\\") callback"': [{ name: "skipped", outcome: "skip", ms: 0 }],
      'function:test/a.test.mjs#"test(\\"top\\") callback"."test(\\"sub\\") callback"': [{ name: "top > sub", outcome: "pass", ms: 4 }],
      'function:test/a.test.mjs#"test(\\"top\\") callback"': [{ name: "top", outcome: "pass", ms: 5 }],
    },
    unmatched: [
      { file: "test/a.test.mjs", name: "same", outcome: "pass", ms: 3, why: "2 test functions in the file have this name" },
      { file: "test/a.test.mjs", name: "made up", outcome: "fail", ms: 6, why: "no test function in the file has this name" },
      { file: "test/gone.test.mjs", name: "outer > one", outcome: "pass", ms: 7, why: "no test function in the file has this name" },
    ],
  });
});

test("a run that did not happen keeps only its reason", () => {
  expect(observedDocument({ status: "refused", why: "no sandbox" }, graph, "d2")).toEqual({ tier: "observed", tree: "d2", status: "refused", why: "no sandbox" });
});

test("the tree digest changes with any path or text and nothing else", () => {
  const one = treeDigest(new Map([["a", "1"], ["b", "2"]]));
  expect(one).toMatch(/^[0-9a-f]{32}$/);
  expect(treeDigest(new Map([["b", "2"], ["a", "1"]]))).toBe(one);
  expect(treeDigest(new Map([["a", "1"], ["b", "3"]]))).not.toBe(one);
  expect(treeDigest(new Map([["a", "1"], ["c", "2"]]))).not.toBe(one);
  expect(treeDigest(new Map([["a", "1\u0000b"]]))).not.toBe(treeDigest(new Map([["a", "1"], ["b", ""]])));
});
