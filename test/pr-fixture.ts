import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { systemRunners } from "../src/pull-request.ts";
import type { Runners } from "../src/pull-request.ts";

const scratch: string[] = [];
/** Removes every temp directory `temp` made; call from afterAll. */
export function cleanup(): void {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
}

const identity = ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"];
export function git(dir: string, ...args: string[]): string {
  return execFileSync("git", [...identity, ...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}
export function write(dir: string, path: string, text: string): void {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), text);
}
export const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
};

export interface Fixture {
  readonly user: string;
  readonly origin: string;
  readonly cache: string;
  readonly head: string;
  readonly baseTip: string;
  /** Main's commit when the PR branched. */
  readonly origBase: string;
}

/** A bare origin holding main and a fake pull/7/head ref; a clone of it with a dirty tree, a branch and a stash. */
export function fixture(hook?: string): Fixture {
  const origin = temp("streets-pr-origin-");
  git(origin, "init", "--quiet", "--bare", "--initial-branch=main");
  const seed = temp("streets-pr-seed-");
  git(seed, "init", "--quiet", "--initial-branch=main");
  write(seed, "src/a.ts", "export function a() {\n  return 1;\n}\n");
  write(seed, "src/b.ts", "export function b() {\n  return 2;\n}\n");
  git(seed, "add", "--all");
  git(seed, "commit", "--quiet", "-m", "base");
  const origBase = git(seed, "rev-parse", "HEAD");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "--quiet", "origin", "main");
  git(seed, "checkout", "--quiet", "-b", "feature");
  write(seed, "src/a.ts", "export function a() {\n  return 100;\n}\n");
  write(seed, "src/added.ts", "export const added = () => 4;\n");
  if (hook !== undefined) {
    write(seed, ".githooks/post-checkout", hook);
    chmodSync(join(seed, ".githooks/post-checkout"), 0o755);
  }
  git(seed, "add", "--all");
  git(seed, "commit", "--quiet", "-m", "the change");
  const head = git(seed, "rev-parse", "HEAD");
  git(seed, "push", "--quiet", "origin", "feature:refs/pull/7/head");
  // main moves on after the PR branched: the comparison is from the merge base, not from this tip.
  git(seed, "checkout", "--quiet", "main");
  write(seed, "src/later.ts", "export const later = 1;\n");
  git(seed, "add", "--all");
  git(seed, "commit", "--quiet", "-m", "main moves on");
  git(seed, "push", "--quiet", "origin", "main");
  const baseTip = git(seed, "rev-parse", "HEAD");

  const user = temp("streets-pr-user-");
  rmSync(user, { recursive: true });
  execFileSync("git", ["clone", "--quiet", origin, user]);
  git(user, "checkout", "--quiet", "-b", "mine");
  write(user, "src/b.ts", "export function b() {\n  return 20;\n}\n");
  git(user, "stash", "push", "--quiet", "-m", "keep");
  write(user, "src/a.ts", "export function a() {\n  return 11;\n}\n");
  write(user, "untracked.txt", "mine\n");
  return { user, origin, cache: temp("streets-pr-cache-"), head, baseTip, origBase };
}

/** What a user would notice changing: the status, the head, the branch, the stash, every tracked and untracked byte. */
export function snapshot(dir: string): string {
  return [git(dir, "status", "--porcelain=v2", "--branch"), git(dir, "rev-parse", "HEAD"), git(dir, "stash", "list"), git(dir, "diff", "HEAD"), git(dir, "branch", "--list")].join("\n--\n");
}

export const view = (f: Fixture, over: Record<string, unknown> = {}): string =>
  JSON.stringify({ number: 7, title: "Change a", url: `file://${f.origin}/pull/7`, headRefOid: f.head, baseRefName: "main", body: "## Claims\n\n- a returns 100\n", state: "OPEN", ...over });
export const runners = (ghOut: string | Error): Runners => ({
  git: systemRunners.git,
  gh: async () => {
    if (ghOut instanceof Error) throw ghOut;
    return ghOut;
  },
});
export const failure = (stderr: string, code: number | string = 1): Error => Object.assign(new Error(`failed: ${stderr}`), { stderr, code });
export const worktrees = (dir: string): string => git(dir, "worktree", "list", "--porcelain");
