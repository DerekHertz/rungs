import { expect, test } from "vitest";
import { extract } from "../src/extract/extract.ts";
import { observedDocument, runTests } from "../src/observed.ts";
import { detectSandbox } from "../src/sandbox.ts";
import type { Isolation } from "../src/sandbox.ts";

const sandbox = await detectSandbox();
const bwrap: Isolation = sandbox.kind === "bwrap" ? sandbox : { kind: "unsandboxed" };

test("this machine runs the tests in bwrap", () => {
  expect(bwrap.kind).toBe("bwrap");
});

const suite = new Map([
  ["package.json", `{"type":"module","scripts":{"test":"node --test test/*.test.mjs"}}\n`],
  [
    "test/math.test.mjs",
    `import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
describe("sum", () => {
  it("adds", () => assert.equal(1 + 1, 2));
  it("carries", () => assert.equal(9 + 1, 11));
});
test.skip("later", () => {});
`,
  ],
  ["test/broken.test.mjs", `import "./missing.mjs";\n`],
]);

test("node --test runs once in the sandbox, and each result lands on its test function", async () => {
  const run = await runTests(suite, new Set(), bwrap, 60_000);
  const document = observedDocument(run, extract(suite), "t");
  expect(document).toMatchObject({
    status: "ran",
    runner: "node",
    sandbox: "bwrap",
    exitCode: 1,
    counts: { pass: 1, fail: 2, skip: 1 },
    tests: {
      'function:test/math.test.mjs#"describe(\\"sum\\") callback"."it(\\"adds\\") callback"': [{ name: "sum > adds", outcome: "pass" }],
      'function:test/math.test.mjs#"describe(\\"sum\\") callback"."it(\\"carries\\") callback"': [
        { name: "sum > carries", outcome: "fail", message: expect.stringContaining("10 !== 11") },
      ],
      'function:test/math.test.mjs#"skip(\\"later\\") callback"': [{ name: "later", outcome: "skip" }],
    },
    unmatched: [{ file: "test/broken.test.mjs", name: "test/broken.test.mjs", outcome: "fail", why: "no test function in the file has this name" }],
  });
});

test("dependencies install from the lockfile with their scripts off, then the tests run", async () => {
  const tree = new Map([
    ["package.json", `{"name":"probe","version":"1.0.0","type":"module","scripts":{"test":"node --test"},"dependencies":{"dep":"file:dep"}}\n`],
    [
      "package-lock.json",
      JSON.stringify({
        name: "probe",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": { name: "probe", version: "1.0.0", dependencies: { dep: "file:dep" } },
          dep: { version: "1.0.0", hasInstallScript: true },
          "node_modules/dep": { resolved: "dep", link: true },
        },
      }),
    ],
    ["dep/package.json", `{"name":"dep","version":"1.0.0","main":"index.js","scripts":{"postinstall":"node -e \\"require('fs').writeFileSync(process.env.INIT_CWD + '/marker', 'x')\\""}}\n`],
    ["dep/index.js", "module.exports = 42;\n"],
    [
      "probe.test.mjs",
      `import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import dep from "dep";
test("the dependency is installed", () => assert.equal(dep, 42));
test("its install script never ran", () => assert.equal(existsSync("marker"), false));
`,
    ],
  ]);
  const run = await runTests(tree, new Set(), bwrap, 60_000);
  expect(run).toMatchObject({ status: "ran", exitCode: 0 });
  expect(run.status === "ran" ? run.reports.map((report) => [report.path, report.outcome]) : run).toEqual([
    [["the dependency is installed"], "pass"],
    [["its install script never ran"], "pass"],
  ]);
});

test("a run past its limit is a failed run that says so", async () => {
  const tree = new Map([
    ["package.json", `{"scripts":{"test":"node --test"}}\n`],
    ["hang.test.mjs", `import { test } from "node:test";\ntest("hangs", () => new Promise(() => setInterval(() => {}, 1000)));\n`],
  ]);
  expect(await runTests(tree, new Set(), bwrap, 1500)).toMatchObject({ status: "failed", why: "the run passed its limit of 2 seconds", runner: "node" });
});

test("an unsupported runner runs nothing", async () => {
  const tree = new Map([["package.json", `{"scripts":{"test":"jest"}}\n`]]);
  expect(await runTests(tree, new Set(), bwrap, 1000)).toEqual({ status: "unsupported", why: 'the test script runs "jest"; Rungs reads only node --test and vitest' });
});
