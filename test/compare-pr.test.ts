import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { comparedLine } from "../src/arrival.ts";
import { parseOptions } from "../src/options.ts";
import { openPullRequest, repositoryKey } from "../src/pull-request.ts";
import { cleanup, failure, fixture, git, runners, snapshot, temp, view, worktrees, write } from "./pr-fixture.ts";

const cli = new URL("../src/cli.ts", import.meta.url).pathname;
afterAll(cleanup);

test("opens the head in a scratch worktree under the cache and leaves the user's checkout byte-identical", async () => {
  const f = fixture();
  const before = snapshot(f.user);
  const listBefore = worktrees(f.user);
  const opened = await openPullRequest({ number: 7, cwd: f.user, cacheDir: f.cache, runners: runners(view(f)) });
  expect(opened.dir.startsWith(join(f.cache, "pull-requests"))).toBe(true);
  expect(git(opened.dir, "rev-parse", "HEAD")).toBe(f.head);
  expect(opened.pr).toMatchObject({ number: 7, title: "Change a", head: f.head, state: "OPEN" });
  expect(opened.baseTip).toBe(f.baseTip);
  expect(opened.baseRef).toBe("main");
  expect(opened.description).toBe("## Claims\n\n- a returns 100\n");
  expect(opened.note).toBeUndefined();
  expect(existsSync(join(opened.dir, "src/added.ts"))).toBe(true);
  expect(snapshot(f.user)).toBe(before);
  await opened.remove();
  expect(existsSync(opened.dir)).toBe(false);
  expect(worktrees(f.user)).toBe(listBefore);
  expect(snapshot(f.user)).toBe(before);
  await opened.remove();
});

test("removeSync, as a dying process calls it, removes the worktree too", async () => {
  const f = fixture();
  const listBefore = worktrees(f.user);
  const opened = await openPullRequest({ number: 7, cwd: f.user, cacheDir: f.cache, runners: runners(view(f)) });
  expect(worktrees(f.user)).not.toBe(listBefore);
  opened.removeSync();
  expect(existsSync(opened.dir)).toBe(false);
  expect(worktrees(f.user)).toBe(listBefore);
});

test("a closed or merged pull request still opens against the base it had, with a note saying so", async () => {
  const f = fixture();
  for (const state of ["MERGED", "CLOSED"]) {
    const opened = await openPullRequest({ number: 7, cwd: f.user, cacheDir: f.cache, runners: runners(view(f, { state, baseRefOid: f.origBase })) });
    expect(opened.note).toBe(`pull request #7 is ${state.toLowerCase()}, not open; comparing it against the base it had`);
    expect(opened.baseTip).toBe(f.origBase);
    await opened.remove();
  }
});

test("a long multi-line title is cut to one bounded line", async () => {
  const f = fixture();
  const opened = await openPullRequest({ number: 7, cwd: f.user, cacheDir: f.cache, runners: runners(view(f, { title: `a\n${"b".repeat(500)}` })) });
  expect(opened.pr.title).not.toContain("\n");
  expect(opened.pr.title.length).toBeLessThanOrEqual(120);
  await opened.remove();
});

const errors: [string, Error, RegExp][] = [
  ["no gh", failure("", "ENOENT"), /install gh/],
  ["gh not logged in", failure("To get started with GitHub CLI, please run:  gh auth login"), /gh is not logged in/],
  ["PR not found", failure("GraphQL: Could not resolve to a PullRequest with the number of 7."), /pull request #7 not found/],
];
test.each(errors)("%s is one line and leaves nothing behind", async (_name, error, pattern) => {
  const f = fixture();
  const before = snapshot(f.user);
  const listBefore = worktrees(f.user);
  const failed = await openPullRequest({ number: 7, cwd: f.user, cacheDir: f.cache, runners: runners(error) }).catch((e: Error) => e);
  expect(failed).toBeInstanceOf(Error);
  expect((failed as Error).message).toMatch(pattern);
  expect((failed as Error).message).not.toContain("\n");
  expect(worktrees(f.user)).toBe(listBefore);
  expect(snapshot(f.user)).toBe(before);
});

test("a head that cannot be fetched says so and removes its scratch worktree", async () => {
  const f = fixture();
  const before = snapshot(f.user);
  const listBefore = worktrees(f.user);
  const failed = await openPullRequest({ number: 8, cwd: f.user, cacheDir: f.cache, runners: runners(view(f, { number: 8, url: `file://${f.origin}/pull/8` })) }).catch((e: Error) => e);
  expect((failed as Error).message).toMatch(/cannot fetch the head of pull request #8 from \S+ \(pull\/8\/head\)/);
  expect((failed as Error).message).not.toContain("\n");
  expect(worktrees(f.user)).toBe(listBefore);
  expect(readdirSync(join(f.cache, "pull-requests"))).toEqual([]);
  expect(snapshot(f.user)).toBe(before);
});

test("a base that cannot be fetched says so and cleans up", async () => {
  const f = fixture();
  const listBefore = worktrees(f.user);
  const failed = await openPullRequest({ number: 7, cwd: f.user, cacheDir: f.cache, runners: runners(view(f, { baseRefName: "nope" })) }).catch((e: Error) => e);
  expect((failed as Error).message).toMatch(/cannot fetch the base "nope"/);
  expect(worktrees(f.user)).toBe(listBefore);
});

test("outside a repository is a one-line error", async () => {
  const f = fixture();
  const failed = await openPullRequest({ number: 7, cwd: temp("streets-pr-none-"), cacheDir: temp("streets-pr-cache-"), runners: runners(view(f)) }).catch((e: Error) => e);
  expect((failed as Error).message).toMatch(/is not a git repository/);
});

test("--pr parses, and refuses a base, a directory, a description, a bad number, and no compare", () => {
  expect(parseOptions(["compare", "--pr", "14", "--link", "--walkthrough"])).toMatchObject({ pr: 14, base: undefined, link: true, walkthrough: true, tests: "off", judge: false });
  expect(parseOptions(["compare", "--pr", "14"])).toMatchObject({ tests: "off", judge: false, narrate: false });
  expect(parseOptions(["compare", "--pr", "14", "--run-tests", "--judge"])).toMatchObject({ tests: "sandboxed", judge: true });
  expect(parseOptions(["compare", "main", "--pr", "14"])).toMatch(/drop the base and directory/);
  expect(parseOptions(["compare", "--pr", "14", "somedir"])).toMatch(/drop the base and directory/);
  expect(parseOptions(["compare", "--pr", "14", "--description", "b.md"])).toMatch(/drop --description/);
  expect(parseOptions(["compare", "--pr", "0"])).toMatch(/invalid pull request number/);
  expect(parseOptions(["compare", "--pr", "x1"])).toMatch(/invalid pull request number/);
  expect(parseOptions(["--pr", "14"])).toMatch(/--pr needs compare/);
});

test("the header names the PR, its head and the merge base", () => {
  const against = { ref: "main", commit: "def5678".padEnd(40, "0"), pr: { number: 14, title: "Add a thing", head: "abc1234".padEnd(40, "0") } };
  expect(comparedLine("docviz", against)).toBe("PR #14: Add a thing, head abc1234 against main at def5678 (merge base)");
});

/** A gh that answers `pr view` from a file, on the PATH of the process under test. */
function fakeGh(json: string): string {
  const bin = temp("streets-pr-bin-");
  write(bin, "payload.json", json);
  write(bin, "gh", `#!/bin/sh\ncat "${join(bin, "payload.json")}"\n`);
  chmodSync(join(bin, "gh"), 0o755);
  return bin;
}

test("the command serves the PR page, names the PR, and removes its worktree when interrupted", async () => {
  const f = fixture();
  const bin = fakeGh(view(f));
  const before = snapshot(f.user);
  const listBefore = worktrees(f.user);
  const child = spawn("node", [cli, "compare", "--pr", "7", "--no-open", "--port", "0"], {
    cwd: f.user,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_CACHE_HOME: f.cache },
  });
  try {
    let out = "";
    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (chunk) => {
        out += chunk;
        if (out.split("\n").length >= 3) resolve();
      });
      child.on("exit", () => reject(new Error(`exited early: ${out}`)));
    });
    const [summary, url] = out.split("\n");
    expect(summary).toContain("PR #7 (Change a) at head " + f.head.slice(0, 7));
    expect(summary).toContain("against main at");
    expect(summary).toMatch(/1 files added, 1 altered, 0 removed, 0 moved/);
    const comparison = (await (await fetch(`${url}comparison.json`)).json()) as { against: { ref: string; commit: string; pr: { number: number; title: string; head: string } } };
    expect(comparison.against.pr).toEqual({ number: 7, title: "Change a", head: f.head });
    expect(comparison.against.ref).toBe("main");
    expect(worktrees(f.user)).not.toBe(listBefore);
    expect(snapshot(f.user)).toBe(before);
    await new Promise<void>((resolve) => {
      child.on("exit", () => resolve());
      child.kill("SIGINT");
    });
    expect(worktrees(f.user)).toBe(listBefore);
    expect(readdirSync(join(f.cache, "systems-to-streets", "pull-requests"))).toEqual([]);
    expect(snapshot(f.user)).toBe(before);
  } finally {
    child.kill();
  }
}, 60000);

test("the command's error exits 1 with one line and no worktree left", async () => {
  const f = fixture();
  const bin = fakeGh(view(f, { number: 8, url: `file://${f.origin}/pull/8` }));
  const listBefore = worktrees(f.user);
  const child = spawn("node", [cli, "compare", "--pr", "8", "--no-open"], { cwd: f.user, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_CACHE_HOME: f.cache } });
  let err = "";
  child.stderr.on("data", (chunk) => (err += chunk));
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  expect(code).toBe(1);
  expect(err.trim().split("\n")).toHaveLength(1);
  expect(err).toContain("cannot fetch the head of pull request #8");
  expect(worktrees(f.user)).toBe(listBefore);
}, 60000);

/** A second bare repository with its own main and its own, unrelated, pull/7/head. */
function upstream(): { dir: string; head: string } {
  const dir = temp("streets-pr-upstream-");
  git(dir, "init", "--quiet", "--bare", "--initial-branch=main");
  const seed = temp("streets-pr-useed-");
  git(seed, "init", "--quiet", "--initial-branch=main");
  write(seed, "other.ts", "export const other = 1;\n");
  git(seed, "add", "--all");
  git(seed, "commit", "--quiet", "-m", "upstream base");
  git(seed, "remote", "add", "origin", dir);
  git(seed, "push", "--quiet", "origin", "main");
  git(seed, "checkout", "--quiet", "-b", "pr");
  write(seed, "other.ts", "export const other = 2;\n");
  git(seed, "commit", "--quiet", "-am", "upstream change");
  git(seed, "push", "--quiet", "origin", "pr:refs/pull/7/head");
  return { dir, head: git(seed, "rev-parse", "HEAD") };
}

test("fetches from the repository gh resolved, not from origin, when they differ", async () => {
  const f = fixture();
  const up = upstream();
  const before = snapshot(f.user);
  const answer = view(f, { url: `file://${up.dir}/pull/7`, headRefOid: up.head });
  const opened = await openPullRequest({ number: 7, cwd: f.user, cacheDir: f.cache, runners: runners(answer) });
  expect(opened.pr.head).toBe(up.head);
  expect(existsSync(join(opened.dir, "other.ts"))).toBe(true);
  expect(existsSync(join(opened.dir, "src/added.ts"))).toBe(false);
  await opened.remove();
  expect(snapshot(f.user)).toBe(before);
});

test("a remote of the user's that is the gh-resolved repository is used by name", async () => {
  const f = fixture();
  const up = upstream();
  git(f.user, "remote", "add", "upstream", up.dir);
  const answer = view(f, { url: `file://${up.dir}/pull/7`, headRefOid: up.head });
  const opened = await openPullRequest({ number: 7, cwd: f.user, cacheDir: f.cache, runners: runners(answer) });
  expect(opened.pr.head).toBe(up.head);
  await opened.remove();
});

test("a fetched head that is not the commit gh names fails in one line and cleans up", async () => {
  const f = fixture();
  const up = upstream();
  const listBefore = worktrees(f.user);
  const failed = await openPullRequest({ number: 7, cwd: f.user, cacheDir: f.cache, runners: runners(view(f, { headRefOid: up.head })) }).catch((e: Error) => e);
  expect((failed as Error).message).toMatch(/but gh says pull request #7 is at/);
  expect((failed as Error).message).not.toContain("\n");
  expect(worktrees(f.user)).toBe(listBefore);
  expect(readdirSync(join(f.cache, "pull-requests"))).toEqual([]);
});

test("a merged PR's base that does not match the oid gh names fails", async () => {
  const f = fixture();
  const failed = await openPullRequest({ number: 7, cwd: f.user, cacheDir: f.cache, runners: runners(view(f, { state: "MERGED", baseRefOid: "0".repeat(40) })) }).catch((e: Error) => e);
  expect((failed as Error).message).toMatch(/cannot fetch the base 0000000/);
});

test("repositoryKey makes https, ssh and path spellings of one repository equal", () => {
  const keys = ["https://github.com/O/r.git", "git@github.com:o/r.git", "ssh://git@github.com/o/r", "https://github.com/o/r/"].map(repositoryKey);
  expect(new Set(keys).size).toBe(1);
  expect(repositoryKey("/tmp/x/up.git")).toBe(repositoryKey("file:///tmp/x/up"));
});

test("scratch worktrees left by a process that is gone are swept on the next run", async () => {
  const f = fixture();
  const root = join(f.cache, "pull-requests");
  mkdirSync(root, { recursive: true });
  const stale = join(root, "pr-9-999999999-abc");
  git(f.user, "worktree", "add", "--detach", "--quiet", stale);
  expect(worktrees(f.user)).toContain(stale);
  const opened = await openPullRequest({ number: 7, cwd: f.user, cacheDir: f.cache, runners: runners(view(f)) });
  expect(existsSync(stale)).toBe(false);
  expect(worktrees(f.user)).not.toContain(stale);
  await opened.remove();
});

test("an interrupt while the head is being fetched removes the worktree", async () => {
  const f = fixture();
  const bin = fakeGh(view(f));
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  write(bin, "git", `#!/bin/sh\ncase "$*" in *fetch*) sleep 5;; esac\nexec ${realGit} "$@"\n`);
  chmodSync(join(bin, "git"), 0o755);
  const listBefore = worktrees(f.user);
  const child = spawn("node", [cli, "compare", "--pr", "7", "--no-open", "--port", "0"], {
    cwd: f.user,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_CACHE_HOME: f.cache },
  });
  try {
    const deadline = Date.now() + 20000;
    while (worktrees(f.user) === listBefore && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(worktrees(f.user)).not.toBe(listBefore);
    const code = await new Promise<number | null>((resolve) => {
      child.on("exit", resolve);
      child.kill("SIGINT");
    });
    expect(code).toBe(130);
    expect(worktrees(f.user)).toBe(listBefore);
    expect(readdirSync(join(f.cache, "systems-to-streets", "pull-requests"))).toEqual([]);
  } finally {
    child.kill();
  }
}, 60000);

test("hooks in the PR's own tree never run, and the compared head is the PR's head", async () => {
  const marker = join(temp("streets-pr-marker-"), "ran");
  const f = fixture(`#!/bin/sh\ntouch "${marker}"\ngit reset --hard HEAD^ >/dev/null 2>&1\n`);
  git(f.user, "config", "core.hooksPath", ".githooks");
  const opened = await openPullRequest({ number: 7, cwd: f.user, cacheDir: f.cache, runners: runners(view(f)) });
  expect(existsSync(marker)).toBe(false);
  expect(git(opened.dir, "rev-parse", "HEAD")).toBe(f.head);
  expect(existsSync(join(opened.dir, "src/added.ts"))).toBe(true);
  await opened.remove();
  expect(existsSync(marker)).toBe(false);
});
