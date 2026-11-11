import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";

const cli = new URL("../src/cli.ts", import.meta.url).pathname;
const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const identity = ["user.name=t", "user.email=t@example.com", "commit.gpgsign=false"];
function git(dir: string, ...args: string[]): string {
  return execFileSync("git", [...identity.flatMap((s) => ["-c", s]), ...args], {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}
function write(dir: string, path: string, text: string): void {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), text);
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rungs-cmp-"));
  scratch.push(dir);
  git(dir, "init", "--quiet", "--initial-branch=main");
  write(dir, "package.json", "{}\n");
  write(dir, "src/a.ts", "export function a() {\n  return 1;\n}\n");
  write(dir, "src/b.ts", "export function b() {\n  return 2;\n}\n");
  write(dir, "src/c.ts", "export function c() {\n  return 3;\n}\n");
  git(dir, "add", "--all");
  git(dir, "commit", "--quiet", "-m", "base");
  git(dir, "checkout", "--quiet", "-b", "change");
  write(dir, "src/a.ts", "export function a() {\n  return 100;\n}\n");
  git(dir, "rm", "--quiet", "src/b.ts");
  git(dir, "mv", "src/c.ts", "src/moved.ts");
  write(dir, "src/added.ts", "export const added = () => 4;\n");
  write(dir, "src/untracked.ts", "export const untracked = () => 5;\n");
  return dir;
}

function run(args: string[], cwd: string) {
  return spawnSync("node", [cli, ...args], { cwd, encoding: "utf8", timeout: 30000 });
}

test("compare prints one line with the counts, serves the comparison, and stays up", async () => {
  const dir = repo();
  const child = spawn("node", [cli, "compare", "main", "--no-open", "--port", "0"], { cwd: dir });
  try {
    let out = "";
    const lines = await new Promise<string[]>((resolve, reject) => {
      child.stdout.on("data", (chunk) => {
        out += chunk;
        const all = out.split("\n");
        if (all.length >= 3) resolve(all);
      });
      child.once("error", reject);
      child.once("exit", () => reject(new Error(`exited early: ${out}`)));
    });
    const commit = git(dir, "rev-parse", "--short", "main");
    expect(lines[0]).toBe(
      `Rungs is comparing 5 files in ${dir} (uncommitted changes included) against main at ${commit} (merge base): 2 files added, 1 altered, 1 removed, 1 moved`,
    );
    const url = lines[1] ?? "";
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const comparison = (await (await fetch(new URL("comparison.json", url))).json()) as {
      against: { ref: string; commit: string };
      changes: { kind: string; node: { id: string } }[];
    };
    expect(comparison.against).toEqual({ ref: "main", commit: git(dir, "rev-parse", "main") });
    const files = comparison.changes.filter((c) => c.node.id.startsWith("file:")).map((c) => `${c.kind} ${c.node.id}`);
    expect(files).toEqual([
      "altered file:src/a.ts",
      "added file:src/added.ts",
      "removed file:src/b.ts",
      "moved file:src/moved.ts",
      "added file:src/untracked.ts",
    ]);
    const removed = await fetch(new URL(`source?id=${encodeURIComponent("file:src/b.ts")}`, url));
    expect(await removed.text()).toBe("export function b() {\n  return 2;\n}\n");
  } finally {
    child.kill();
  }
});

test("an unknown base prints one line and exits 1", () => {
  const dir = repo();
  const result = run(["compare", "nope", "--no-open"], dir);
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr.trim().split("\n")).toHaveLength(1);
  expect(result.stderr).toMatch(/^rungs: .*nope/);
});

test("compare without a base is a usage error, exit 2", () => {
  const result = run(["compare"], repo());
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("       rungs compare <base> [dir]");
});

function startCompare(dir: string, extra: string[], input?: string) {
  const child = spawn("node", [cli, "compare", "main", "--no-open", "--port", "0", ...extra], { cwd: dir });
  if (input !== undefined) child.stdin.end(input);
  const url = new Promise<string>((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
      const all = out.split("\n");
      if (all.length >= 3) resolve(all[1] ?? "");
    });
    child.once("exit", () => reject(new Error(`exited early: ${out}`)));
  });
  return { child, url };
}

const claims = async (url: string) => (await (await fetch(new URL("claims.json", url))).json()) as { description: string | null };

test("--description reads a file, and - reads stdin", async () => {
  const dir = repo();
  write(dir, "pr.md", "Reworks src/a.ts.\n");
  const fromFile = startCompare(dir, ["--description", "pr.md"]);
  const fromStdin = startCompare(dir, ["--description", "-"], "From stdin.\n");
  try {
    expect((await claims(await fromFile.url)).description).toBe("Reworks src/a.ts.\n");
    expect((await claims(await fromStdin.url)).description).toBe("From stdin.\n");
  } finally {
    fromFile.child.kill();
    fromStdin.child.kill();
  }
});

test("without --description the claims are null, never guessed", async () => {
  const dir = repo();
  const none = startCompare(dir, []);
  try {
    expect((await claims(await none.url)).description).toBeNull();
  } finally {
    none.child.kill();
  }
});

test("an unreadable --description file prints one line and exits 1", () => {
  const result = run(["compare", "main", "--no-open", "--description", "missing.md"], repo());
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toMatch(/^rungs: .*missing\.md/);
});

function stubClaude(body: string): string {
  const bin = mkdtempSync(join(tmpdir(), "rungs-bin-"));
  scratch.push(bin);
  const path = join(bin, "claude");
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(path, 0o755);
  return bin;
}

/** A PATH holding node and git and nothing else, so no claude is found. */
function bareBin(): string {
  const bin = mkdtempSync(join(tmpdir(), "rungs-bare-"));
  scratch.push(bin);
  symlinkSync(process.execPath, join(bin, "node"));
  symlinkSync(execFileSync("which", ["git"], { encoding: "utf8" }).trim(), join(bin, "git"));
  return bin;
}

function startLinked(dir: string, env: Record<string, string>, extra: string[]) {
  const desc = join(dir, "..", `desc-${Math.random().toString(36).slice(2)}.md`);
  writeFileSync(desc, "Changes a. Adds something new.\n");
  scratch.push(desc);
  const child = spawn("node", [cli, "compare", "main", "--no-open", "--port", "0", "--description", desc, ...extra], { cwd: dir, env: { ...process.env, ...env } });
  let err = "";
  child.stderr.on("data", (chunk) => (err += chunk));
  const url = new Promise<string>((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
      const all = out.split("\n");
      if (all.length >= 3) resolve(all[1] ?? "");
    });
    child.once("exit", () => reject(new Error(`exited early: ${out} ${err}`)));
  });
  return { child, url, stderr: () => err };
}

test("--link asks claude, serves the links, and a second run reads the cache", { timeout: 30000 }, async () => {
  const dir = repo();
  const cache = mkdtempSync(join(tmpdir(), "rungs-cache-"));
  scratch.push(cache);
  const bin = stubClaude(
    `process.stdin.resume().on("data", () => {}).on("end", () => console.log(JSON.stringify({ is_error: false, structured_output: { links: [{ claim: 0, ids: ["file:src/a.ts", "file:src/nope.ts"] }] }, modelUsage: { "stub-model": {} } })));`,
  );
  const env = { PATH: `${bin}:${bareBin()}`, XDG_CACHE_HOME: cache };
  const first = startLinked(dir, env, ["--link"]);
  try {
    const body = (await (await fetch(new URL("claims.json", await first.url))).json()) as { claims: { ids: string[] }[]; link: Record<string, unknown> };
    expect(body.claims.map((claim) => claim.ids)).toEqual([["file:src/a.ts"], []]);
    expect(body.link).toEqual({ status: "ok", model: "stub-model", promptVersion: "claims-v3", dropped: { ids: 1, claims: 0 }, cached: false });
    expect(first.stderr()).toMatch(/linked 1 of 2 claims by stub-model/);
  } finally {
    first.child.kill();
  }
  const second = startLinked(dir, { PATH: bareBin(), XDG_CACHE_HOME: cache }, ["--link"]);
  try {
    const body = (await (await fetch(new URL("claims.json", await second.url))).json()) as { link: { cached: boolean } };
    expect(body.link.cached).toBe(true);
  } finally {
    second.child.kill();
  }
});

test("--link with no claude on the path prints one line, serves without links, and says so", { timeout: 30000 }, async () => {
  const dir = repo();
  const cache = mkdtempSync(join(tmpdir(), "rungs-cache-"));
  scratch.push(cache);
  const run = startLinked(dir, { PATH: bareBin(), XDG_CACHE_HOME: cache }, ["--relink"]);
  try {
    const body = (await (await fetch(new URL("claims.json", await run.url))).json()) as { claims: { ids: string[] }[]; link: { status: string; message: string } };
    expect(body.link.status).toBe("failed");
    expect(body.link.message).toMatch(/not found/);
    expect(body.claims.every((claim) => claim.ids.length === 0)).toBe(true);
    const failures = run.stderr().split("\n").filter((line) => line.includes("no claim links"));
    expect(failures).toHaveLength(1);
  } finally {
    run.child.kill();
  }
});

const tourStub = `process.stdin.resume().on("data", () => {}).on("end", () => console.log(JSON.stringify({ is_error: false, structured_output: { stops: [{ title: "A", ids: ["function:src/a.ts#a", "file:src/nope.ts"], claims: [0, 9], narration: [{ text: "Returns more.", id: "function:src/a.ts#a", start: 1, end: 3 }, { text: "Off the end.", id: "function:src/a.ts#a", start: 1, end: 40 }] }] }, modelUsage: { "stub-model": {} } })));`;

test("--walkthrough asks claude for a tour, serves it, and a second run reads the cache until --rewalk", { timeout: 30000 }, async () => {
  const dir = repo();
  const cache = mkdtempSync(join(tmpdir(), "rungs-cache-"));
  scratch.push(cache);
  const first = startLinked(dir, { PATH: `${stubClaude(tourStub)}:${bareBin()}`, XDG_CACHE_HOME: cache }, ["--walkthrough"]);
  try {
    const body = (await (await fetch(new URL("walkthrough.json", await first.url))).json()) as { walkthrough: Record<string, unknown>; stops: unknown[] };
    expect(body.walkthrough).toEqual({ status: "ok", model: "stub-model", promptVersion: "tour-v1", dropped: { stops: 0, ids: 1, claims: 1, sentences: 1 }, cached: false });
    expect(body.stops).toEqual([{ title: "A", ids: ["function:src/a.ts#a"], claims: [0], sentences: [{ text: "Returns more.", id: "function:src/a.ts#a", range: { start: 1, end: 3 } }] }]);
    expect(first.stderr()).toMatch(/walkthrough of 1 stops by stub-model in \d+s \(dropped 0 stops, 1 unknown ids, 1 bad claim numbers, 1 unanchored sentences\)/);
  } finally {
    first.child.kill();
  }
  const second = startLinked(dir, { PATH: bareBin(), XDG_CACHE_HOME: cache }, ["--walkthrough"]);
  try {
    const body = (await (await fetch(new URL("walkthrough.json", await second.url))).json()) as { walkthrough: { cached: boolean } };
    expect(body.walkthrough.cached).toBe(true);
  } finally {
    second.child.kill();
  }
  const third = startLinked(dir, { PATH: bareBin(), XDG_CACHE_HOME: cache }, ["--rewalk"]);
  try {
    const body = (await (await fetch(new URL("walkthrough.json", await third.url))).json()) as { walkthrough: { status: string; message: string }; stops: unknown[] };
    expect(body.walkthrough.status).toBe("failed");
    expect(body.walkthrough.message).toMatch(/not found/);
    expect(body.stops).toEqual([]);
    expect(third.stderr().split("\n").filter((line) => line.includes("no walkthrough"))).toHaveLength(1);
  } finally {
    third.child.kill();
  }
});

const narrateStub = `process.stdin.resume().on("data", () => {}).on("end", () => console.log(JSON.stringify({ is_error: false, structured_output: { narration: [{ text: "Gives back four.", from: 0, to: 0 }, { text: "Off the end.", from: 5, to: 6 }] }, modelUsage: { "stub-model": {} } })));`;

test("--narrate narrates contract-moved functions ahead of time and on request, and a second run reads the cache", { timeout: 30000 }, async () => {
  const dir = repo();
  const cache = mkdtempSync(join(tmpdir(), "rungs-cache-"));
  scratch.push(cache);
  const id = encodeURIComponent("function:src/added.ts#added");
  const first = startLinked(dir, { PATH: `${stubClaude(narrateStub)}:${bareBin()}`, XDG_CACHE_HOME: cache }, ["--narrate"]);
  try {
    const url = await first.url;
    const list = (await (await fetch(new URL("narrate.json", url))).json()) as { ahead: string[] };
    expect(list.ahead).toContain("function:src/added.ts#added");
    const body = (await (await fetch(new URL(`narration?id=${id}`, url), { method: "POST", headers: { origin: new URL(url).origin } })).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ tier: "claimed", status: "ok", stale: false, model: "stub-model", dropped: { sentences: 1 }, cached: false });
    expect(body.sentences).toEqual([{ text: "Gives back four.", from: 0, to: 0, range: { start: 1, end: 1 } }]);
    expect(first.stderr()).toMatch(/narrated function:src\/added\.ts#added in 1 sentences by stub-model \(dropped 1 unanchored sentences\)/);
  } finally {
    first.child.kill();
  }
  const second = startLinked(dir, { PATH: bareBin(), XDG_CACHE_HOME: cache }, ["--narrate"]);
  try {
    const url = await second.url;
    const body = (await (await fetch(new URL(`narration?id=${id}`, url), { method: "POST", headers: { origin: new URL(url).origin } })).json()) as { cached: boolean };
    expect(body.cached).toBe(true);
  } finally {
    second.child.kill();
  }
});

test("without --narrate nothing is narrated and the endpoint is not there", { timeout: 30000 }, async () => {
  const dir = repo();
  const run = startLinked(dir, { PATH: bareBin(), XDG_CACHE_HOME: mkdtempSync(join(tmpdir(), "rungs-cache-")) }, []);
  try {
    const url = await run.url;
    expect((await fetch(new URL("narrate.json", url))).status).toBe(404);
    expect((await fetch(new URL("narration?id=x", url), { method: "POST" })).status).toBe(404);
  } finally {
    run.child.kill();
  }
});
