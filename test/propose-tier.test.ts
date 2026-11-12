import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { compare } from "../src/compare.ts";
import type { Correction } from "../src/corrections.ts";
import { extract } from "../src/extract/extract.ts";
import type { FileTree, NodeId } from "../src/graph.ts";
import { HARM_CATALOGUE } from "../src/harm-catalogue.ts";
import { jevCost } from "../src/jev/client.ts";
import type { JevClient, JevRequest, JevResponse } from "../src/jev/client.ts";
import type { AgentRunner } from "../src/link.ts";
import { setUp } from "../src/setup.ts";
import type { StoredVocabulary } from "../src/setup.ts";
import type { KindChoice } from "../src/stakes.ts";
import { tierPicker } from "../src/tier-facts.ts";
import type { Tiering } from "../src/tier-facts.ts";
import { DEFAULT_TIERS } from "../src/tier-table.ts";
import { keyOf } from "../src/vocabulary.ts";

/*
 * A proposed term is a term to the tier: its stakes are judged like any other's, and merged with a
 * term the repository wrote it carries the worst of both.
 */

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});
const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
};
const identity = ["user.name=t", "user.email=t@example.com", "commit.gpgsign=false"];
const git = (dir: string, ...args: string[]): string => execFileSync("git", [...identity.flatMap((s) => ["-c", s]), ...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const fn = (name: string): string => `export function ${name}(a) {\n  return a;\n}\n`;
const files: Record<string, string> = {
  "package.json": '{\n  "name": "zq"\n}\n',
  "README.md": "# zq\n",
  "lib/k1.js": fn("multiply"),
  "lib/k2.js": fn("total"),
  "lib/k3.js": fn("isoDay") + fn("daysBetween"),
  "lib/k4.js": fn("slugify"),
  "lib/k5.js": fn("toCsv") + fn("fromCsv"),
};
const baseTree: FileTree = new Map(Object.entries(files));
const stamp = { by: "Dana", at: "2026-11-12T10:00:00.000Z" };
const every: KindChoice = { asked: HARM_CATALOGUE.filter((kind) => kind.answer === "judgement").map((kind) => kind.id), notJudged: [] };
const usage = { inputTokens: 100, outputTokens: 3, usd: jevCost(100) };
const dateKey = keyOf("Date arithmetic");
const csvKey = keyOf("csv");

const proposing: AgentRunner = { run: () => Promise.resolve({ output: { terms: [{ name: "Date arithmetic", description: "Days between dates.", files: ["lib/k3.js"] }] }, model: "claude-sonnet-x", usd: 0.01 }) };
/** Date arithmetic could cause harm in money; every code is a member of what it is shown; everything else is a confident no. */
const jev: JevClient = {
  model: "fake-1",
  async ask(request: JevRequest): Promise<JevResponse> {
    const term = /^Term: (.*)$/m.exec(request.state.term ?? "")?.[1] ?? "?";
    if (request.questions.belongs !== undefined) return { answers: { belongs: { type: "yes-no", yes: 0.97 }, incidental: { type: "yes-no", yes: 0.02 } }, usage, model: "fake-1" };
    const kind = /kind of harm: (.*)\?/.exec(request.questions.harm?.instructions ?? "")?.[1] ?? "?";
    return { answers: { harm: { type: "yes-no", yes: term === "Date arithmetic" && kind === "money" ? 0.97 : 0.03 } }, usage, model: "fake-1" };
  },
};

let made: StoredVocabulary | undefined;
async function stored(): Promise<StoredVocabulary> {
  if (made !== undefined) return made;
  const dir = temp("streets-ptier-");
  git(dir, "init", "--quiet", "--initial-branch=main");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  git(dir, "add", "--all");
  git(dir, "commit", "--quiet", "-m", "base");
  return (made = (await setUp({ dir, cacheDir: temp("streets-cache-"), judge: jev, propose: proposing, deps: { kindChoice: every } })).stored);
}

const tieringWith = async (corrections: Correction[]): Promise<Tiering> => ({ table: DEFAULT_TIERS, vocabulary: { status: "ok", stored: { ...(await stored()), corrections }, choice: every } });
function pick(tiering: Tiering, edits: Record<string, string>, path: string) {
  const head: FileTree = new Map([...baseTree, ...Object.entries(edits)]);
  const baseGraph = extract(baseTree);
  const graph = extract(head);
  return tierPicker({ tiering, comparison: compare(baseGraph, graph, { base: baseTree, head }), baseGraph, graph, baseTree, tree: head })({ ids: [`file:${path}` as NodeId] });
}
const stakesWhy = (why: readonly string[]): string => why.find((reason) => reason.startsWith("stakes:")) ?? "";
const editDays = { "lib/k3.js": "export function isoDay(a) {\n  return a + 1;\n}\n" + fn("daysBetween") };
const editCsv = { "lib/k5.js": "export function toCsv(a) {\n  return a + 1;\n}\n" + fn("fromCsv") };

test("the stakes of a proposed term are judged, and its functions carry them", async () => {
  expect((await stored()).stakes!.terms.some((term) => term.key === dateKey && term.members > 0)).toBe(true);
  const found = pick(await tieringWith([]), editDays, "lib/k3.js");
  expect(found.percent).toBe(99.9);
  expect(stakesWhy(found.why)).toMatch(/could cause harm in money in Date arithmetic/);
});

test("merged into a term the repository wrote, a proposed term lends its harm to that term, and the merged term keeps the name it has", async () => {
  const merge: Correction = { ...stamp, kind: "merge", term: dateKey, into: csvKey, label: "Date arithmetic into csv" };
  const found = pick(await tieringWith([merge]), editCsv, "lib/k5.js");
  expect(found.percent).toBe(99.9);
  expect(stakesWhy(found.why)).toMatch(/could cause harm in money in fromCsv/);
});

test("a person's removal of a proposed term takes its harm away", async () => {
  const found = pick(await tieringWith([{ ...stamp, kind: "remove", term: dateKey, label: "Date arithmetic" }]), editDays, "lib/k3.js");
  expect(stakesWhy(found.why)).not.toMatch(/could cause harm/);
  expect(stakesWhy(found.why)).not.toMatch(/Date arithmetic/);
});
