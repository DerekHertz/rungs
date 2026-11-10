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
    const run = await runTests(tree, executable, bwrap, 60_000, registry.url);
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
    const run = await runTests(tree, executable, bwrap, 60_000, registry.url);
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
    const run = await runTests(tree, executable, bwrap, 60_000, registry.url);
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

test("a test that swaps its results for a link to a host file gets a failed run, and the file's text is nowhere in it", async () => {
  const secret = join(hostDir, "secret.txt");
  const tree = new Map([
    ["package.json", `{"type":"module","scripts":{"test":"node --test"}}\n`],
    [
      "swap.test.mjs",
      `import { test } from "node:test";
import { rmSync, symlinkSync } from "node:fs";
test("swaps the results", () => {
  rmSync("/out/node.jsonl");
  symlinkSync(${JSON.stringify(secret)}, "/out/node.jsonl");
});
`,
    ],
  ]);
  const run = await runTests(tree, new Set(), bwrap, 60_000);
  expect(run).toMatchObject({ status: "failed", why: "the runner's results are unreadable: it is a symbolic link" });
  expect(JSON.stringify(run)).not.toContain(FILE_SECRET);
  const environ = new Map(tree).set("swap.test.mjs", tree.get("swap.test.mjs")?.replace(JSON.stringify(secret), '"/proc/self/environ"') ?? "");
  process.env.RUNGS_PROBE_SECRET = FILE_SECRET;
  try {
    const second = await runTests(environ, new Set(), bwrap, 60_000);
    expect(second).toMatchObject({ status: "failed", why: "the runner's results are unreadable: it is a symbolic link" });
    expect(JSON.stringify(second)).not.toContain(FILE_SECRET);
  } finally {
    delete process.env.RUNGS_PROBE_SECRET;
  }
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
