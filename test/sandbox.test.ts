import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

// What a run leaves in its out folder is the run's own untrusted work: it is read as a plain
// file by its expected name, and never followed anywhere else on the machine.
const FILE_SECRET = "rungs-host-file-secret-value";
const unreadable = { kind: "unreadable", why: expect.any(String) };

async function hostSecret(): Promise<string> {
  const path = join(hostDir, "secret.txt");
  await writeFile(path, `${FILE_SECRET}\n`);
  return path;
}

for (const isolation of [bwrap, unsandboxed]) {
  test(`${isolation.kind}: a result swapped for a link to a host file is unreadable, and the secret is in no output`, async () => {
    const secret = await hostSecret();
    const run = await runIsolated({
      tree: new Map(),
      isolation,
      steps: (places) => [
        {
          argv: ["/bin/sh", "-c", `cd "${places.out}" && printf real > a.json && rm a.json && ln -s "${secret}" a.json && ln -s /proc/self/environ b.json && ln -s /nowhere c.json`],
          network: false,
        },
      ],
      collect: ["a.json", "b.json", "c.json"],
      ...limits,
    });
    expect(run.steps[0]?.exitCode).toBe(0);
    const link = { kind: "unreadable", why: "it is a symbolic link" };
    expect(run.collected).toEqual(new Map([["a.json", link], ["b.json", link], ["c.json", link]]));
    const everything = JSON.stringify({ ...run, collected: [...run.collected] });
    expect(everything).not.toContain(FILE_SECRET);
    expect(everything).not.toContain(SECRET);
  });

  test(`${isolation.kind}: a result that is a pipe or a folder is unreadable, and reading it never waits`, async () => {
    const run = await runIsolated({
      tree: new Map(),
      isolation,
      steps: (places) => [{ argv: ["/bin/sh", "-c", `cd "${places.out}" && mkfifo a.json && mkdir b.json`], network: false }],
      collect: ["a.json", "b.json"],
      ...limits,
    });
    expect(run.steps[0]?.exitCode).toBe(0);
    const irregular = { kind: "unreadable", why: "it is not a regular file" };
    expect(run.collected).toEqual(new Map([["a.json", irregular], ["b.json", irregular]]));
  });

  test(`${isolation.kind}: only a plain file name in the out folder can be collected`, async () => {
    for (const name of ["../work/a.json", "sub/a.json", "/etc/passwd", "..", ""]) {
      await expect(runIsolated({ tree: new Map(), isolation, steps: () => [], collect: [name], ...limits })).rejects.toThrow(
        `a collected file must be a plain name in the out folder: ${JSON.stringify(name)}`,
      );
    }
  });
}

// Outside bwrap a run can reach its own out folder from above, and files on the same disk.
test("unsandboxed: an out folder swapped for a link to a host folder is unreadable", async () => {
  await writeFile(join(hostDir, "a.json"), FILE_SECRET);
  const run = await runIsolated({
    tree: new Map(),
    isolation: unsandboxed,
    steps: (places) => [{ argv: ["/bin/sh", "-c", `rmdir "${places.out}" && ln -s "${hostDir}" "${places.out}"`], network: false }],
    collect: ["a.json", "b.json"],
    ...limits,
  });
  expect(run.steps[0]?.exitCode).toBe(0);
  expect(run.collected).toEqual(new Map([["a.json", unreadable], ["b.json", unreadable]]));
  expect(JSON.stringify([...run.collected])).not.toContain(FILE_SECRET);
});

test("unsandboxed: an out folder replaced by another real folder is unreadable", async () => {
  const run = await runIsolated({
    tree: new Map(),
    isolation: unsandboxed,
    steps: (places) => [{ argv: ["/bin/sh", "-c", `mkdir "${places.out}2" && printf x > "${places.out}2/a.json" && rmdir "${places.out}" && mv "${places.out}2" "${places.out}"`], network: false }],
    collect: ["a.json"],
    ...limits,
  });
  expect(run.collected).toEqual(new Map([["a.json", unreadable]]));
});

test("unsandboxed: a result that is a second name for a host file is unreadable", async () => {
  const secret = await hostSecret();
  const run = await runIsolated({
    tree: new Map(),
    isolation: unsandboxed,
    steps: (places) => [{ argv: ["/bin/sh", "-c", `ln "${secret}" "${places.out}/a.json"`], network: false }],
    collect: ["a.json"],
    ...limits,
  });
  expect(run.steps[0]?.exitCode).toBe(0);
  expect(run.collected).toEqual(new Map([["a.json", unreadable]]));
  expect(JSON.stringify([...run.collected])).not.toContain(FILE_SECRET);
});

test("a result one byte past the limit is too large, not read", async () => {
  const run = await runIsolated({
    tree: new Map(),
    isolation: unsandboxed,
    steps: (places) => [{ argv: ["/bin/sh", "-c", `head -c 1001 /dev/zero > "${places.out}/a.json"`], network: false }],
    collect: ["a.json"],
    ...limits,
    collectBytes: 1000,
  });
  expect(run.collected).toEqual(new Map([["a.json", { kind: "too large", bytes: 1001 }]]));
});

// A process that leaves its step's group and keeps the step's output open must not hold the run.
const stray = (options: string, after = "") =>
  `const child = require("child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "inherit"${options} }); console.log(child.pid); child.unref();${after}`;

async function gone(pid: number): Promise<boolean> {
  for (let tries = 0; tries < 40; tries += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

test("unsandboxed: a process a step leaves behind holding its output is killed and named, and the run goes on", async () => {
  const started = Date.now();
  const run = await runIsolated({
    tree: new Map(),
    isolation: unsandboxed,
    steps: (places) => [{ argv: [places.node, "-e", stray("")], network: false }, { argv: [places.node, "-e", "console.log('next')"], network: false }],
    timeoutMs: 30_000,
    outputBytes: 1024,
  });
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(run.steps[0]).toMatchObject({ exitCode: 0, timedOut: false, leftover: "1 process outlived the step and was killed" });
  expect(run.steps[1]).toEqual({ exitCode: 0, timedOut: false, truncated: false, ms: expect.any(Number), output: "next\n" });
  expect(await gone(Number(run.steps[0]?.output))).toBe(true);
  expect(existsSync(run.root)).toBe(false);
});

test("unsandboxed: a step past the limit with a process left behind is a timeout, not a wait", async () => {
  const started = Date.now();
  const run = await runIsolated({
    tree: new Map(),
    isolation: unsandboxed,
    steps: (places) => [{ argv: [places.node, "-e", stray("", " setInterval(() => {}, 1000);")], network: false }],
    timeoutMs: 1000,
    outputBytes: 1024,
  });
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(run.steps[0]).toMatchObject({ exitCode: null, timedOut: true, leftover: "1 process outlived the step and was killed" });
  expect(await gone(Number(run.steps[0]?.output))).toBe(true);
  expect(existsSync(run.root)).toBe(false);
});

test("unsandboxed: a left-behind process that hid itself still cannot hold the run, and the result says it is there", async () => {
  const started = Date.now();
  const run = await runIsolated({
    tree: new Map(),
    isolation: unsandboxed,
    steps: (places) => [{ argv: [places.node, "-e", stray(', env: {}, cwd: "/"')], network: false }],
    timeoutMs: 30_000,
    outputBytes: 1024,
  });
  const pid = Number(run.steps[0]?.output);
  try {
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(run.steps[0]).toMatchObject({ exitCode: 0, leftover: "something the step started kept its output open, and no process could be found to kill" });
    expect(existsSync(run.root)).toBe(false);
  } finally {
    process.kill(pid, "SIGKILL");
  }
});

test("in the sandbox a process left behind dies with its step: the namespace ends when the step does", async () => {
  const started = Date.now();
  const run = await runIsolated({
    tree: new Map(),
    isolation: bwrap,
    steps: (places) => [{ argv: [places.node, "-e", stray("")], network: false }, { argv: ["/bin/sh", "-c", "ps -e -o comm= | grep -c node || true"], network: false }],
    timeoutMs: 30_000,
    outputBytes: 1024,
  });
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(run.steps[0]).toEqual({ exitCode: 0, timedOut: false, truncated: false, ms: expect.any(Number), output: expect.stringMatching(/^\d+\n$/) });
  expect(run.steps[0]?.ms).toBeLessThan(900);
  expect(run.steps[1]?.output).toBe("0\n");
});

// Ctrl-C must leave nothing behind, even a folder the run locked.
for (const isolation of [bwrap, unsandboxed]) {
  test(`${isolation.kind}: an interrupted run removes its folder, locked folders and all`, async () => {
    const temp = await mkdtemp(join(tmpdir(), "rungs-interrupt-"));
    const script = `import { runIsolated } from ${JSON.stringify(fileURLToPath(new URL("../src/sandbox.ts", import.meta.url)))};
await runIsolated({
  tree: new Map(),
  isolation: ${JSON.stringify(isolation)},
  steps: () => [{ argv: ["/bin/sh", "-c", "mkdir -p locked/inner && echo x > locked/inner/file && chmod 000 locked && sleep 60"], network: false }],
  timeoutMs: 60000,
  outputBytes: 1024,
});
`;
    await writeFile(join(temp, "run.ts"), script);
    const child = spawn(process.execPath, [join(temp, "run.ts")], { env: { ...process.env, TMPDIR: temp }, stdio: "ignore" });
    try {
      const runs = () => readdirSync(temp).filter((name) => name.startsWith("rungs-run-"));
      const locked = () => runs().some((name) => existsSync(join(temp, name, "work", "locked")) && (statSync(join(temp, name, "work", "locked")).mode & 0o777) === 0);
      for (let tries = 0; tries < 100 && !locked(); tries += 1) await new Promise((resolve) => setTimeout(resolve, 50));
      expect(locked()).toBe(true);
      const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
      child.kill("SIGINT");
      expect(await exited).toBe(130);
      expect(runs()).toEqual([]);
    } finally {
      child.kill("SIGKILL");
      execFileSync("chmod", ["-R", "u+rwx", temp]);
      await rm(temp, { recursive: true, force: true });
    }
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
