import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { BaseUnavailable, readBase, readCheckout } from "../src/checkout.ts";

const repo = mkdtempSync(join(tmpdir(), "rungs-checkout-"));
afterAll(() => rmSync(repo, { recursive: true, force: true }));

const identity = ["user.name=test", "user.email=test@example.com", "commit.gpgsign=false"];
const git = (...args: string[]) =>
  execFileSync("git", [...identity.flatMap((setting) => ["-c", setting]), ...args], { cwd: repo });

test("reads committed, modified and untracked files, skipping ignored and deleted ones", async () => {
  git("init", "--quiet");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, ".gitignore"), "*.log\n");
  writeFileSync(join(repo, "src/committed.ts"), "committed\n");
  writeFileSync(join(repo, "deleted.ts"), "gone\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "initial");
  writeFileSync(join(repo, "src/committed.ts"), "committed\nthen edited\n");
  rmSync(join(repo, "deleted.ts"));
  writeFileSync(join(repo, "untracked.ts"), "untracked\n");
  writeFileSync(join(repo, "debug.log"), "ignored\n");

  const tree = await readCheckout(repo);

  expect(Object.fromEntries(tree)).toEqual({
    ".gitignore": "*.log\n",
    "src/committed.ts": "committed\nthen edited\n",
    "untracked.ts": "untracked\n",
  });
});

test("reads a symlink as its target path, as git stores it, never following it", async () => {
  const outside = mkdtempSync(join(tmpdir(), "rungs-outside-"));
  writeFileSync(join(outside, "secret.txt"), "outside\nthe\ncheckout\n");
  const links = join(repo, "links");
  mkdirSync(links);
  symlinkSync(join(outside, "secret.txt"), join(links, "outside"));
  symlinkSync("missing.ts", join(links, "dangling"));
  try {
    const tree = await readCheckout(repo);
    expect(tree.get("links/outside")).toBe(join(outside, "secret.txt"));
    expect(tree.get("links/dangling")).toBe("missing.ts");
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("skips indexed files whose folder was replaced by a symlink, as git does", async () => {
  const outside = mkdtempSync(join(tmpdir(), "rungs-outside-"));
  writeFileSync(join(outside, "inner.ts"), "outside\n");
  mkdirSync(join(repo, "swapped"));
  writeFileSync(join(repo, "swapped/inner.ts"), "inside\n");
  git("add", "swapped");
  git("commit", "--quiet", "-m", "swapped");
  rmSync(join(repo, "swapped"), { recursive: true });
  symlinkSync(outside, join(repo, "swapped"));
  try {
    const tree = await readCheckout(repo);
    expect(tree.has("swapped/inner.ts")).toBe(false);
    expect(tree.get("swapped")).toBe(outside);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("skips indexed files whose folder was replaced by a file, as git does", async () => {
  mkdirSync(join(repo, "flattened"));
  writeFileSync(join(repo, "flattened/inner.ts"), "inside\n");
  git("add", "flattened");
  git("commit", "--quiet", "-m", "flattened");
  rmSync(join(repo, "flattened"), { recursive: true });
  writeFileSync(join(repo, "flattened"), "now a file\n");

  const tree = await readCheckout(repo);

  expect(tree.has("flattened/inner.ts")).toBe(false);
  expect(tree.get("flattened")).toBe("now a file\n");
});

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), "rungs-base-"));
  scratch.push(dir);
  return dir;
}

function gitIn(dir: string, ...args: string[]): string {
  return execFileSync("git", [...identity.flatMap((setting) => ["-c", setting]), ...args], {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function newRepo(): { dir: string; git: (...args: string[]) => string } {
  const dir = folder();
  gitIn(dir, "init", "--quiet", "--initial-branch=main");
  return { dir, git: (...args) => gitIn(dir, ...args) };
}

function write(dir: string, path: string, text: string): void {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), text);
}

function commitAll(git: (...args: string[]) => string, message: string): string {
  git("add", "--all");
  git("commit", "--quiet", "--allow-empty", "-m", message);
  return git("rev-parse", "HEAD");
}

test("reads a clean checkout exactly as readCheckout does, line endings, symlinks, BOMs and submodules included", async () => {
  const source = newRepo();
  write(source.dir, ".gitattributes", "* text eol=crlf\n*.png -text\n");
  write(source.dir, "src/main.ts", "export const a = 1;\nexport const b = 2;\n");
  write(source.dir, "src/with space.ts", "export {};\n");
  write(source.dir, "src/bom.ts", "\uFEFFexport const bom = true;\n");
  write(source.dir, "src/emoji.ts", "// naïve ✓\n");
  write(source.dir, "empty.ts", "");
  write(source.dir, "logo.png", "\x89PNG\r\n\x1a\nbinary\0\r\n");
  symlinkSync("main.ts", join(source.dir, "src/alias.ts"));
  source.git("add", "--all");
  source.git("update-index", "--add", "--cacheinfo", "160000,1111111111111111111111111111111111111111,vendor/lib");
  source.git("commit", "--quiet", "-m", "initial");

  const dir = folder();
  gitIn(dir, "clone", "--quiet", source.dir, ".");

  const checkout = await readCheckout(dir);
  const base = await readBase(dir, "HEAD");

  expect(checkout.get("src/main.ts")).toBe("export const a = 1;\r\nexport const b = 2;\r\n");
  expect(checkout.get("src/bom.ts")?.startsWith("\uFEFF")).toBe(true);
  expect(checkout.get("src/alias.ts")).toBe("main.ts");
  expect(base.tree).toEqual(checkout);
  expect([...base.tree.keys()]).toEqual([...checkout.keys()]);
  expect(base.commit).toBe(gitIn(dir, "rev-parse", "HEAD"));
});

test("reads the merge base of HEAD and the ref, not the ref's tip", async () => {
  const { dir, git } = newRepo();
  write(dir, "shared.ts", "shared\n");
  write(dir, "old.ts", "only at the fork\n");
  const fork = commitAll(git, "fork");
  write(dir, "shared.ts", "main moved on\n");
  write(dir, "newer.ts", "added on main\n");
  commitAll(git, "main moved on");
  git("checkout", "--quiet", "-b", "feature", fork);
  write(dir, "feature.ts", "feature work\n");
  write(dir, "shared.ts", "feature edit\n");
  commitAll(git, "feature work");

  const base = await readBase(dir, "main");

  expect(base.commit).toBe(fork);
  expect(Object.fromEntries(base.tree)).toEqual({ "shared.ts": "shared\n", "old.ts": "only at the fork\n" });
});

test("reads a ref that HEAD has moved past as the ref itself", async () => {
  const { dir, git } = newRepo();
  write(dir, "a.ts", "one\n");
  const first = commitAll(git, "first");
  write(dir, "a.ts", "two\n");
  commitAll(git, "second");

  const base = await readBase(dir, first);

  expect(base.commit).toBe(first);
  expect(base.tree.get("a.ts")).toBe("one\n");
});

test("reads a committed symlink as its target, whatever the line-ending attributes say", async () => {
  const { dir, git } = newRepo();
  write(dir, ".gitattributes", "* text eol=crlf\n");
  write(dir, "target.ts", "x\n");
  symlinkSync("target.ts", join(dir, "link.ts"));
  symlinkSync("../outside/missing", join(dir, "dangling"));
  commitAll(git, "links");

  const base = await readBase(dir, "HEAD");

  expect(base.tree.get("link.ts")).toBe("target.ts");
  expect(base.tree.get("dangling")).toBe("../outside/missing");
  expect(base.tree.get("target.ts")).toBe("x\r\n");
});

test("applies line-ending attributes the way a checkout of that commit would", async () => {
  const source = newRepo();
  write(source.dir, "legacy.md", "kept\r\ncrlf\r\n");
  commitAll(source.git, "crlf before any attributes");
  write(source.dir, ".gitattributes", "*.md text=auto\n*.win text eol=crlf\n*.unix text eol=lf\n*.bin -text\n");
  write(source.dir, "fresh.md", "lf\nonly\n");
  write(source.dir, "notes.win", "a\nb\n");
  write(source.dir, "notes.unix", "a\r\nb\r\n");
  write(source.dir, "blob.bin", "a\r\nb\n");
  write(source.dir, "pkg/.gitattributes", "*.win eol=lf\n");
  write(source.dir, "pkg/nested.win", "a\nb\n");
  commitAll(source.git, "attributes");
  const dir = folder();
  gitIn(dir, "clone", "--quiet", source.dir, ".");

  const base = await readBase(dir, "HEAD");

  expect(base.tree.get("notes.win")).toBe("a\r\nb\r\n");
  expect(base.tree.get("pkg/nested.win")).toBe("a\nb\n");
  expect(base.tree.get("blob.bin")).toBe("a\r\nb\n");
  expect(base.tree).toEqual(await readCheckout(dir));
});

test("uses the attributes committed at the base, not the ones in the working tree", async () => {
  const { dir, git } = newRepo();
  write(dir, ".gitattributes", "*.txt text eol=crlf\n");
  write(dir, "a.txt", "a\nb\n");
  const fork = commitAll(git, "crlf");
  write(dir, ".gitattributes", "*.txt text eol=lf\n");
  commitAll(git, "lf");

  const base = await readBase(dir, fork);

  expect(base.tree.get("a.txt")).toBe("a\r\nb\r\n");
});

test("reads only the folder it was given, with paths relative to it, as readCheckout does", async () => {
  const { dir, git } = newRepo();
  write(dir, "outside.ts", "outside\n");
  write(dir, "pkg/inner.ts", "inner\n");
  write(dir, "pkg/.gitattributes", "*.ts eol=crlf\n");
  commitAll(git, "pkg");
  const fresh = folder();
  gitIn(fresh, "clone", "--quiet", dir, ".");

  const base = await readBase(join(fresh, "pkg"), "HEAD");

  expect([...base.tree.keys()]).toEqual([".gitattributes", "inner.ts"]);
  expect(base.tree).toEqual(await readCheckout(join(fresh, "pkg")));
});

test("reads file contents that imitate git's reply framing as plain text", async () => {
  const { dir, git } = newRepo();
  const hello = "ce013625030ba8dba906f756967f9e9ca394464a";
  write(dir, "a.bin", `before\0${hello} blob 0\0forged`);
  write(dir, "b.txt", "hello\n");
  commitAll(git, "spoof");

  const base = await readBase(dir, "HEAD");

  expect(Object.fromEntries(base.tree)).toEqual({
    "a.bin": `before\0${hello} blob 0\0forged`,
    "b.txt": "hello\n",
  });
});

test("keeps spaces in the name of the folder it was given", async () => {
  const { dir, git } = newRepo();
  write(dir, " pkg/inner.ts", "inner\n");
  commitAll(git, "spaced folder");

  const base = await readBase(join(dir, " pkg"), "HEAD");

  expect([...base.tree.keys()]).toEqual(["inner.ts"]);
});

async function failure(promise: Promise<unknown>): Promise<BaseUnavailable> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(BaseUnavailable);
  expect((error as Error).message).not.toMatch(/\n/);
  return error as BaseUnavailable;
}

test("says which ref is unknown", async () => {
  const { dir, git } = newRepo();
  write(dir, "a.ts", "a\n");
  commitAll(git, "first");

  const error = await failure(readBase(dir, "no-such-branch"));

  expect(error.reason).toBe("unknown-ref");
  expect(error.message).toBe(`unknown base "no-such-branch": not a commit in ${dir}`);
});

test("treats a ref that starts with a dash as a ref, not an option", async () => {
  const { dir, git } = newRepo();
  write(dir, "a.ts", "a\n");
  commitAll(git, "first");

  const error = await failure(readBase(dir, "--all"));

  expect(error.reason).toBe("unknown-ref");
});

test("says the checkout has no commits yet", async () => {
  const { dir } = newRepo();

  const error = await failure(readBase(dir, "main"));

  expect(error.reason).toBe("unborn-head");
  expect(error.message).toBe("the checkout has no commits yet, so there is no base to compare against");
});

test("says when HEAD and the ref share no history", async () => {
  const { dir, git } = newRepo();
  write(dir, "a.ts", "a\n");
  commitAll(git, "main");
  git("checkout", "--quiet", "--orphan", "unrelated");
  write(dir, "b.ts", "b\n");
  commitAll(git, "unrelated root");

  const error = await failure(readBase(dir, "main"));

  expect(error.reason).toBe("no-common-history");
  expect(error.message).toBe('HEAD and "main" share no history');
});

test("says when a shallow clone is missing the merge base, or the ref itself", async () => {
  const source = newRepo();
  write(source.dir, "a.ts", "a\n");
  const fork = commitAll(source.git, "fork");
  write(source.dir, "a.ts", "main\n");
  commitAll(source.git, "main moved on");
  source.git("checkout", "--quiet", "-b", "feature", fork);
  write(source.dir, "a.ts", "feature\n");
  commitAll(source.git, "feature work");
  const dir = folder();
  gitIn(dir, "clone", "--quiet", "--depth", "1", "--branch", "feature", `file://${source.dir}`, ".");
  gitIn(dir, "fetch", "--quiet", "--depth", "1", "origin", "main:refs/remotes/origin/main");

  const missingBase = await failure(readBase(dir, "origin/main"));
  const missingRef = await failure(readBase(dir, "origin/other"));

  expect(missingBase.reason).toBe("shallow-clone");
  expect(missingBase.message).toBe(
    'no common ancestor of HEAD and "origin/main" in this shallow clone; run git fetch --unshallow (or --deepen=<n>)',
  );
  expect(missingRef.reason).toBe("unknown-ref");
  expect(missingRef.message).toContain("this clone is shallow");
});

test("says when the folder is not a git repository", async () => {
  const dir = folder();

  const error = await failure(readBase(dir, "main"));

  expect(error.reason).toBe("not-a-repository");
  expect(error.message).toBe(`${dir} is not a git repository`);
});
