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

const SECRET = "streets-probe-secret-value";
const outsideFile = fileURLToPath(import.meta.url);
let server: Server;
let port: number;
let hostDir: string;

beforeAll(async () => {
  process.env.STREETS_PROBE_SECRET = SECRET;
  process.env.npm_config_git = "/tmp/payload.sh";
  server = createServer((socket) => socket.on("error", () => {}).end("hello\n"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  hostDir = await mkdtemp(join(tmpdir(), "streets-host-"));
});

afterAll(async () => {
  delete process.env.STREETS_PROBE_SECRET;
  delete process.env.npm_config_git;
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
  assert.equal(process.env.STREETS_PROBE_SECRET, undefined);
  assert.equal(process.env.SSH_AUTH_SOCK, undefined);
  assert.equal(process.env.GH_TOKEN, undefined);
  assert.deepEqual(Object.keys(process.env).filter((name) => /^npm_config_/i.test(name)), []);
  assert.notEqual(process.env.HOME, ${JSON.stringify(process.env.HOME)});
});
`;
  return new Map([
    ["package.json", `{"type":"module","scripts":{"test":"node --test"}}\n`],
    ["probe.test.mjs", probe],
  ]);
}

const nodeTest = (places: Places): Step[] => [
  { argv: [places.node, "--test", "--test-reporter=tap", "probe.test.mjs"] },
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

test("only the install gets the network: it reaches the host, and no step ever does", async () => {
  const connect = `require("net").connect(${port}, "127.0.0.1").on("data", (d) => process.stdout.write(d)).on("error", (e) => console.log(e.code))`;
  const run = await runIsolated({
    tree: new Map(),
    isolation: bwrap,
    install: { files: new Map(), argv: (places) => [places.node, "-e", connect] },
    steps: (places) => [{ argv: [places.node, "-e", connect] }],
    ...limits,
  });
  expect(run.install?.output.trim()).toBe("hello");
  expect(run.steps.map((step) => step.output.trim())).toEqual(["ECONNREFUSED"]);
});

for (const isolation of [bwrap, unsandboxed]) {
  test(`${isolation.kind}: a run past its time limit is killed, children and all`, async () => {
    const started = Date.now();
    const run = await runIsolated({
      tree: new Map(),
      isolation,
      steps: (places) => [
        { argv: ["/bin/sh", "-c", `"${places.node}" -e "setInterval(() => {}, 1000)" & wait`] },
        { argv: [places.node, "-e", "console.log('never')"] },
      ],
      timeoutMs: 500,
      outputBytes: 1024,
    });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(run.steps).toHaveLength(1);
    expect(run.steps[0]).toMatchObject({ timedOut: true, exitCode: null });
    expect(existsSync(run.root)).toBe(false);
  });

  test(`${isolation.kind}: output past the limit is cut and marked, and a locked folder is still removed`, { timeout: 60_000 }, async () => {
    const run = await runIsolated({
      tree: new Map([["a/b.txt", "text\n"]]),
      isolation,
      steps: (places) => [
        { argv: ["/bin/sh", "-c", `"${places.node}" -e "process.stdout.write('x'.repeat(100000))"; chmod 000 a`] },
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
        { argv: ["/bin/sh", "-c", "cat src/one.txt two.txt; exit 3"] },
        { argv: [places.node, "-e", "console.log('never')"] },
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
        { argv: ["/bin/sh", "-c", `printf small > "${places.out}/a.json"; head -c 5000 /dev/zero > "${places.out}/b.json"`] },
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
const FILE_SECRET = "streets-host-file-secret-value";
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
      steps: (places) => [{ argv: ["/bin/sh", "-c", `cd "${places.out}" && mkfifo a.json && mkdir b.json`] }],
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
    steps: (places) => [{ argv: ["/bin/sh", "-c", `rmdir "${places.out}" && ln -s "${hostDir}" "${places.out}"`] }],
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
    steps: (places) => [{ argv: ["/bin/sh", "-c", `mkdir "${places.out}2" && printf x > "${places.out}2/a.json" && rmdir "${places.out}" && mv "${places.out}2" "${places.out}"`] }],
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
    steps: (places) => [{ argv: ["/bin/sh", "-c", `ln "${secret}" "${places.out}/a.json"`] }],
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
    steps: (places) => [{ argv: ["/bin/sh", "-c", `head -c 1001 /dev/zero > "${places.out}/a.json"`] }],
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
    steps: (places) => [{ argv: [places.node, "-e", stray("")] }, { argv: [places.node, "-e", "console.log('next')"] }],
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
  // The 1 s limit runs from the step's start, so the process must exist almost at once: a shell
  // starts it in a millisecond or two, where a second node can take over a second to start on a
  // loaded machine and the limit would end the step before it left anything behind.
  const run = await runIsolated({
    tree: new Map(),
    isolation: unsandboxed,
    steps: () => [{ argv: ["/bin/sh", "-c", "setsid sleep 1000 & echo $!; sleep 1000"] }],
    timeoutMs: 1000,
    outputBytes: 1024,
  });
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(run.steps[0]).toMatchObject({ exitCode: null, timedOut: true, leftover: "1 process outlived the step and was killed" });
  const pid = Number(run.steps[0]?.output);
  expect(pid).toBeGreaterThan(0);
  expect(await gone(pid)).toBe(true);
  expect(existsSync(run.root)).toBe(false);
});

test("unsandboxed: a left-behind process that hid itself still cannot hold the run, and the result says it is there", async () => {
  const started = Date.now();
  const run = await runIsolated({
    tree: new Map(),
    isolation: unsandboxed,
    steps: (places) => [{ argv: [places.node, "-e", stray(', env: {}, cwd: "/"')] }],
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
    steps: (places) => [{ argv: [places.node, "-e", stray("")] }, { argv: ["/bin/sh", "-c", "ps -e -o comm= | grep -c node || true"] }],
    timeoutMs: 30_000,
    outputBytes: 1024,
  });
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(run.steps[0]).toEqual({ exitCode: 0, timedOut: false, truncated: false, ms: expect.any(Number), output: expect.stringMatching(/^\d+\n$/) });
  // The output closed because the namespace ended, not because the 1 s output grace ran out: only the grace path names a leftover. (No elapsed-time bound: node start-up alone can pass it under load.)
  expect(run.steps[0]?.leftover).toBeUndefined();
  expect(run.steps[1]?.output).toBe("0\n");
});

// Ctrl-C must leave nothing behind, even a folder the run locked.
for (const isolation of [bwrap, unsandboxed]) {
  test(`${isolation.kind}: an interrupted run removes its folder, locked folders and all`, async () => {
    const temp = await mkdtemp(join(tmpdir(), "streets-interrupt-"));
    const script = `import { runIsolated } from ${JSON.stringify(fileURLToPath(new URL("../src/sandbox.ts", import.meta.url)))};
await runIsolated({
  tree: new Map(),
  isolation: ${JSON.stringify(isolation)},
  steps: () => [{ argv: ["/bin/sh", "-c", "mkdir -p locked/inner && echo x > locked/inner/file && chmod 000 locked && sleep 60"] }],
  timeoutMs: 60000,
  outputBytes: 1024,
});
`;
    await writeFile(join(temp, "run.ts"), script);
    const child = spawn(process.execPath, [join(temp, "run.ts")], { env: { ...process.env, TMPDIR: temp }, stdio: "ignore" });
    try {
      const runs = () => readdirSync(temp).filter((name) => name.startsWith("streets-run-"));
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

test("files marked executable keep their mode in the copy", async () => {
  const run = await runIsolated({
    tree: new Map([["run.sh", "#!/bin/sh\necho ran\n"], ["plain.sh", "#!/bin/sh\necho ran\n"]]),
    executable: new Set(["run.sh"]),
    isolation: bwrap,
    steps: () => [{ argv: ["/bin/sh", "-c", "./run.sh; ./plain.sh 2>/dev/null || echo refused"] }],
    ...limits,
  });
  expect(run.steps[0]?.output).toBe("ran\nrefused\n");
});

// Fetching dependencies is the one thing that gets the network, so it is kept away from the tree.
const SHA = "0123456789abcdef0123456789abcdef01234567";
const GIT_URL = `git+ssh://git@127.0.0.1:1/none/none.git#${SHA}`;
const gitLock = JSON.stringify({
  name: "probe",
  version: "1.0.0",
  lockfileVersion: 3,
  requires: true,
  packages: {
    "": { name: "probe", version: "1.0.0", dependencies: { dep: GIT_URL } },
    "node_modules/dep": { version: "1.0.0", resolved: GIT_URL },
  },
});
const gitManifest = `{"name":"probe","version":"1.0.0","dependencies":{"dep":"${GIT_URL}"}}\n`;

for (const isolation of [bwrap, unsandboxed]) {
  test(`${isolation.kind}: the install runs before the steps, in a folder that holds only its own files`, async () => {
    const run = await runIsolated({
      tree: new Map([[".npmrc", "git=/work/payload.sh\n"], ["payload.sh", "#!/bin/sh\n"], ["package.json", "{}\n"]]),
      executable: new Set(["payload.sh"]),
      isolation,
      install: {
        files: new Map([["package.json", "{}\n"], ["package-lock.json", "{}\n"]]),
        argv: (places) => ["/bin/sh", "-c", `pwd; ls -A; test "$PWD" = "${places.install}" && mkdir -p node_modules/dep && echo 42 > node_modules/dep/index.js`],
      },
      steps: () => [{ argv: ["/bin/sh", "-c", "ls -A; cat node_modules/dep/index.js"] }],
      ...limits,
    });
    expect(run.install).toMatchObject({ exitCode: 0, timedOut: false });
    expect(run.install?.output).toBe(`${run.places.install}\npackage-lock.json\npackage.json\n`);
    expect(run.steps.map((step) => step.output)).toEqual([".npmrc\nnode_modules\npackage.json\npayload.sh\n42\n"]);
  });

  test(`${isolation.kind}: a failed install runs no step and moves nothing`, async () => {
    const run = await runIsolated({
      tree: new Map(),
      isolation,
      install: { files: new Map(), argv: () => ["/bin/sh", "-c", "mkdir node_modules; exit 7"] },
      steps: () => [{ argv: ["/bin/sh", "-c", "echo never"] }],
      ...limits,
    });
    expect(run.install).toMatchObject({ exitCode: 7 });
    expect(run.steps).toEqual([]);
  });
}

test("in the sandbox the install cannot see the copy, the out folder or the user's files", async () => {
  const run = await runIsolated({
    tree: new Map([["secret.txt", "tree text\n"]]),
    isolation: bwrap,
    install: {
      files: new Map(),
      argv: () => ["/bin/sh", "-c", `ls /work /out ${JSON.stringify(outsideFile)} 2>&1; ls /`],
    },
    steps: () => [],
    ...limits,
  });
  expect(run.install?.output).toMatch(/\/work.*No such file/);
  expect(run.install?.output).toMatch(/\/out.*No such file/);
  expect(run.install?.output).toMatch(/sandbox\.test\.ts.*No such file/);
  expect(run.install?.output).not.toContain("tree text");
});

test("a tree's .npmrc naming its own program as git never runs it: npm installs where the tree is not", async () => {
  let reached = 0;
  const beacon = createServer((socket) => {
    reached += 1;
    socket.on("error", () => {}).end();
  });
  await new Promise<void>((resolve) => beacon.listen(0, "127.0.0.1", resolve));
  const beaconPort = (beacon.address() as AddressInfo).port;
  try {
    const run = await runIsolated({
      tree: new Map([
        [".npmrc", "git=/work/payload.sh\n"],
        ["payload.sh", `#!/bin/sh\n/streets/bin/node -e 'require("net").connect(${beaconPort}, "127.0.0.1")'\necho pwned > /out/marker\nexit 1\n`],
        ["package.json", gitManifest],
        ["package-lock.json", gitLock],
      ]),
      executable: new Set(["payload.sh"]),
      isolation: bwrap,
      // Plain npm, with none of the pinned settings: only the folder keeps the tree's program away.
      install: {
        files: new Map([["package.json", gitManifest], ["package-lock.json", gitLock]]),
        argv: (places) => [places.node, places.npm, "ci", "--ignore-scripts", "--fetch-retries=0"],
      },
      steps: () => [],
      collect: ["marker"],
      ...limits,
    });
    expect(run.install?.exitCode).not.toBe(0);
    expect(run.install?.output).not.toContain("payload.sh");
    expect(reached).toBe(0);
    expect(run.collected.get("marker")).toEqual({ kind: "missing" });
  } finally {
    await new Promise((resolve) => beacon.close(resolve));
  }
});

// A step's report goes into an open file that has no name anywhere, and that only the
// step's first process holds: the processes it starts can neither inherit nor reopen it.
const reaching = `
const { appendFileSync, writeSync } = require("node:fs");
const { execFileSync, spawnSync } = require("node:child_process");
if (process.argv[1] === "child") {
  const tries = [];
  try { writeSync(3, "FORGED inherited\\n"); tries.push("inherited"); } catch (error) { tries.push(error.code); }
  try { appendFileSync("/proc/" + process.ppid + "/fd/3", "FORGED reopened\\n"); tries.push("reopened"); } catch (error) { tries.push(error.code); }
  try { execFileSync("/bin/sh", ["-c", "echo FORGED shell >> /proc/" + process.ppid + "/fd/3"], { stdio: "ignore" }); tries.push("shell"); } catch { tries.push("refused"); }
  console.log(tries.join(" "));
} else {
  writeSync(3, "real line\\n");
  spawnSync(process.execPath, ["-e", process.argv[1], "child"], { stdio: ["ignore", "inherit", "inherit"] });
}
`;

test("in the sandbox a step's report comes back from a file with no name, which no process it starts can write to", async () => {
  const run = await runIsolated({
    tree: new Map(),
    isolation: bwrap,
    report: true,
    steps: (places) => [{ argv: [places.node, "-e", reaching, reaching] }, { argv: ["/bin/sh", "-c", `echo second > ${places.report}`] }],
    ...limits,
  });
  expect(run.steps.map((step) => step.exitCode)).toEqual([0, 0]);
  // The first is whatever error a descriptor that is not the report gives; the others are refusals.
  expect(run.steps[0]?.output).toMatch(/^E[A-Z]+ EACCES refused\n$/);
  expect(run.report).toEqual({ kind: "text", text: "real line\nsecond\n" });
});

test("unsandboxed, the report still comes back, but the step's own processes can reach it", async () => {
  const run = await runIsolated({ tree: new Map(), isolation: unsandboxed, report: true, steps: (places) => [{ argv: [places.node, "-e", reaching, reaching] }], ...limits });
  expect(run.steps[0]?.output).toMatch(/^E[A-Z]+ reopened shell\n$/);
  expect(run.report).toMatchObject({ kind: "text", text: expect.stringMatching(/^real line\n/) });
});

for (const isolation of [bwrap, unsandboxed]) {
  test(`${isolation.kind}: a report past the size limit is too large, and a run that asked for none has none`, async () => {
    const large = await runIsolated({
      tree: new Map(),
      isolation,
      report: true,
      steps: (places) => [{ argv: ["/bin/sh", "-c", `head -c 5000 /dev/zero > ${places.report}`] }],
      ...limits,
      collectBytes: 1000,
    });
    expect(large.report).toEqual({ kind: "too large", bytes: expect.any(Number) });
    const none = await runIsolated({ tree: new Map(), isolation, steps: () => [{ argv: ["/bin/sh", "-c", "echo x >&3 2>/dev/null || echo closed"] }], ...limits });
    expect(none.report).toBeUndefined();
    expect(none.steps[0]?.output).toContain("closed\n");
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

// Pinned files are the ones a step may read and not change: the tests that count as evidence.
const PIN_SCRIPT = `import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
const tries = {
  write: () => writeFileSync("test/a.test.mjs", "FORGED"),
  append: () => writeFileSync("test/a.test.mjs", "FORGED", { flag: "a" }),
  remove: () => rmSync("test/a.test.mjs"),
  rename: () => renameSync("test/a.test.mjs", "test/gone.mjs"),
  replace: () => { writeFileSync("test/new.mjs", "FORGED"); renameSync("test/new.mjs", "test/a.test.mjs"); },
  renameFolder: () => renameSync("test", "moved"),
  removeFolder: () => rmSync("test", { recursive: true }),
  link: () => { rmSync("test/a.test.mjs"); symlinkSync("/etc/passwd", "test/a.test.mjs"); },
  chmod: () => { chmodSync("test/a.test.mjs", 0o644); writeFileSync("test/a.test.mjs", "FORGED"); },
  renameDeep: () => renameSync("test/deep", "test/deeper"),
  removeDeep: () => rmSync("test/deep", { recursive: true }),
  unmount: () => execFileSync("umount", ["/work/test/a.test.mjs"], { stdio: "ignore" }),
  unmountFolder: () => execFileSync("umount", ["/work/test"], { stdio: "ignore" }),
};
const outcome = {};
for (const [name, attempt] of Object.entries(tries)) {
  try { attempt(); outcome[name] = "done"; } catch (error) { outcome[name] = error.code; }
}
writeFileSync("free.txt", "changed");
console.log(JSON.stringify({ outcome, kept: readFileSync("test/a.test.mjs", "utf8"), deep: readFileSync("test/deep/b.test.mjs", "utf8"), free: readFileSync("free.txt", "utf8") }));
`;

test("bwrap: a step cannot change, remove, replace or move a pinned file, and can change files that are not pinned", async () => {
  const run = await runIsolated({
    tree: new Map([["test/a.test.mjs", "ORIGINAL"], ["test/deep/b.test.mjs", "DEEP"], ["free.txt", "before"], ["pin.mjs", PIN_SCRIPT]]),
    pinned: new Set(["test/a.test.mjs", "test/deep/b.test.mjs"]),
    isolation: bwrap,
    steps: (places) => [{ argv: [places.node, "pin.mjs"] }],
    timeoutMs: 30_000,
    outputBytes: 1 << 16,
  });
  const result = JSON.parse(run.steps[0]?.output ?? "{}") as { outcome: Record<string, string>; kept: string; deep: string; free: string };
  expect(result.kept).toBe("ORIGINAL");
  expect(result.deep).toBe("DEEP");
  expect(result.free).toBe("changed");
  for (const [name, code] of Object.entries(result.outcome)) expect(code, name).not.toBe("done");
});

test("unsandboxed: a pinned file is written read-only, which is all the copy can promise", async () => {
  const run = await runIsolated({
    tree: new Map([["test/a.test.mjs", "ORIGINAL"], ["pin.mjs", `import { statSync, writeFileSync } from "node:fs"; try { writeFileSync("test/a.test.mjs", "X"); } catch (error) { console.log(error.code, (statSync("test/a.test.mjs").mode & 0o777).toString(8)); }`]]),
    pinned: new Set(["test/a.test.mjs"]),
    isolation: { kind: "unsandboxed" },
    steps: (places) => [{ argv: [places.node, "pin.mjs"] }],
    timeoutMs: 30_000,
    outputBytes: 1 << 16,
  });
  expect(run.steps[0]?.output.trim()).toBe("EACCES 444");
});

test("a pinned path the tree does not hold is refused before anything runs", async () => {
  await expect(
    runIsolated({ tree: new Map([["a", "x"]]), pinned: new Set(["b"]), isolation: { kind: "unsandboxed" }, steps: () => [], timeoutMs: 1000, outputBytes: 100 }),
  ).rejects.toThrow('a pinned file is not in the tree: "b"');
});
