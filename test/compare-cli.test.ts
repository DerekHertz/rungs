import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
