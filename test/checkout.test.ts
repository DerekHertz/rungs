import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { readCheckout } from "../src/checkout.ts";

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
