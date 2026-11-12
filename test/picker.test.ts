import { spawn } from "node:child_process";
import { chmodSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { readBase, readCheckout } from "../src/checkout.ts";
import { servePicker } from "../src/picker.ts";
import type { RunningPicker } from "../src/picker.ts";
import type { OpenedPullRequest, Runner } from "../src/pull-request.ts";
import { systemRunners } from "../src/pull-request.ts";
import { createSnapshot } from "../src/server.ts";
import { cleanup, failure, fixture, snapshot, temp, view, worktrees, write } from "./pr-fixture.ts";
import type { Fixture } from "./pr-fixture.ts";

afterAll(cleanup);

const cli = new URL("../src/cli.ts", import.meta.url).pathname;

/** What the page's picker would be given by `gh pr list`. */
const listing = (f: Fixture, over: Record<string, unknown>[] = []): string =>
  JSON.stringify([{ number: 7, title: "Change a", url: `file://${f.origin}/pull/7`, headRefOid: f.head, isDraft: false, author: { login: "octo" }, ...(over[0] ?? {}) }, ...over.slice(1)]);

interface Gh {
  head: string;
  viewCalls: number;
  listCalls: number;
  /** Set to make every gh call fail with this. */
  fail?: Error;
}
const ghFor = (f: Fixture, state: Gh): Runner => async (args) => {
  if (state.fail !== undefined) throw state.fail;
  if (args[0] === "pr" && args[1] === "list") {
    state.listCalls += 1;
    return listing(f);
  }
  state.viewCalls += 1;
  return view(f, { headRefOid: state.head });
};

async function start(f: Fixture, state: Gh, over: { headTtlMs?: number } = {}): Promise<RunningPicker> {
  const build = async (opened: OpenedPullRequest) => {
    const base = await readBase(opened.dir, opened.baseTip);
    return createSnapshot(await readCheckout(opened.dir), { ...base, ref: opened.baseRef, pr: { number: opened.pr.number, title: opened.pr.title, head: opened.pr.head } }, opened.description);
  };
  return servePicker({
    dir: f.user,
    port: 0,
    cacheDir: f.cache,
    runners: { git: systemRunners.git, gh: ghFor(f, state) },
    plain: await createSnapshot(await readCheckout(f.user)),
    build,
    ...over,
  });
}
const post = (picker: RunningPicker, path: string, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${picker.url}${path}`, { method: "POST", headers: { origin: picker.url.replace(/\/$/, ""), ...headers } });
const json = async (response: Response): Promise<Record<string, unknown>> => (await response.json()) as Record<string, unknown>;
const scratchDirs = (f: Fixture): string[] => {
  try {
    return readdirSync(join(f.cache, "pull-requests"));
  } catch {
    return [];
  }
};

test("with no PR picked it serves the working tree page and lists the open PRs through gh", async () => {
  const f = fixture();
  const picker = await start(f, { head: f.head, viewCalls: 0, listCalls: 0 });
  try {
    expect(picker.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect((await fetch(picker.url)).status).toBe(200);
    expect((await fetch(`${picker.url}comparison.json`)).status).toBe(404);
    const answer = await json(await fetch(`${picker.url}pull-requests.json`));
    expect(answer).toMatchObject({ status: "ok", current: null, truncated: false });
    expect(answer.prs).toEqual([{ number: 7, title: "Change a", url: `file://${f.origin}/pull/7`, head: f.head, draft: false, author: "octo" }]);
  } finally {
    await picker.close();
  }
});

test("gh missing is one line, never an empty list, and the page still serves", async () => {
  const f = fixture();
  const picker = await start(f, { head: f.head, viewCalls: 0, listCalls: 0, fail: failure("", "ENOENT") });
  try {
    const answer = await json(await fetch(`${picker.url}pull-requests.json`));
    expect(answer.status).toBe("unavailable");
    expect(answer.prs).toBeUndefined();
    expect(String(answer.why)).toMatch(/gh/);
    expect(String(answer.why)).toMatch(/install/);
    expect(String(answer.why)).not.toContain("\n");
    expect((await fetch(picker.url)).status).toBe(200);
    expect((await post(picker, "pull-request?number=7")).status).toBe(502);
  } finally {
    await picker.close();
  }
});

test("gh not logged in is its own one line", async () => {
  const f = fixture();
  const picker = await start(f, { head: f.head, viewCalls: 0, listCalls: 0, fail: failure("To get started with GitHub CLI, please run:  gh auth login") });
  try {
    const answer = await json(await fetch(`${picker.url}pull-requests.json`));
    expect(answer).toMatchObject({ status: "unavailable", why: "gh is not logged in: run gh auth login" });
  } finally {
    await picker.close();
  }
});

test("picking a PR serves the comparison of that PR and leaves the user's checkout alone", async () => {
  const f = fixture();
  const before = snapshot(f.user);
  const listBefore = worktrees(f.user);
  const picker = await start(f, { head: f.head, viewCalls: 0, listCalls: 0 });
  try {
    const picked = await post(picker, "pull-request?number=7");
    expect(picked.status).toBe(200);
    expect(await json(picked)).toMatchObject({ ok: true, number: 7, head: f.head });
    const comparison = (await (await fetch(`${picker.url}comparison.json`)).json()) as { against: { ref: string; pr: { number: number; head: string } } };
    expect(comparison.against.ref).toBe("main");
    expect(comparison.against.pr).toMatchObject({ number: 7, head: f.head });
    expect((await json(await fetch(`${picker.url}pull-requests.json`))).current).toEqual({ number: 7, head: f.head });
    expect(worktrees(f.user)).not.toBe(listBefore);
    expect(snapshot(f.user)).toBe(before);
  } finally {
    await picker.close();
  }
  expect(worktrees(f.user)).toBe(listBefore);
  expect(scratchDirs(f)).toEqual([]);
  expect(snapshot(f.user)).toBe(before);
});

test("reload re-fetches into a fresh worktree and removes the one it replaces", async () => {
  const f = fixture();
  const picker = await start(f, { head: f.head, viewCalls: 0, listCalls: 0 });
  try {
    await post(picker, "pull-request?number=7");
    const [first] = scratchDirs(f);
    expect(first).toBeDefined();
    const reloaded = await post(picker, "pull-request?reload=1");
    expect(reloaded.status).toBe(200);
    const after = scratchDirs(f);
    expect(after).toHaveLength(1);
    expect(after[0]).not.toBe(first);
    expect(existsSync(join(f.cache, "pull-requests", first!))).toBe(false);
    expect((await fetch(`${picker.url}comparison.json`)).status).toBe(200);
  } finally {
    await picker.close();
  }
  expect(scratchDirs(f)).toEqual([]);
});

test("a pick that fails keeps the current PR and leaves no worktree behind", async () => {
  const f = fixture();
  const state: Gh = { head: f.head, viewCalls: 0, listCalls: 0 };
  const picker = await start(f, state);
  try {
    await post(picker, "pull-request?number=7");
    state.head = "0".repeat(40);
    const failed = await post(picker, "pull-request?reload=1");
    expect(failed.status).toBe(502);
    expect(String((await json(failed)).why)).not.toContain("\n");
    expect(scratchDirs(f)).toHaveLength(1);
    expect((await json(await fetch(`${picker.url}pull-requests.json`))).current).toEqual({ number: 7, head: f.head });
  } finally {
    await picker.close();
  }
});

test("the head check says moved only when gh says so, unknown when it cannot ask, and asks gh at most once per window", async () => {
  const f = fixture();
  const state: Gh = { head: f.head, viewCalls: 0, listCalls: 0 };
  const picker = await start(f, state, { headTtlMs: 60_000 });
  try {
    expect((await fetch(`${picker.url}pull-request-head.json`)).status).toBe(404);
    await post(picker, "pull-request?number=7");
    const opens = state.viewCalls;
    expect(await json(await fetch(`${picker.url}pull-request-head.json`))).toMatchObject({ number: 7, head: f.head, latest: f.head, moved: false });
    state.head = "1".repeat(40);
    // Inside the window the answer is the kept one: a page asking in a loop does not reach gh.
    for (let i = 0; i < 5; i++) await fetch(`${picker.url}pull-request-head.json`);
    expect(state.viewCalls).toBe(opens + 1);
  } finally {
    await picker.close();
  }
  const g = fixture();
  const moved: Gh = { head: g.head, viewCalls: 0, listCalls: 0 };
  const second = await start(g, moved, { headTtlMs: 0 });
  try {
    await post(second, "pull-request?number=7");
    moved.head = "2".repeat(40);
    expect(await json(await fetch(`${second.url}pull-request-head.json`))).toMatchObject({ head: g.head, latest: "2".repeat(40), moved: true });
    moved.fail = failure("HTTP 502");
    const unknown = await json(await fetch(`${second.url}pull-request-head.json`));
    expect(unknown).toMatchObject({ latest: null, moved: null });
    expect(String(unknown.why)).not.toContain("\n");
  } finally {
    await second.close();
  }
});

test("the pick routes need POST, this server's own Origin and Host, and a real number", async () => {
  const f = fixture();
  const picker = await start(f, { head: f.head, viewCalls: 0, listCalls: 0 });
  try {
    expect((await fetch(`${picker.url}pull-request?number=7`)).status).toBe(405);
    expect((await post(picker, "pull-request?number=7", { origin: "http://evil.example" })).status).toBe(403);
    expect((await fetch(`${picker.url}pull-request?number=7`, { method: "POST" })).status).toBe(403);
    expect((await post(picker, "pull-request?number=0")).status).toBe(400);
    expect((await post(picker, "pull-request?number=7abc")).status).toBe(400);
    expect((await post(picker, "pull-request")).status).toBe(400);
    expect((await post(picker, "pull-request?reload=1")).status).toBe(409);
    expect(scratchDirs(f)).toEqual([]);
  } finally {
    await picker.close();
  }
});

test("removeAllSync, as a dying process calls it, removes the worktree", async () => {
  const f = fixture();
  const listBefore = worktrees(f.user);
  const picker = await start(f, { head: f.head, viewCalls: 0, listCalls: 0 });
  await post(picker, "pull-request?number=7");
  expect(worktrees(f.user)).not.toBe(listBefore);
  picker.removeAllSync();
  expect(worktrees(f.user)).toBe(listBefore);
  await picker.close();
});

/** A gh on the PATH of the process under test: `pr list` and `pr view`, from files. */
function fakeGh(f: Fixture): string {
  const bin = temp("streets-pick-bin-");
  write(bin, "list.json", listing(f));
  write(bin, "view.json", view(f));
  write(bin, "gh", `#!/bin/sh\nif [ "$2" = list ]; then cat "${join(bin, "list.json")}"; else cat "${join(bin, "view.json")}"; fi\n`);
  chmodSync(join(bin, "gh"), 0o755);
  return bin;
}

async function startCli(args: string[], cwd: string, env: Record<string, string>): Promise<{ url: string; stop(): Promise<void> }> {
  const child = spawn(process.execPath, [cli, ...args, "--no-open", "--port", "0"], { cwd, env: { ...process.env, ...env } });
  let out = "";
  const url = await new Promise<string>((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      out += chunk;
      const found = /(http:\/\/127\.0\.0\.1:\d+\/)/.exec(out);
      if (found?.[1] !== undefined) resolve(found[1]);
    });
    child.on("exit", () => reject(new Error(`exited early: ${out}`)));
  });
  return {
    url,
    stop: () =>
      new Promise<void>((resolve) => {
        child.on("exit", () => resolve());
        child.kill("SIGINT");
      }),
  };
}

test("picking PR 7 draws exactly what compare --pr 7 draws, and stopping removes the worktree", async () => {
  const f = fixture();
  const listBefore = worktrees(f.user);
  const env = { PATH: `${fakeGh(f)}:${process.env.PATH ?? ""}`, XDG_CACHE_HOME: f.cache };
  const compared = await startCli(["compare", "--pr", "7"], f.user, env);
  const bodies = new Map<string, string>();
  const paths = ["comparison.json", "graph.json", "claims.json", "contracts.json", "risks.json", "test-changes.json", "walkthrough.json"];
  try {
    for (const path of paths) bodies.set(path, await (await fetch(`${compared.url}${path}`)).text());
  } finally {
    await compared.stop();
  }
  const picker = await startCli([], f.user, env);
  try {
    const answer = await json(await fetch(`${picker.url}pull-requests.json`));
    expect(answer.status).toBe("ok");
    const picked = await fetch(`${picker.url}pull-request?number=7`, { method: "POST", headers: { origin: picker.url.replace(/\/$/, "") } });
    expect(picked.status).toBe(200);
    for (const path of paths) expect(await (await fetch(`${picker.url}${path}`)).text(), path).toBe(bodies.get(path));
    expect((await fetch(`${picker.url}observed.json`)).status).toBe(404);
  } finally {
    await picker.stop();
  }
  expect(worktrees(f.user)).toBe(listBefore);
}, 90000);

test("without gh on the PATH the picker says so in one line and the plain page serves", async () => {
  const f = fixture();
  const bare = temp("streets-pick-nogh-");
  const git = (await import("node:child_process")).execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const { symlinkSync } = await import("node:fs");
  symlinkSync(git, join(bare, "git"));
  const picker = await startCli([], f.user, { PATH: bare, XDG_CACHE_HOME: f.cache });
  try {
    const answer = await json(await fetch(`${picker.url}pull-requests.json`));
    expect(answer.status).toBe("unavailable");
    expect(String(answer.why)).toMatch(/^gh is not installed/);
    expect((await fetch(`${picker.url}graph.json`)).status).toBe(200);
  } finally {
    await picker.stop();
  }
}, 60000);
