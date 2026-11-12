import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, expect, test } from "vitest";
import { termsLine } from "../src/file-card.ts";
import type { VocabularyDoc } from "../src/file-card.ts";
import type { AgentRunner } from "../src/link.ts";
import { parseOptions } from "../src/options.ts";
import { setUp } from "../src/setup.ts";
import { vocabularyCommand } from "../src/vocabulary-command.ts";

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});
const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
};

test("--propose belongs to setup, and only setup", () => {
  expect(parseOptions(["setup", "--propose"])).toMatchObject({ setup: true, propose: true });
  expect(parseOptions(["setup"])).not.toHaveProperty("propose");
  expect(parseOptions(["setup", "--judge", "--propose"])).toMatchObject({ judge: true, propose: true });
  expect(parseOptions(["compare", "main", "--propose"])).toBe("--propose needs setup: streets setup --propose");
  expect(parseOptions(["--propose"])).toBe("--propose needs setup: streets setup --propose");
  expect(parseOptions(["setup", "dir"])).toMatchObject({ dir: resolve("dir") });
});

const doc = (over: Partial<VocabularyDoc>): VocabularyDoc => ({ tier: "derived", state: "stored", judged: true, terms: [], withheldPaths: 0, files: [], ...over });
const units = { total: 1, withTerm: 1, notJudged: 0, stale: 0, noTerm: 0, noCandidate: 0 };

test("a claimed term is a claimed chip with the words that say so, and the vocabulary says how many are proposed", () => {
  const line = termsLine(doc({ proposed: { count: 2, model: "claude-sonnet-x" }, certification: { kind: "drafted" } }), { path: "a.js", terms: [{ key: "x", name: "Dates", probability: 0.97, claimed: true }, { key: "y", name: "Bills", probability: 0.95 }], units, members: [] });
  expect(line.chips).toEqual([{ key: "x", name: "Dates", text: "Dates 97% (claimed term)", claimed: true }, { key: "y", name: "Bills", text: "Bills 95%" }]);
  expect(line.note).toContain("2 terms are proposed by claude-sonnet-x (claimed), not written in the repository");
  expect(line.note).toContain("vocabulary drafted: nobody has certified it");
});

test("streets vocabulary list says which terms a model proposed, and certify says it vouches for them", async () => {
  const dir = temp("streets-psurface-");
  const git = (...args: string[]): string => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  git("init", "--quiet", "--initial-branch=main");
  for (const name of ["multiply", "total", "isoDay", "slugify", "toCsv"]) {
    mkdirSync(dirname(join(dir, `lib/${name}.js`)), { recursive: true });
    writeFileSync(join(dir, `lib/${name}.js`), `export function ${name}(a) {\n  return a;\n}\n`);
  }
  git("add", "--all");
  git("commit", "--quiet", "-m", "base");
  const cacheDir = temp("streets-cache-");
  const ask: AgentRunner = { run: () => Promise.resolve({ output: { terms: [{ name: "Date arithmetic", description: "Days between dates.", files: ["lib/isoDay.js"] }] }, model: "claude-sonnet-x", usd: 0.01 }) };
  await setUp({ dir, cacheDir, propose: ask, deps: { kindChoice: { asked: [], notJudged: [] } } });
  const listed = await vocabularyCommand(["list", "--dir", dir], { cacheDir });
  expect(listed.out.join("\n")).toContain("1 of them proposed by claude-sonnet-x (claimed)");
  expect(listed.out.join("\n")).toContain("Date arithmetic (dat arithmetic): proposed by a model (claimed)");
  const certified = await vocabularyCommand(["certify", "--dir", dir, "--by", "Dana"], { cacheDir });
  expect(certified.out.join("\n")).toContain("1 proposed by a model, claimed, now vouched for by you");
});
