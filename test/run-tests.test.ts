import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import type { Server as HttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import type { Server as NetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { extract } from "../src/extract/extract.ts";
import { testChanges } from "../src/test-changes.ts";
import { installArgv, observedDocument, runTests } from "../src/observed.ts";
import { detectSandbox, runIsolated } from "../src/sandbox.ts";
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
  const run = await runTests(suite, suite, new Set(), bwrap, 60_000);
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

// A registry on this machine: the install has the network, and this is all of it the tests need.
const registry = { url: "", hits: [] as string[], tarball: Buffer.alloc(0), integrity: "" };
let registryServer: HttpServer;
let hostDir: string;
const FILE_SECRET = "rungs-host-file-secret-value";

async function listen(server: HttpServer | NetServer, from: number): Promise<number> {
  for (let port = from; port < from + 50; port += 1) {
    const free = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false)).listen(port, "127.0.0.1", () => resolve(true));
    });
    server.removeAllListeners("error");
    if (free) return port;
  }
  throw new Error(`no free port from ${from}`);
}

beforeAll(async () => {
  hostDir = await mkdtemp(join(tmpdir(), "rungs-host-"));
  await mkdir(join(hostDir, "package"));
  const postinstall = `node -e "require('fs').writeFileSync('marker', 'x')"`;
  await writeFile(join(hostDir, "package", "package.json"), JSON.stringify({ name: "dep", version: "1.0.0", main: "index.js", scripts: { postinstall } }));
  await writeFile(join(hostDir, "package", "index.js"), "module.exports = 42;\n");
  await writeFile(join(hostDir, "secret.txt"), `${FILE_SECRET}\n`);
  execFileSync("tar", ["-czf", join(hostDir, "dep.tgz"), "-C", hostDir, "package"]);
  registry.tarball = await readFile(join(hostDir, "dep.tgz"));
  registry.integrity = `sha512-${createHash("sha512").update(registry.tarball).digest("base64")}`;
  registryServer = createHttpServer((request, response) => {
    registry.hits.push(request.url ?? "");
    if (request.url === "/dep/-/dep-1.0.0.tgz") response.writeHead(200, { "content-type": "application/octet-stream" }).end(registry.tarball);
    else response.writeHead(404).end();
  });
  registry.url = `http://127.0.0.1:${await listen(registryServer, 47911)}/`;
});

afterAll(async () => {
  await new Promise((resolve) => registryServer.close(resolve));
  await rm(hostDir, { recursive: true, force: true });
});

const SHA = "0123456789abcdef0123456789abcdef01234567";
const GIT_URL = `git+ssh://git@127.0.0.1:1/none/none.git#${SHA}`;

function lockfile(dep: object, asked = "1.0.0"): string {
  const root = { name: "probe", version: "1.0.0", dependencies: { dep: asked } };
  return JSON.stringify({ name: "probe", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": root, "node_modules/dep": dep } });
}

/** A tree whose .npmrc names its own program as npm's git; the program calls home and leaves a marker. */
function hostile(port: number, files: [string, string][]): { tree: Map<string, string>; executable: Set<string> } {
  const payload = `#!/bin/sh\n/rungs/bin/node -e 'require("net").connect(${port}, "127.0.0.1")'\necho pwned > /out/marker\necho pwned > marker\nexit 1\n`;
  return {
    tree: new Map([[".npmrc", "git=/work/payload.sh\nignore-scripts=false\n"], ["payload.sh", payload], ...files]),
    executable: new Set(["payload.sh"]),
  };
}

async function withBeacon<T>(body: (port: number, reached: () => number) => Promise<T>): Promise<T> {
  let reached = 0;
  const beacon = createNetServer((socket) => {
    reached += 1;
    socket.on("error", () => {}).end();
  });
  const port = await listen(beacon, 47961);
  try {
    return await body(port, () => reached);
  } finally {
    await new Promise((resolve) => beacon.close(resolve));
  }
}

test("dependencies install from the registry the lockfile names, with their scripts off, and the tree's .npmrc is never read", async () => {
  await withBeacon(async (port, reached) => {
    const preinstall = `node -e "require('fs').writeFileSync('marker', 'x')"`;
    const { tree, executable } = hostile(port, [
      ["package.json", JSON.stringify({ name: "probe", version: "1.0.0", type: "module", scripts: { test: "node --test", preinstall }, dependencies: { dep: "1.0.0" } })],
      ["package-lock.json", lockfile({ version: "1.0.0", resolved: `${registry.url}dep/-/dep-1.0.0.tgz`, integrity: registry.integrity, hasInstallScript: true })],
      [
        "probe.test.mjs",
        `import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import dep from "dep";
test("the dependency is installed", () => assert.equal(dep, 42));
test("no install script ever ran", () => assert.deepEqual(["marker", "node_modules/dep/marker", "/out/marker"].filter((file) => existsSync(file)), []));
test("the tests have no network", async () => assert.rejects(fetch(${JSON.stringify(registry.url)})));
`,
      ],
    ]);
    registry.hits.length = 0;
    const run = await runTests(tree, tree, executable, bwrap, 60_000, registry.url);
    expect(run).toMatchObject({ status: "ran", exitCode: 0 });
    expect(run.status === "ran" ? run.reports.map((report) => [report.path, report.outcome]) : run).toEqual([
      [["the dependency is installed"], "pass"],
      [["no install script ever ran"], "pass"],
      [["the tests have no network"], "pass"],
    ]);
    expect(registry.hits).toEqual(["/dep/-/dep-1.0.0.tgz"]);
    expect(reached()).toBe(0);
  });
});

test("a tree whose .npmrc makes its own program npm's git, with a git dependency to fetch, is refused before anything runs", async () => {
  await withBeacon(async (port, reached) => {
    const { tree, executable } = hostile(port, [
      ["package.json", JSON.stringify({ name: "probe", version: "1.0.0", scripts: { test: "node --test" }, dependencies: { dep: GIT_URL } })],
      ["package-lock.json", lockfile({ version: "1.0.0", resolved: GIT_URL }, GIT_URL)],
    ]);
    const run = await runTests(tree, tree, executable, bwrap, 60_000, registry.url);
    expect(reached()).toBe(0);
    expect(run).toEqual({ status: "refused", why: `package.json asks for "dep" from ${JSON.stringify(GIT_URL)}, which is not a registry version` });
  });
});

test("a git dependency hidden behind a registry-looking package.json is refused by its lockfile entry", async () => {
  await withBeacon(async (port, reached) => {
    const { tree, executable } = hostile(port, [
      ["package.json", JSON.stringify({ name: "probe", version: "1.0.0", scripts: { test: "node --test" }, dependencies: { dep: "1.0.0" } })],
      ["package-lock.json", lockfile({ version: "1.0.0", resolved: GIT_URL })],
    ]);
    const run = await runTests(tree, tree, executable, bwrap, 60_000, registry.url);
    expect(reached()).toBe(0);
    expect(run).toEqual({ status: "refused", why: `package-lock.json: node_modules/dep is a git dependency (${JSON.stringify(GIT_URL)})` });
  });
});

test("even beside a hostile .npmrc and an unchecked git dependency, npm's git is a program that does nothing", async () => {
  // The lockfile check and the folder of two files are both stepped around here: the settings alone must hold.
  const files = new Map([
    [".npmrc", "git=/bin/echo\nscript-shell=/bin/sh\nignore-scripts=false\n"],
    ["package.json", JSON.stringify({ name: "probe", version: "1.0.0", scripts: { preinstall: "echo the preinstall ran" }, dependencies: { dep: GIT_URL } })],
    ["package-lock.json", lockfile({ version: "1.0.0", resolved: GIT_URL }, GIT_URL)],
  ]);
  const run = await runIsolated({
    tree: new Map(),
    isolation: bwrap,
    tools: new Map([["npmrc-user", ""], ["npmrc-global", ""]]),
    install: { files, argv: (places) => installArgv(places, registry.url) },
    steps: () => [],
    timeoutMs: 60_000,
    outputBytes: 1 << 20,
  });
  expect(run.install?.exitCode).not.toBe(0);
  expect(run.install?.output).toContain("command /usr/bin/false --no-replace-objects ls-remote");
  expect(run.install?.output).not.toContain("/bin/echo");
  expect(run.install?.output).not.toContain("the preinstall ran");
});

test("a test that plants a link to a host file where results used to be read changes nothing, and the file's text is nowhere", async () => {
  const secret = join(hostDir, "secret.txt");
  const tree = new Map([
    ["package.json", `{"type":"module","scripts":{"test":"node --test"}}\n`],
    [
      "swap.test.mjs",
      `import { test } from "node:test";
import { symlinkSync } from "node:fs";
test("plants the links", () => {
  symlinkSync(${JSON.stringify(secret)}, "/out/node.jsonl");
});
`,
    ],
  ]);
  process.env.RUNGS_PROBE_SECRET = FILE_SECRET;
  try {
    const run = await runTests(tree, tree, new Set(), bwrap, 60_000);
    expect(run).toMatchObject({ status: "ran", exitCode: 0, reports: [{ file: "swap.test.mjs", path: ["plants the links"], outcome: "pass" }] });
    expect(JSON.stringify(run)).not.toContain(FILE_SECRET);
  } finally {
    delete process.env.RUNGS_PROBE_SECRET;
  }
});

// The tests are the change's own code: they must not be able to say what the runner saw.
const forged = (file: string, name: string) => JSON.stringify({ type: "test:pass", file, name, nesting: 0, kind: "test", ms: 1 });

test("a failing test that rewrites the results file as a pass is still shown failing", async () => {
  const tree = new Map([
    ["package.json", `{"type":"module","scripts":{"test":"node --test"}}\n`],
    [
      "attack.test.mjs",
      `import { test } from "node:test";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
test("checks authorization", () => {
  for (const name of ["node.jsonl"]) {
    try { unlinkSync("/out/" + name); } catch {}
    try { mkdirSync("/out", { recursive: true }); writeFileSync("/out/" + name, ${JSON.stringify(`${forged("attack.test.mjs", "checks authorization")}\n`)}); } catch {}
  }
  throw new Error("denied");
});
`,
    ],
  ]);
  const run = await runTests(tree, tree, new Set(), bwrap, 60_000);
  expect(run).toMatchObject({ status: "ran", exitCode: 1 });
  expect(run.status === "ran" ? run.reports : run).toEqual([{ file: "attack.test.mjs", path: ["checks authorization"], outcome: "fail", ms: expect.any(Number), message: "denied" }]);
});

test("a test cannot write into the runner's report through /proc, to pass off another file's failure as a pass", async () => {
  const line = `${forged("auth.test.mjs", "checks authorization")}\n`;
  const tree = new Map([
    ["package.json", `{"type":"module","scripts":{"test":"node --test --test-concurrency=1"}}\n`],
    ["auth.test.mjs", `import { test } from "node:test";\ntest("checks authorization", () => { throw new Error("denied"); });\n`],
    [
      "attack.test.mjs",
      `import { test } from "node:test";
import { appendFileSync, readdirSync, writeSync } from "node:fs";
import { execFileSync } from "node:child_process";
test("reaches for the report", () => {
  const line = ${JSON.stringify(line)};
  const reached = [];
  for (const pid of readdirSync("/proc").filter((name) => /^\\d+$/.test(name) && Number(name) !== process.pid)) {
    for (const fd of [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25]) {
      try { appendFileSync("/proc/" + pid + "/fd/" + fd, line); reached.push(pid + ":" + fd); } catch {}
      try { execFileSync("/bin/sh", ["-c", "printf '%s\\\\n' \\"$1\\" >> /proc/" + pid + "/fd/" + fd, "sh", line.trim()], { stdio: "ignore" }); reached.push("sh " + pid + ":" + fd); } catch {}
    }
  }
  try { writeSync(3, line); } catch {}
});
`,
    ],
  ]);
  const run = await runTests(tree, tree, new Set(), bwrap, 60_000);
  expect(run).toMatchObject({ status: "ran", exitCode: 1 });
  expect(run.status === "ran" ? run.reports.map((report) => [report.file, report.path, report.outcome]) : run).toEqual([
    ["attack.test.mjs", ["reaches for the report"], "pass"],
    ["auth.test.mjs", ["checks authorization"], "fail"],
  ]);
});

test("a run past its limit is a failed run that says so", async () => {
  const tree = new Map([
    ["package.json", `{"scripts":{"test":"node --test"}}\n`],
    ["hang.test.mjs", `import { test } from "node:test";\ntest("hangs", () => new Promise(() => setInterval(() => {}, 1000)));\n`],
  ]);
  expect(await runTests(tree, tree, new Set(), bwrap, 1500)).toMatchObject({ status: "failed", why: "the run passed its limit of 2 seconds", runner: "node" });
});

test("an unsupported runner runs nothing", async () => {
  const tree = new Map([["package.json", `{"scripts":{"test":"jest"}}\n`]]);
  expect(await runTests(tree, tree, new Set(), bwrap, 1000)).toEqual({ status: "unsupported", why: 'the test script runs "jest"; Rungs reads only node --test' });
});

// The point of taking the tests from the base: a PR cannot pass its own tests off as evidence.
const manifest = `{"type":"module","scripts":{"test":"node --test test/*.test.mjs"}}\n`;
const MATH = `export const add = (a, b) => a + b;\n`;
const MATH_TEST = `import { test } from "node:test";
import assert from "node:assert/strict";
import { add } from "../src/math.mjs";
test("adds", () => { assert.equal(add(1, 2), 3); });
`;
const baseTree = new Map([["package.json", manifest], ["src/math.mjs", MATH], ["test/math.test.mjs", MATH_TEST]]);
const document = (run: Awaited<ReturnType<typeof runTests>>, head: Map<string, string>) => observedDocument(run, extract(head), "t");

test("a PR that edits a base test to assert.ok(true) while breaking the code still shows the base test failing, and weakened", async () => {
  const head = new Map(baseTree);
  head.set("src/math.mjs", `export const add = (a, b) => a - b;\n`);
  head.set("test/math.test.mjs", MATH_TEST.replace("assert.equal(add(1, 2), 3)", "assert.ok(true)"));
  const run = await runTests(baseTree, head, new Set(), bwrap, 60_000);
  expect(document(run, head)).toMatchObject({
    status: "ran",
    exitCode: 1,
    counts: { pass: 0, fail: 1, skip: 0 },
    edited: ["test/math.test.mjs"],
    unmatched: [{ file: "test/math.test.mjs", name: "adds", outcome: "fail", why: "main's version of this file ran; this PR edited it" }],
    written: { tier: "claimed", status: "ran", files: ["test/math.test.mjs"], counts: { pass: 1, fail: 0, skip: 0 } },
  });
  expect(testChanges(baseTree, head).weakened).toEqual([{ file: "test/math.test.mjs", name: "adds", why: expect.stringContaining("constants") }]);
});

test("a PR cannot swap the runner by changing its test script", async () => {
  const head = new Map(baseTree);
  head.set("src/math.mjs", `export const add = (a, b) => a - b;\n`);
  head.set("package.json", `{"type":"module","scripts":{"test":"node --test --import ./evil.mjs"}}\n`);
  head.set("evil.mjs", `process.exit(0);\n`);
  const run = await runTests(baseTree, head, new Set(), bwrap, 60_000);
  expect(run).toMatchObject({ status: "ran", exitCode: 1, reports: [{ file: "test/math.test.mjs", path: ["adds"], outcome: "fail" }] });
});

test("a base test the PR deleted still runs against the PR's code, and is named as deleted", async () => {
  const head = new Map(baseTree);
  head.set("src/math.mjs", `export const add = (a, b) => a - b;\n`);
  head.delete("test/math.test.mjs");
  const run = await runTests(baseTree, head, new Set(), bwrap, 60_000);
  expect(document(run, head)).toMatchObject({
    status: "ran",
    counts: { pass: 0, fail: 1, skip: 0 },
    deleted: ["test/math.test.mjs"],
    unmatched: [{ file: "test/math.test.mjs", outcome: "fail", why: "main's test, run against this PR's code; this PR deleted the file" }],
    written: null,
  });
  expect(testChanges(baseTree, head).deletedFiles).toEqual([{ path: "test/math.test.mjs", tests: 1 }]);
});

test("a test the PR added is run apart as written by the PR, and adds nothing to the evidence", async () => {
  const head = new Map(baseTree);
  head.set("test/checks-nothing.test.mjs", `import { test } from "node:test";\ntest("checks nothing", () => {});\n`);
  const run = await runTests(baseTree, head, new Set(), bwrap, 60_000);
  expect(document(run, head)).toMatchObject({
    counts: { pass: 1, fail: 0, skip: 0 },
    written: { tier: "claimed", files: ["test/checks-nothing.test.mjs"], tests: [{ file: "test/checks-nothing.test.mjs", name: "checks nothing", outcome: "pass" }] },
  });
});

// The first test file imports the PR's code, which gets at the second file before it runs.
const FORGED = `import { test } from 'node:test'; test('adds', () => {});\n`;
const ATTACKS: Record<string, string> = {
  "overwrites it": `writeFileSync("test/b.test.mjs", FORGED);`,
  "removes it and writes another": `rmSync("test/b.test.mjs"); writeFileSync("test/b.test.mjs", FORGED);`,
  "writes another and renames it over": `writeFileSync("test/new.mjs", FORGED); renameSync("test/new.mjs", "test/b.test.mjs");`,
  "moves the folder away and makes another": `renameSync("test", "elsewhere"); mkdirSync("test"); writeFileSync("test/b.test.mjs", FORGED);`,
};

for (const [name, attack] of Object.entries(ATTACKS)) {
  test(`the PR's code cannot get at a base test before it runs: ${name}`, async () => {
    const files = new Map([
      ["package.json", `{"type":"module","scripts":{"test":"node --test --test-concurrency=1 test/a.test.mjs test/b.test.mjs"}}\n`],
      ["src/math.mjs", `export const add = (a, b) => a + b;\n`],
      ["test/a.test.mjs", `import { test } from "node:test";\nimport { add } from "../src/math.mjs";\ntest("first", () => { if (add(1, 2) !== 3) throw new Error("broken"); });\n`],
      ["test/b.test.mjs", `import { test } from "node:test";\nimport { add } from "../src/math.mjs";\ntest("adds", () => { if (add(1, 2) !== 3) throw new Error("broken"); });\n`],
    ]);
    const head = new Map(files);
    head.set(
      "src/math.mjs",
      `import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
const FORGED = ${JSON.stringify(FORGED)};
try { ${attack} } catch {}
export const add = (a, b) => a - b;
`,
    );
    const run = await runTests(files, head, new Set(), bwrap, 60_000);
    expect(run).toMatchObject({ status: "ran", exitCode: 1 });
    expect(run.status === "ran" ? run.reports.map((report) => [report.file, report.path[0], report.outcome]) : run).toEqual([
      ["test/a.test.mjs", "first", "fail"],
      ["test/b.test.mjs", "adds", "fail"],
    ]);
  });
}

test("a project whose base test script is vitest is not run: the PR picks vitest's version and config", async () => {
  const vitest = new Map([["package.json", `{"scripts":{"test":"vitest run"},"devDependencies":{"vitest":"5.1.0"}}\n`]]);
  expect(await runTests(vitest, vitest, new Set(), bwrap, 1000)).toEqual({ status: "unsupported", why: "vitest is chosen by the PR" });
});

test("a PR that moves the test script from vitest to node --test does not get its tests run either", async () => {
  const vitest = new Map([["package.json", `{"scripts":{"test":"vitest run"}}\n`]]);
  const head = new Map([["package.json", manifest], ["test/a.test.mjs", `import { test } from "node:test";\ntest("x", () => {});\n`]]);
  expect(await runTests(vitest, head, new Set(), bwrap, 1000)).toEqual({ status: "unsupported", why: "vitest is chosen by the PR" });
});

test("a suite whose after hook throws is shown failing though every test in it passed", async () => {
  const files = new Map([
    ["package.json", manifest],
    ["test/a.test.mjs", `import { after, describe, it } from "node:test";\ndescribe("suite", () => {\n  after(() => { throw new Error("teardown broke"); });\n  it("passes", () => {});\n});\n`],
    ["test/b.test.mjs", `import { test } from "node:test";\ntest("fails", () => { throw new Error("no"); });\n`],
  ]);
  const run = await runTests(files, files, new Set(), bwrap, 60_000);
  const doc = document(run, files);
  expect(doc).toMatchObject({ status: "ran", counts: { pass: 1, fail: 2, skip: 0 } });
  expect(doc.status === "ran" ? doc.unmatched : doc).toEqual([
    expect.objectContaining({ file: "test/a.test.mjs", name: "suite", outcome: "fail", why: "the suite failed outside its tests (a hook or setup)", message: expect.stringContaining("teardown broke") }),
  ]);
});

test("two tests with one name, one passing and one failing, are a real run and both are shown", async () => {
  const files = new Map([
    ["package.json", manifest],
    ["test/a.test.mjs", `import { test } from "node:test";\ntest("same", () => {});\ntest("same", () => { throw new Error("second"); });\n`],
  ]);
  const run = await runTests(files, files, new Set(), bwrap, 60_000);
  expect(run).toMatchObject({ status: "ran", exitCode: 1 });
  expect(run.status === "ran" ? run.reports.map((report) => [report.path, report.outcome]) : run).toEqual([[["same"], "pass"], [["same"], "fail"]]);
});

test("a flag's value in the base script is not taken for a test file", async () => {
  const files = new Map([
    ["package.json", `{"type":"module","scripts":{"test":"node --test --test-timeout 5000 test/a.test.mjs test/b.test.mjs"}}\n`],
    ["test/a.test.mjs", `import { test } from "node:test";\ntest("a", () => {});\n`],
    ["test/b.test.mjs", `import { test } from "node:test";\ntest("b", () => {});\n`],
  ]);
  const run = await runTests(files, files, new Set(), bwrap, 60_000);
  expect(run.status === "ran" ? run.reports.map((report) => [report.file, report.outcome]) : run).toEqual([["test/a.test.mjs", "pass"], ["test/b.test.mjs", "pass"]]);
});
