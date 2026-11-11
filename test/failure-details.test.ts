import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { failureView } from "../src/failure-view.ts";
import { NODE_REPORTER, parseNodeEvents } from "../src/observed.ts";
import type { TestReport } from "../src/observed.ts";

/** Real `node --test` output, through the reporter Systems to Streets runs, parsed the way a run is. */
function run(source: string, flags: string[] = []): TestReport[] {
  const dir = mkdtempSync(join(tmpdir(), "failure-details-"));
  mkdirSync(join(dir, "test"));
  writeFileSync(join(dir, "reporter.mjs"), NODE_REPORTER);
  writeFileSync(join(dir, "test", "a.test.mjs"), source);
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=./reporter.mjs", ...flags, "test/a.test.mjs"], { cwd: dir, encoding: "utf8" });
  return parseNodeEvents(result.stdout);
}

const HEAD = `import { test } from "node:test";\nimport assert from "node:assert";\n`;

test("a strictEqual mismatch keeps the whole message, expected, actual, operator and the line of the assertion", () => {
  const [report] = run(`${HEAD}test("strict", () => {\n  const x = 1;\n  assert.strictEqual(x + 1, 3);\n});\n`);
  expect(report).toMatchObject({
    file: "test/a.test.mjs",
    path: ["strict"],
    outcome: "fail",
    message: "Expected values to be strictly equal:\n\n2 !== 3\n",
    detail: { operator: "strictEqual", expected: "3", actual: "2", line: 5 },
  });
});

test("a deepStrictEqual mismatch of objects keeps its multiline expected, actual and diff", () => {
  const [report] = run(`${HEAD}test("deep", () => {\n  assert.deepStrictEqual({ a: 1, b: [1, 2], c: "x\\ny" }, { a: 1, b: [1, 3], c: "x\\nz" });\n});\n`);
  expect(report?.message).toContain("Expected values to be strictly deep-equal:\n+ actual - expected\n");
  expect(report?.message).toContain("+     2\n-     3\n");
  expect(report?.detail).toEqual({
    operator: "deepStrictEqual",
    expected: "{\n  a: 1,\n  b: [\n    1,\n    3\n  ],\n  c: 'x\\nz'\n}",
    actual: "{\n  a: 1,\n  b: [\n    1,\n    2\n  ],\n  c: 'x\\ny'\n}",
    line: 4,
  });
});

test("a multiline string is shown escaped, as util.inspect prints it, so every character is exact", () => {
  const [report] = run(`${HEAD}test("lines", () => {\n  assert.strictEqual("one\\ntwo", "one\\nthree");\n});\n`);
  expect(report?.detail).toMatchObject({ expected: "'one\\nthree'", actual: "'one\\ntwo'", line: 4 });
});

test("a thrown Error has its message and the line it was thrown on, and no expected or actual", () => {
  const [report] = run(`${HEAD}test("thrown", () => {\n  throw new Error("kaboom\\nsecond line");\n});\n`);
  expect(report).toMatchObject({ path: ["thrown"], outcome: "fail", message: "kaboom\nsecond line", detail: { line: 4 } });
  expect(report?.detail).not.toHaveProperty("expected");
  expect(report?.detail).not.toHaveProperty("actual");
  expect(report?.detail).not.toHaveProperty("operator");
});

test("a timeout has the runner's message and no line, since no assertion ran", () => {
  const [report] = run(`${HEAD}test("slow", { timeout: 50 }, async () => {\n  await new Promise((resolve) => setTimeout(resolve, 600));\n});\n`);
  expect(report).toMatchObject({ path: ["slow"], outcome: "fail", message: "test timed out after 50ms" });
  expect(report?.detail).toBeUndefined();
});

test("a line that comes from a helper file is not taken for a line of the test file", () => {
  const dir = mkdtempSync(join(tmpdir(), "failure-details-"));
  mkdirSync(join(dir, "test"));
  writeFileSync(join(dir, "reporter.mjs"), NODE_REPORTER);
  writeFileSync(join(dir, "test", "helper.mjs"), `export const boom = () => {\n  throw new Error("from helper");\n};\n`);
  writeFileSync(join(dir, "test", "a.test.mjs"), `import { test } from "node:test";\nimport { boom } from "./helper.mjs";\ntest("t", () => {\n  boom();\n});\n`);
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=./reporter.mjs", "test/a.test.mjs"], { cwd: dir, encoding: "utf8" });
  expect(parseNodeEvents(result.stdout)[0]?.detail).toEqual({ line: 4 });
});

test("long values are cut to a bound and say how much was left out", () => {
  const [report] = run(`${HEAD}test("long", () => {\n  assert.strictEqual("a".repeat(5000), "b");\n});\n`);
  const actual = report?.detail?.actual ?? "";
  expect(actual.length).toBeLessThan(2100);
  expect(actual).toMatch(/^'a{2000}'… 3000 more characters$/);
  expect(report?.message?.length).toBeLessThan(2100);
});

test("a string and a number that print alike are told apart, and undefined from the string \"undefined\"", () => {
  const [one] = run(`${HEAD}test("t", () => {\n  assert.strictEqual("1", 1);\n});\n`);
  expect(one?.detail).toMatchObject({ actual: "'1'", expected: "1" });
  const [missing] = run(`${HEAD}test("t", () => {\n  assert.strictEqual(undefined, "undefined");\n});\n`);
  expect(missing?.detail).toMatchObject({ actual: "undefined", expected: "'undefined'" });
});

test("hostile error fields cannot stop the reporter: the failure is still reported with its message", () => {
  const source = `${HEAD}test("stack", () => {
  throw Object.assign(new Error("x"), { stack: { toString: 0 } });
});
test("message", () => {
  throw Object.assign(new Error("y"), { get operator() { throw new Error("no"); }, code: "ERR_ASSERTION" });
});
test("values", () => {
  const bad = new Proxy({}, { ownKeys() { throw new Error("no"); }, getPrototypeOf() { throw new Error("no"); } });
  assert.strictEqual(bad, 1);
});
test("after", () => {
  assert.strictEqual(1, 2);
});
`;
  const reports = run(source);
  expect(reports.map((report) => [report.path[0], report.outcome])).toEqual([["stack", "fail"], ["message", "fail"], ["values", "fail"], ["after", "fail"]]);
  expect(reports[0]).toMatchObject({ message: "x" });
  expect(reports[0]?.detail).toBeUndefined();
  expect(reports[3]?.detail).toMatchObject({ expected: "2", actual: "1" });
});

test("a message that looks like a stack frame is not taken for one", () => {
  const [report] = run(`${HEAD}test("fake", () => {\n  throw new Error("boom\\n    at fake (" + import.meta.filename + ":5:1)");\n});\n`);
  expect(report?.detail).toEqual({ line: 4 });
  const [bare] = run(`${HEAD}test("fake", () => {\n  const error = new Error("boom");\n  error.stack = "Error: boom\\n    at fake (" + import.meta.filename + ":5:1)";\n  throw Object.assign(error, { message: "other" });\n});\n`);
  expect(bare?.detail).toBeUndefined();
});

test("CRLF and LF strings do not look alike", () => {
  const [report] = run(`${HEAD}test("eol", () => {\n  assert.strictEqual("a\\r\\nb", "a\\nb");\n});\n`);
  expect(report?.detail).toMatchObject({ actual: "'a\\r\\nb'", expected: "'a\\nb'" });
});

test("a hostile detail is dropped and never costs the run its other results", () => {
  const event = (name: string, extra: object = {}) => JSON.stringify({ type: "test:fail", file: "test/a.test.mjs", name, nesting: 0, kind: "test", ms: 1, error: "no", ...extra });
  const lines = [
    event("good", { detail: { operator: "strictEqual", expected: "1", actual: "2", line: 5 } }),
    event("zero", { detail: { expected: "1", actual: "2", line: 0 } }),
    event("fraction", { detail: { line: 1.5 } }),
    event("text", { detail: { expected: 7 } }),
    event("array", { detail: [1] }),
    event("string", { detail: "x" }),
    JSON.stringify({ type: "test:pass", file: "test/a.test.mjs", name: "passes", nesting: 0, kind: "test", ms: 1 }),
    event("last", { detail: { line: 9 } }),
  ];
  const reports = parseNodeEvents(lines.join("\n"));
  expect(reports.map((report) => report.path[0])).toEqual(["good", "zero", "fraction", "text", "array", "string", "passes", "last"]);
  expect(reports.map((report) => report.detail)).toEqual([{ operator: "strictEqual", expected: "1", actual: "2", line: 5 }, undefined, undefined, undefined, undefined, undefined, undefined, { line: 9 }]);
  expect(reports[1]).toMatchObject({ message: "no" });
});

test("the reporter writes no line of 0", () => {
  const [report] = run(`${HEAD}test("zero", () => {\n  const error = new Error("x");\n  error.stack = "Error: x\\n    at zero (" + import.meta.filename + ":0:1)";\n  throw error;\n});\n`);
  expect(report).toMatchObject({ message: "x" });
  expect(report?.detail).toBeUndefined();
});

test("a name that looks like a message or a frame is not read as the stack's frames", () => {
  const [renamed] = run(`${HEAD}test("renamed", () => {\n  const error = new Error("x");\n  error.name = "N\\n    at fake (" + import.meta.filename + ":5:1)\\nM";\n  throw error;\n});\n`);
  expect(renamed?.detail).toEqual({ line: 4 });
  const [weird] = run(`${HEAD}class Weird extends Error {}\nWeird.prototype.name = "W\\n    at fake (" + import.meta.filename + ":5:1)\\nZ";\ntest("weird", () => {\n  throw new Weird("x");\n});\n`);
  expect(weird?.detail).toEqual({ line: 6 });
});

const range = { start: 81, end: 95 };

test("a failure with a line inside the test shows that line, then expected and actual", () => {
  expect(failureView({ name: "t", outcome: "fail", ms: 1, message: "Expected values to be strictly equal:\n\n1 !== 2\n", detail: { operator: "strictEqual", expected: "2", actual: "1", line: 86 } }, range)).toEqual({
    kind: "detailed",
    message: "Expected values to be strictly equal:\n\n1 !== 2\n",
    operator: "strictEqual",
    expected: "2",
    actual: "1",
    mark: 86,
  });
});

test("a line outside the test is stated, not marked in the test's source", () => {
  const view = failureView({ name: "t", outcome: "fail", ms: 1, message: "no", detail: { line: 12 } }, range);
  expect(view).toEqual({ kind: "detailed", message: "no", outside: 12 });
});

test("a message-only failure says that is all the runner reported, and marks nothing", () => {
  expect(failureView({ name: "t", outcome: "fail", ms: 1, message: "test timed out after 50ms" }, range)).toEqual({ kind: "message-only", text: "the runner reported only: test timed out after 50ms" });
  expect(failureView({ name: "t", outcome: "fail", ms: 1 }, range)).toEqual({ kind: "message-only", text: "the runner reported no message" });
});
