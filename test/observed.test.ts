import { expect, test } from "vitest";
import { extract } from "../src/extract/extract.ts";
import type { FileTree } from "../src/graph.ts";
import { detectRunner, installNeeded, observedDocument, parseNodeEvents, treeDigest, unreliable } from "../src/observed.ts";
import type { TestReport, TestRun } from "../src/observed.ts";

const pkg = (scripts: object, extra: object = {}) => JSON.stringify({ scripts, ...extra });

const BASE_ONLY = "Systems to Streets reads only node --test";
const FLAG_NOTE = "Systems to Streets runs node --test only with flags that keep the tree's code out of the runner";

test("the base's node --test script is read; vitest and anything else is unsupported, never guessed", () => {
  const cases: [string | undefined, unknown][] = [
    [pkg({ test: "node --test" }), { runner: "node", flags: [], files: [] }],
    [pkg({ test: "node --test 'test/*.test.mjs' tools/x.test.mjs --test-reporter=spec" }), { runner: "node", flags: [], files: ["test/*.test.mjs", "tools/x.test.mjs"] }],
    [pkg({ test: "vitest run --reporter=dot" }, { devDependencies: { vitest: "5" } }), { unsupported: "vitest is chosen by the PR" }],
    [pkg({ test: "vitest" }), { unsupported: "vitest is chosen by the PR" }],
    [pkg({ test: "jest" }), { unsupported: `the test script runs "jest"; ${BASE_ONLY}` }],
    [pkg({ test: "node --test && echo done" }), { unsupported: 'the test script is not one plain command: "node --test && echo done"' }],
    [pkg({ test: "NODE_ENV=test node --test" }), { unsupported: 'the test script is not one plain command: "NODE_ENV=test node --test"' }],
    // Anything that would load the tree's code into the runner itself, or run the tests inside it.
    [pkg({ test: "node --test --import ./setup.mjs" }), { unsupported: `the test script gives node "--import"; ${FLAG_NOTE}` }],
    [pkg({ test: "node --experimental-test-isolation=none --test" }), { unsupported: `the test script gives node "--experimental-test-isolation=none"; ${FLAG_NOTE}` }],
    [pkg({ test: "node -r ./setup.cjs --test" }), { unsupported: `the test script gives node "-r"; ${FLAG_NOTE}` }],
    [pkg({ test: "node --test --test-concurrency=1 --test-timeout 500 --experimental-strip-types a.test.ts" }), { runner: "node", flags: ["--test-concurrency=1", "--test-timeout=500", "--experimental-strip-types"], files: ["a.test.ts"] }],
    [pkg({ test: "node test.js" }), { unsupported: `the test script runs "node" without --test; ${BASE_ONLY}` }],
    [pkg({}), { unsupported: "the base's package.json has no test script" }],
    ["{ not json", { unsupported: "the base's package.json is not valid JSON" }],
    [undefined, { unsupported: "the base has no package.json" }],
  ];
  cases.push(
    // A flag's value belongs to the flag, in either spelling, and is never taken for a file.
    [pkg({ test: "node --test --test-timeout 5000 a.test.mjs b.test.mjs" }), { runner: "node", flags: ["--test-timeout=5000"], files: ["a.test.mjs", "b.test.mjs"] }],
    [pkg({ test: "node --test --test-timeout=5000 a.test.mjs" }), { runner: "node", flags: ["--test-timeout=5000"], files: ["a.test.mjs"] }],
    [pkg({ test: "node --test --test-name-pattern adds --test-skip-pattern slow --test-concurrency 2 --test-shard 1/2 a.test.mjs" }), { runner: "node", flags: ["--test-name-pattern=adds", "--test-skip-pattern=slow", "--test-concurrency=2", "--test-shard=1/2"], files: ["a.test.mjs"] }],
    [pkg({ test: "node --test --test-only --test-force-exit a.test.mjs" }), { runner: "node", flags: ["--test-only", "--test-force-exit"], files: ["a.test.mjs"] }],
    // The reporter is ours: the script's, with its destination, is dropped whole.
    [pkg({ test: "node --test --test-reporter spec --test-reporter-destination stdout a.test.mjs" }), { runner: "node", flags: [], files: ["a.test.mjs"] }],
    [pkg({ test: "node --test --test-reporter=spec a.test.mjs" }), { runner: "node", flags: [], files: ["a.test.mjs"] }],
    [pkg({ test: "node --test a.test.mjs --test-timeout" }), { unsupported: 'the test script gives "--test-timeout" no value' }],
  );
  for (const [json, expected] of cases) expect([json, detectRunner(new Map(json === undefined ? [] : [["package.json", json]]))]).toEqual([json, expected]);
});

test("the head's dependencies are installed from a lockfile only", () => {
  const lock = new Map([["package-lock.json", "{}"]]);
  const deps = pkg({ test: "node --test" }, { devDependencies: { x: "1" } });
  expect(installNeeded(new Map([["package.json", pkg({ test: "node --test" })]]))).toEqual({ install: false });
  expect(installNeeded(new Map([["package.json", deps], ...lock]))).toEqual({ install: true });
  expect(installNeeded(new Map([["package.json", deps]]))).toEqual({ unsupported: "package.json has dependencies but no package-lock.json; Systems to Streets installs only from a lockfile" });
  expect(installNeeded(new Map([["package.json", "{ not json"]]))).toEqual({ unsupported: "the head's package.json is not valid JSON" });
});

test("node's events become reports with each test's suite path, suites themselves left out", () => {
  const lines = [
    { type: "test:pass", file: "test/a.test.mjs", name: "one", nesting: 1, kind: "test", ms: 0.5 },
    { type: "test:fail", file: "test/a.test.mjs", name: "two", nesting: 2, kind: "test", ms: 0.25, error: "boom" },
    { type: "test:fail", file: "test/a.test.mjs", name: "inner", nesting: 1, kind: "suite", ms: 1, error: "1 subtest failed", failure: "subtestsFailed" },
    { type: "test:pass", file: "test/b.test.mjs", name: "lone", nesting: 0, kind: "test", ms: 3 },
    { type: "test:fail", file: "test/a.test.mjs", name: "outer", nesting: 0, kind: "suite", ms: 2, error: "1 subtest failed", failure: "subtestsFailed" },
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

test("a suite that failed on its own, in a hook, is a failure of its own and is not dropped; one that only holds a failed test is not counted twice", () => {
  const lines = [
    { type: "test:pass", file: "a.test.mjs", name: "passes", nesting: 1, kind: "test", ms: 1 },
    { type: "test:fail", file: "a.test.mjs", name: "suite", nesting: 0, kind: "suite", ms: 2, error: "after hook broke" },
    { type: "test:fail", file: "b.test.mjs", name: "fails", nesting: 1, kind: "test", ms: 1, error: "no" },
    { type: "test:fail", file: "b.test.mjs", name: "holder", nesting: 0, kind: "suite", ms: 2, error: "1 subtest failed", failure: "subtestsFailed" },
  ];
  expect(parseNodeEvents(lines.map((line) => JSON.stringify(line)).join("\n"))).toEqual<TestReport[]>([
    { file: "a.test.mjs", path: ["suite", "passes"], outcome: "pass", ms: 1 },
    { file: "a.test.mjs", path: ["suite"], outcome: "fail", ms: 2, message: "after hook broke", suite: true },
    { file: "b.test.mjs", path: ["holder", "fails"], outcome: "fail", ms: 1, message: "no" },
  ]);
});

test("a line that is not one of the reporter's events is refused, not skipped", () => {
  expect(() => parseNodeEvents('{"type":"test:pass","file":7}')).toThrow("unreadable test event on line 1");
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

const ran = (reports: TestReport[], more: Partial<Extract<TestRun, { status: "ran" }>> = {}): TestRun => ({ status: "ran", runner: "node", isolation: "bwrap", seconds: 2, exitCode: 1, reports, deleted: [], edited: [], ...more });

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
    deleted: [],
    edited: [],
    written: null,
  });
});

test("a result from a file the PR edited or deleted is not put on the head's test function, and says which it was", () => {
  const reports: TestReport[] = [
    { file: "test/a.test.mjs", path: ["outer", "one"], outcome: "fail", ms: 1, message: "main's expectation" },
    { file: "test/old.test.mjs", path: ["gone"], outcome: "pass", ms: 2 },
  ];
  const document = observedDocument(ran(reports, { edited: ["test/a.test.mjs"], deleted: ["test/old.test.mjs"] }), graph, "d");
  expect(document).toMatchObject({
    tests: {},
    unmatched: [
      { file: "test/a.test.mjs", outcome: "fail", why: "main's version of this file ran; this PR edited it" },
      { file: "test/old.test.mjs", outcome: "pass", why: "main's test, run against this PR's code; this PR deleted the file" },
    ],
    deleted: ["test/old.test.mjs"],
    edited: ["test/a.test.mjs"],
    counts: { pass: 1, fail: 1, skip: 0 },
  });
});

test("the tests the PR wrote are served apart, labelled claimed, and never counted with the evidence", () => {
  const written = { files: ["test/new.test.mjs"], seconds: 1.5, outcome: { status: "ran", exitCode: 0, reports: [{ file: "test/new.test.mjs", path: ["checks nothing"], outcome: "pass", ms: 1 }] } } as const;
  const document = observedDocument(ran([{ file: "test/a.test.mjs", path: ["top"], outcome: "pass", ms: 1 }], { written }), graph, "d");
  expect(document).toMatchObject({
    counts: { pass: 1, fail: 0, skip: 0 },
    written: { tier: "claimed", status: "ran", files: ["test/new.test.mjs"], counts: { pass: 1, fail: 0, skip: 0 }, tests: [{ file: "test/new.test.mjs", name: "checks nothing", outcome: "pass" }] },
  });
  const failed = observedDocument(ran([], { written: { files: ["test/new.test.mjs"], seconds: 1, outcome: { status: "unreliable", why: "x", exitCode: 1 } } }), graph, "d");
  expect(failed).toMatchObject({ written: { tier: "claimed", status: "unreliable", why: "x" } });
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

test("results that are not what the runner writes are named unreadable without repeating their text", () => {
  const secret = "SSH_AUTH_SOCK=/tmp/agent GH_TOKEN=ghp_secretvalue";
  for (const parse of [() => parseNodeEvents(secret), () => parseNodeEvents(JSON.stringify({ type: secret }))]) {
    let message = "nothing thrown";
    try {
      parse();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe("unreadable test event on line 1");
  }
});

test("results that contradict the runner or themselves are unreliable, and say why", () => {
  const report = (file: string, name: string, outcome: "pass" | "fail" | "skip"): TestReport => ({ file, path: [name], outcome, ms: 1 });
  const files = new Set(["a.test.mjs", "b.test.mjs"]);
  const cases: [string, TestReport[], number, string | undefined][] = [
    ["all pass, exit 0", [report("a.test.mjs", "one", "pass"), report("b.test.mjs", "one", "pass")], 0, undefined],
    ["a failure, exit 1", [report("a.test.mjs", "one", "pass"), report("a.test.mjs", "two", "fail")], 1, undefined],
    ["the same test passing twice", [report("a.test.mjs", "one", "pass"), report("a.test.mjs", "one", "pass")], 0, undefined],
    ["nothing ran, exit 0", [], 0, undefined],
    ["exit 1, only passes", [report("a.test.mjs", "checks authorization", "pass")], 1, "the runner exited 1 but no failure was recorded"],
    ["exit 1, nothing", [], 1, "the runner exited 1 but no failure was recorded"],
    ["exit 0, a failure", [report("a.test.mjs", "one", "fail")], 0, "the runner exited 0 but 1 failure was recorded"],
    ["killed", [report("a.test.mjs", "one", "fail")], 137, "the runner exited 137, which no test result explains"],
    // Two tests may share a name, and one may pass while the other fails.
    ["one name, two tests, two outcomes", [report("a.test.mjs", "one", "fail"), report("a.test.mjs", "one", "pass")], 1, undefined],
    ["one name, three tests", [report("a.test.mjs", "one", "pass"), report("a.test.mjs", "one", "fail"), report("a.test.mjs", "one", "skip")], 1, undefined],
    ["a file not in the tree", [report("a.test.mjs", "one", "fail"), report("../etc/x.test.mjs", "one", "pass")], 1, 'a result names "../etc/x.test.mjs", which is not a test file this run was given'],
    ["no file", [report("", "one", "fail")], 1, 'a result names "", which is not a test file this run was given'],
  ];
  for (const [name, reports, exitCode, expected] of cases) expect([name, unreliable(reports, exitCode, files)]).toEqual([name, expected]);
});

test("an unreliable run is served as that, with no result in it", () => {
  const run: TestRun = { status: "unreliable", why: "the runner exited 1 but no failure was recorded", runner: "node", isolation: "bwrap", seconds: 1.5, exitCode: 1 };
  expect(observedDocument(run, extract(new Map()), "t")).toEqual({
    tier: "observed",
    tree: "t",
    status: "unreliable",
    why: "the runner exited 1 but no failure was recorded",
    runner: "node",
    sandbox: "bwrap",
    seconds: 1.5,
    exitCode: 1,
  });
});
