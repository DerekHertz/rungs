import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import type { AddressInfo, Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { chooseIsolation, detectSandbox, runIsolated } from "../src/sandbox.ts";
import type { Isolation, Places, Step } from "../src/sandbox.ts";

const SECRET = "rungs-probe-secret-value";
const outsideFile = fileURLToPath(import.meta.url);
let server: Server;
let port: number;
let hostDir: string;

beforeAll(async () => {
  process.env.RUNGS_PROBE_SECRET = SECRET;
  server = createServer((socket) => socket.on("error", () => {}).end("hello\n"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  hostDir = await mkdtemp(join(tmpdir(), "rungs-host-"));
});

afterAll(async () => {
  delete process.env.RUNGS_PROBE_SECRET;
  await new Promise((resolve) => server.close(resolve));
  await rm(hostDir, { recursive: true, force: true });
});

// Each probe passes only when the run is cut off from what it reaches for.
function probeTree(): Map<string, string> {
  const probe = `import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { readFileSync, writeFileSync } from "node:fs";

test("a socket to the host cannot connect", async () => {
  const outcome = await new Promise((resolve) => {
    const socket = net.connect(${port}, "127.0.0.1");
    socket.on("connect", () => { socket.destroy(); resolve("connected"); });
    socket.on("error", (error) => resolve(error.code));
  });
  assert.notEqual(outcome, "connected");
});

test("a file outside the copy cannot be read", () => {
  assert.throws(() => readFileSync(${JSON.stringify(outsideFile)}, "utf8"));
});

test("a file outside the copy cannot be written", () => {
  try { writeFileSync(${JSON.stringify(join(hostDir, "escaped"))}, "x"); } catch {}
});

test("the environment holds no secret", () => {
  assert.equal(process.env.RUNGS_PROBE_SECRET, undefined);
  assert.equal(process.env.SSH_AUTH_SOCK, undefined);
  assert.equal(process.env.GH_TOKEN, undefined);
  assert.notEqual(process.env.HOME, ${JSON.stringify(process.env.HOME)});
});
`;
  return new Map([
    ["package.json", `{"type":"module","scripts":{"test":"node --test"}}\n`],
    ["probe.test.mjs", probe],
  ]);
}

const nodeTest = (places: Places): Step[] => [
  { argv: [places.node, "--test", "--test-reporter=tap", "probe.test.mjs"], network: false },
];

const limits = { timeoutMs: 60_000, outputBytes: 1 << 20 };
const sandbox = await detectSandbox();
const bwrap: Isolation = sandbox.kind === "bwrap" ? sandbox : { kind: "unsandboxed" };
const unsandboxed: Isolation = { kind: "unsandboxed" };

test("bubblewrap works on this machine", () => {
  expect(sandbox).toEqual({ kind: "bwrap", path: expect.stringMatching(/bwrap$/) });
});

test("in the sandbox the probes all pass: no network, no outside files, no secrets", async () => {
  const run = await runIsolated({ tree: probeTree(), isolation: bwrap, steps: nodeTest, ...limits });
  const [step] = run.steps;
  expect(step?.output).toMatch(/^ok 1 - a socket to the host cannot connect$/m);
  expect(step?.output).toMatch(/^ok 2 - a file outside the copy cannot be read$/m);
  expect(step?.output).toMatch(/^ok 4 - the environment holds no secret$/m);
  expect(step?.exitCode).toBe(0);
  expect(existsSync(join(hostDir, "escaped"))).toBe(false);
  expect(existsSync(run.root)).toBe(false);
});

test("unsandboxed, the same probes reach the host: they are not vacuous", async () => {
  const run = await runIsolated({ tree: probeTree(), isolation: unsandboxed, steps: nodeTest, ...limits });
  const [step] = run.steps;
  expect(step?.output).toMatch(/^not ok 1 - a socket to the host cannot connect$/m);
  expect(step?.output).toMatch(/^not ok 2 - a file outside the copy cannot be read$/m);
  expect(step?.output).toMatch(/^ok 4 - the environment holds no secret$/m);
  expect(step?.exitCode).toBe(1);
  expect(existsSync(join(hostDir, "escaped"))).toBe(true);
  expect(existsSync(run.root)).toBe(false);
});

test("a step given the network reaches the host, so only install steps get it", async () => {
  const connect = `require("net").connect(${port}, "127.0.0.1").on("data", (d) => process.stdout.write(d)).on("error", (e) => console.log(e.code))`;
  const run = await runIsolated({
    tree: new Map(),
    isolation: bwrap,
    steps: (places) => [
      { argv: [places.node, "-e", connect], network: true },
      { argv: [places.node, "-e", connect], network: false },
    ],
    ...limits,
  });
  expect(run.steps.map((step) => step.output.trim())).toEqual(["hello", "ECONNREFUSED"]);
});

for (const isolation of [bwrap, unsandboxed]) {
  test(`${isolation.kind}: a run past its time limit is killed, children and all`, async () => {
    const started = Date.now();
    const run = await runIsolated({
      tree: new Map(),
      isolation,
      steps: (places) => [
        { argv: ["/bin/sh", "-c", `"${places.node}" -e "setInterval(() => {}, 1000)" & wait`], network: false },
        { argv: [places.node, "-e", "console.log('never')"], network: false },
      ],
      timeoutMs: 500,
      outputBytes: 1024,
    });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(run.steps).toHaveLength(1);
    expect(run.steps[0]).toMatchObject({ timedOut: true, exitCode: null });
    expect(existsSync(run.root)).toBe(false);
  });

  test(`${isolation.kind}: output past the limit is cut and marked, and a locked folder is still removed`, async () => {
    const run = await runIsolated({
      tree: new Map([["a/b.txt", "text\n"]]),
      isolation,
      steps: (places) => [
        { argv: ["/bin/sh", "-c", `"${places.node}" -e "process.stdout.write('x'.repeat(100000))"; chmod 000 a`], network: false },
      ],
      timeoutMs: 30_000,
      outputBytes: 1000,
    });
    expect(run.steps[0]).toMatchObject({ exitCode: 0, timedOut: false, truncated: true });
    expect(run.steps[0]?.output).toBe("x".repeat(1000));
    expect(existsSync(run.root)).toBe(false);
  });

  test(`${isolation.kind}: the copy holds the tree, and a later step runs only after the one before succeeds`, async () => {
    const run = await runIsolated({
      tree: new Map([["src/one.txt", "one\n"], ["two.txt", "two\n"]]),
      isolation,
      steps: (places) => [
        { argv: ["/bin/sh", "-c", "cat src/one.txt two.txt; exit 3"], network: false },
        { argv: [places.node, "-e", "console.log('never')"], network: false },
      ],
      ...limits,
    });
    expect(run.steps).toEqual([{ exitCode: 3, timedOut: false, truncated: false, ms: expect.any(Number), output: "one\ntwo\n" }]);
  });

  test(`${isolation.kind}: files the run writes to its out folder are collected, capped in size`, async () => {
    const run = await runIsolated({
      tree: new Map(),
      isolation,
      steps: (places) => [
        { argv: ["/bin/sh", "-c", `printf small > "${places.out}/a.json"; head -c 5000 /dev/zero > "${places.out}/b.json"`], network: false },
      ],
      collect: ["a.json", "b.json", "c.json"],
      ...limits,
      collectBytes: 1000,
    });
    expect(run.collected).toEqual(
      new Map([
        ["a.json", { kind: "text", text: "small" }],
        ["b.json", { kind: "too large", bytes: 5000 }],
        ["c.json", { kind: "missing" }],
      ]),
    );
  });
}

test("a tree path that climbs out of the copy is refused before anything runs", async () => {
  await expect(
    runIsolated({ tree: new Map([["../escape.txt", "x"]]), isolation: unsandboxed, steps: () => [], ...limits }),
  ).rejects.toThrow('the tree holds a path outside itself: "../escape.txt"');
});

test("no sandbox: tests are refused unless the person allows running unsandboxed", () => {
  const none = { kind: "none", why: "bwrap is not installed" } as const;
  expect(chooseIsolation(none, false)).toEqual({
    refused: "no sandbox to run the tests in (bwrap is not installed); --run-tests-unsandboxed runs them anyway",
  });
  expect(chooseIsolation(none, true)).toEqual({ isolation: { kind: "unsandboxed" } });
  const found = { kind: "bwrap", path: "/opt/bin/bwrap" } as const;
  expect(chooseIsolation(found, false)).toEqual({ isolation: found });
  expect(chooseIsolation(found, true)).toEqual({ isolation: found });
});

test("a PATH without bwrap finds no sandbox, and says why", async () => {
  expect(await detectSandbox({ PATH: "/nonexistent" })).toEqual({ kind: "none", why: "bwrap is not on PATH" });
});
