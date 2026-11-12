import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { compare, contractsMoved } from "../src/compare.ts";
import { extract } from "../src/extract/extract.ts";
import type { FileTree } from "../src/graph.ts";
import { ownersOf } from "../src/jev/claim-source.ts";
import type { JevAnswer, JevResponse } from "../src/jev/client.ts";
import { jevCost } from "../src/jev/client.ts";
import { MAX_HUNK_LINES, MAX_RULE_CHARS, standardGate } from "../src/jev/standard-gate.ts";
import { MAX_PAIRS, hunksOf, ruleScope, standardItems, standardRunner } from "../src/jev/standard-source.ts";
import type { JudgeSubject } from "../src/jev/subject.ts";
import { judgedSource } from "../src/jev/source.ts";
import { judgedDocument } from "../src/jev/store.ts";
import { collectStandards } from "../src/standards.ts";
import { fakeClient } from "./jev-fixtures.ts";
import type { JevClient } from "../src/jev/client.ts";

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const lines = (count: number, make: (index: number) => string): string => `${Array.from({ length: count }, (_, index) => make(index + 1)).join("\n")}\n`;

test("hunks: changes close together are one hunk with three lines of context, far apart ones are two", () => {
  const before = lines(30, (n) => `line ${n}`);
  const after = before.replace("line 5\n", "five\n").replace("line 7\n", "seven\n").replace("line 25\n", "twenty-five\n");
  const hunks = hunksOf(before, after);
  if ("skipped" in hunks) throw new Error(hunks.skipped);
  expect(hunks).toHaveLength(2);
  expect(hunks[0]).toMatchObject({ base: { start: 2, end: 10 }, head: { start: 2, end: 10 } });
  expect(hunks[0]!.before).toContain("-5: line 5");
  expect(hunks[0]!.before).toContain(" 4: line 4");
  expect(hunks[0]!.after).toContain("+5: five");
  expect(hunks[0]!.after).not.toContain("-5: line 5");
  expect(hunks[1]).toMatchObject({ base: { start: 22, end: 28 } });
});

test("hunks: a new file has no base side, a removed file no head side, an unchanged file no hunk", () => {
  const added = hunksOf("", "a\nb\n");
  const removed = hunksOf("a\nb\n", "");
  if ("skipped" in added || "skipped" in removed) throw new Error("skipped");
  expect(added).toHaveLength(1);
  expect(added[0]).toMatchObject({ base: null, head: { start: 1, end: 2 }, before: [], after: ["+1: a", "+2: b"] });
  expect(removed[0]).toMatchObject({ head: null, base: { start: 1, end: 2 }, after: [], before: ["-1: a", "-2: b"] });
  expect(hunksOf("same\n", "same\n")).toEqual([]);
});

test("hunks: a long run of changed lines is split, so no hunk is cut and none is silently left out", () => {
  const hunks = hunksOf("", lines(100, (n) => `row ${n}`));
  if ("skipped" in hunks) throw new Error(hunks.skipped);
  expect(hunks.length).toBeGreaterThan(1);
  const covered = hunks.flatMap((hunk) => hunk.after.filter((line) => line.startsWith("+")));
  expect(covered).toHaveLength(100);
  expect(new Set(covered).size).toBe(100);
  expect(MAX_PAIRS).toBe(300);
});

test("hunks: a replacement longer than a chunk is split with its base lines kept in each part; no part is a pure addition", () => {
  const hunks = hunksOf(lines(100, (n) => `old ${n}`), lines(100, (n) => `new ${n}`));
  if ("skipped" in hunks) throw new Error(hunks.skipped);
  expect(hunks.length).toBeGreaterThan(1);
  for (const hunk of hunks) {
    expect(hunk.base).not.toBeNull();
    expect(hunk.head).not.toBeNull();
    expect(hunk.before.length).toBeGreaterThan(0);
    expect(hunk.after.length).toBeGreaterThan(0);
    expect(hunk.part?.of).toBe(hunks.length);
  }
  expect(hunks.flatMap((hunk) => hunk.before.filter((line) => line.startsWith("-")))).toHaveLength(100);
  expect(hunks.flatMap((hunk) => hunk.after.filter((line) => line.startsWith("+")))).toHaveLength(100);
  expect(hunks.map((hunk) => hunk.part?.number)).toEqual(hunks.map((_, index) => index + 1));
});

test("hunks: a stretch with a change every few lines is bounded by what is shown, so a change deep in it is never left out", () => {
  const before = lines(140, (n) => `call${n}();`);
  const after = lines(140, (n) => (n % 7 === 0 ? `forbidden${n}();` : `call${n}();`));
  const hunks = hunksOf(before, after);
  if ("skipped" in hunks) throw new Error(hunks.skipped);
  expect(hunks.length).toBeGreaterThan(1);
  for (const hunk of hunks) {
    expect(hunk.before.length).toBeLessThanOrEqual(MAX_HUNK_LINES);
    expect(hunk.after.length).toBeLessThanOrEqual(MAX_HUNK_LINES);
  }
  const added = hunks.flatMap((hunk) => hunk.after.filter((line) => line.startsWith("+")));
  expect(added).toHaveLength(20);
  expect(added).toContain("+133: forbidden133();");
  // Each changed line is in exactly one hunk.
  expect(new Set(added).size).toBe(20);
});

test("hunks: a line of source is clipped, and a secret-shaped literal or a URL path is withheld before it goes anywhere", () => {
  const hunks = hunksOf("", `const key = "sk-live-abcdefghijklmnopqrstuvwxyz0123456789";\nfetch("https://api.example.com/v1/users/42?token=abc");\n${"x".repeat(500)}\n`);
  if ("skipped" in hunks) throw new Error(hunks.skipped);
  const text = hunks[0]!.after.join("\n");
  expect(text).not.toContain("sk-live-abcdefghijklmnopqrstuvwxyz0123456789");
  expect(text).toContain("withheld");
  expect(text).not.toContain("/v1/users/42");
  expect(text).toContain("https://api.example.com");
  expect(hunks[0]!.after[2]!.length).toBeLessThan(260);
});

test("hunks: a binary file or one too large to diff is skipped with its reason, never judged as empty", () => {
  expect(hunksOf("a\n", "a\u0000b\n")).toEqual({ skipped: "binary file" });
  // The diff gives up, rather than guess, when matching lines cannot be placed (see test/diff.test.ts).
  const big = hunksOf(lines(6000, (n) => (n % 2 === 1 ? "x" : `a${n}`)), lines(6000, (n) => (n % 2 === 1 ? "x" : `b${n}`)));
  expect(big).toEqual({ skipped: "too large to diff" });
});

test("scope: a nested AGENTS.md or CLAUDE.md applies to its own folder; every other rule file to the whole repository", () => {
  expect(ruleScope("AGENTS.md")).toBe("");
  expect(ruleScope("packages/api/AGENTS.md")).toBe("packages/api");
  expect(ruleScope("packages/api/claude.md")).toBe("packages/api");
  // Only the root-level .claude/ and .github/ speak for the whole repository; below the root a rule's scope is its own folder, whatever it is called.
  expect(ruleScope(".claude/CLAUDE.md")).toBe("");
  expect(ruleScope(".github/AGENTS.md")).toBe("");
  expect(ruleScope("api/.github/AGENTS.md")).toBe("api/.github");
  expect(ruleScope("packages/api/.claude/CLAUDE.md")).toBe("packages/api/.claude");
  expect(ruleScope(".claude/rules/naming.md")).toBe("");
  expect(ruleScope(".github/copilot-instructions.md")).toBe("");
  expect(ruleScope("docs/CONTRIBUTING.md")).toBe("");
  expect(ruleScope("docs/style-guide.md")).toBe("");
});

const rules = ["# Project", "Intro.", "", "## Tests", "Write the red test first.", "", "## Naming", "Name things plainly."].join("\n") + "\n";
const baseTree: FileTree = new Map([
  ["package.json", "{}\n"],
  ["AGENTS.md", rules],
  ["api/AGENTS.md", "# API\nNever call the network from a handler.\n"],
  ["src/a.ts", "export function a(x: number) {\n  return x;\n}\n"],
  ["api/b.ts", "export function b() {\n  return 1;\n}\n"],
]);
const headTree: FileTree = new Map([
  ["package.json", "{}\n"],
  ["AGENTS.md", rules],
  ["api/AGENTS.md", "# API\nNever call the network from a handler.\n"],
  ["src/a.ts", "export function a(x: number) {\n  return x + 1;\n}\n"],
  ["api/b.ts", "export function b() {\n  return fetch('/x');\n}\n"],
]);

function subjectOf(trees: { base: FileTree; head: FileTree } = { base: baseTree, head: headTree }): JudgeSubject {
  const baseGraph = extract(trees.base);
  const graph = extract(trees.head);
  const comparison = compare(baseGraph, graph, { base: trees.base, head: trees.head });
  return {
    comparison,
    contracts: contractsMoved(comparison, baseGraph, graph),
    claims: [],
    baseTree: trees.base,
    headTree: trees.head,
    head: ownersOf(graph),
    base: ownersOf(baseGraph),
    standards: collectStandards({ graph: baseGraph, tree: trees.base }, trees.head),
  };
}

test("items: one per changed hunk and rule in scope; a nested rule file applies only to its own subtree", () => {
  const { items, skipped } = standardItems(subjectOf());
  expect(skipped).toEqual([]);
  const pairs = items.map((item) => [item.input.hunk.path, item.input.rule.path, item.input.rule.heading]);
  expect(pairs).toEqual([
    ["api/b.ts", "AGENTS.md", "Project"],
    ["api/b.ts", "AGENTS.md", "Tests"],
    ["api/b.ts", "AGENTS.md", "Naming"],
    ["api/b.ts", "api/AGENTS.md", "API"],
    ["src/a.ts", "AGENTS.md", "Project"],
    ["src/a.ts", "AGENTS.md", "Tests"],
    ["src/a.ts", "AGENTS.md", "Naming"],
  ]);
  // The intro prose is listed as a rule here (every section is one); the judged question decides whether it is.
  expect(items[0]!.input.rule.scope).toBe("");
  expect(items[3]!.input.rule.scope).toBe("api");
});

test("an item attaches to the hunk's file node and names its rule and hunk; its key is unique", () => {
  const { items } = standardItems(subjectOf());
  const item = items[0]!;
  expect(item.about).toMatchObject({ nodes: ["file:api/b.ts"], standard: { rule: { path: "AGENTS.md", heading: "Project", lines: { start: 1, end: 3 } }, hunk: { path: "api/b.ts" } } });
  expect(new Set(items.map((one) => one.key)).size).toBe(items.length);
  expect(item.input.hunk.before.join("\n")).toContain("-2:   return 1;");
  expect(item.input.hunk.after.join("\n")).toContain("+2:   return fetch('/x');");
});

test("a rule file the change edited is marked and its rule is the base's, never the head's", () => {
  const edited = new Map(headTree);
  edited.set("AGENTS.md", rules.replace("Write the red test first.", "Tests are optional."));
  const { items } = standardItems(subjectOf({ base: baseTree, head: edited }));
  const tests = items.find((item) => item.input.rule.heading === "Tests" && item.input.hunk.path === "src/a.ts")!;
  expect(tests.input.rule.edited).toBe(true);
  expect(tests.input.rule.text).toContain("Write the red test first.");
  expect(tests.input.rule.text).not.toContain("optional");
  expect(JSON.stringify(standardGate.state(tests.input))).not.toContain("optional");
});

test("a long rule is cut and says how much, and a secret-shaped literal or a URL path in the rule is withheld", () => {
  const long = new Map(baseTree);
  long.set("AGENTS.md", `# Rules\n${"Be careful. ".repeat(900)}\nSee https://internal.example.com/secret/path and key ghp_abcdefghijklmnopqrstuvwxyz0123456789.\n`);
  const head = new Map(headTree);
  head.set("AGENTS.md", long.get("AGENTS.md")!);
  const { items } = standardItems(subjectOf({ base: long, head }));
  const rule = items.find((item) => item.input.rule.path === "AGENTS.md" && item.input.hunk.path === "src/a.ts")!.input.rule;
  expect(rule.text.length).toBeLessThanOrEqual(MAX_RULE_CHARS);
  expect(rule.cutChars).toBeGreaterThan(0);
  expect(JSON.stringify(rule)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  expect(JSON.stringify(rule)).not.toContain("/secret/path");
  const wrapped = new Map(baseTree);
  wrapped.set("AGENTS.md", "# Rules\nSee https://internal.example.com/secret/path and key ghp_abcdefghijklmnopqrstuvwxyz0123456789.\n");
  const short = standardItems(subjectOf({ base: wrapped, head: new Map(headTree).set("AGENTS.md", wrapped.get("AGENTS.md")!) })).items[0]!.input.rule;
  expect(short.cutChars).toBe(0);
  expect(short.text).toContain("https://internal.example.com");
  expect(short.text).not.toContain("/secret/path");
  expect(short.text).not.toContain("ghp_");
});

test("no written rules, or rules that could not be read, give nothing to ask and never a settled mark", () => {
  const none = new Map([...baseTree].filter(([path]) => !path.endsWith("AGENTS.md")));
  const noRules = standardItems(subjectOf({ base: none, head: new Map([...headTree].filter(([path]) => !path.endsWith("AGENTS.md"))) }));
  expect(noRules.items).toEqual([]);
  const unknown = { ...subjectOf(), standards: collectStandards(undefined) };
  expect(standardItems(unknown)).toEqual({ items: [], skipped: [] });
});

test("a changed file that cannot be read as lines is listed as not judged, with why", () => {
  const head = new Map(headTree);
  head.set("src/blob.bin", "a\u0000b\n");
  const base = new Map(baseTree);
  base.set("src/blob.bin", "a\n");
  const { skipped } = standardItems(subjectOf({ base, head }));
  expect(skipped).toHaveLength(1);
  expect(skipped[0]).toMatchObject({ status: "not judged", about: { nodes: ["file:src/blob.bin"] } });
  expect(skipped[0]!.status === "not judged" && skipped[0]!.reason).toMatch(/binary file/);
});

test("pairs over the cap are not asked, and each says so", () => {
  const head = new Map(headTree);
  for (let n = 0; n < 120; n++) head.set(`gen/f${n}.ts`, lines(3, (row) => `export const v${row} = ${n};`));
  const { items, skipped } = standardItems(subjectOf({ base: baseTree, head }));
  expect(items.length).toBeLessThanOrEqual(300);
  expect(skipped.length).toBeGreaterThan(0);
  expect(skipped.every((one) => one.status === "not judged" && /over the cap of 300/.test(one.reason))).toBe(true);
  expect(items.length + skipped.length).toBe(7 + 120 * 3);
});

const answer = (breaks: number, before: number): JevResponse => ({
  answers: { breaks: { type: "yes-no", yes: breaks } satisfies JevAnswer, before: { type: "yes-no", yes: before } satisfies JevAnswer },
  usage: { inputTokens: 100, outputTokens: 3, usd: jevCost(100) },
  model: "fake-1",
});

test("the runner judges each pair once per comparison: records carry the rule and hunk, and a second load asks nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "streets-standard-"));
  scratch.push(dir);
  const client: JevClient & { requests: unknown[] } = fakeClient((request) => answer(/fetch/.test(request.state["after the change (head)"] ?? "") && /Never call the network/.test(request.state.rule ?? "") ? 0.95 : 0.02, 0.01));
  const subject = subjectOf();
  const source = () => judgedSource({ judge: true, env: {}, baseTree, headTree, cacheDir: dir, client, runners: [standardRunner] });
  const first = await judgedDocument(source(), subject);
  expect(first.status).toBe("on");
  const records = first.sets[0]!.records;
  expect(first.sets[0]!.question).toEqual({ id: "standard", version: "standard-v2" });
  expect(records).toHaveLength(7);
  const flagged = records.filter((record) => record.verdict === "flagged");
  expect(flagged).toHaveLength(1);
  expect(flagged[0]!.about).toMatchObject({ standard: { rule: { path: "api/AGENTS.md" }, hunk: { path: "api/b.ts" } } });
  expect(records.filter((record) => record.verdict === "settled")).toHaveLength(6);
  const calls = client.requests.length;
  expect(calls).toBe(7);
  const second = await judgedDocument(source(), subject);
  expect(client.requests.length).toBe(calls);
  expect(second.sets[0]!.records).toEqual(records);
});

test("an AGENTS.md inside a nested .github folder applies to that folder only, not to its parent's other files", () => {
  const base = new Map(baseTree);
  base.set("api/.github/AGENTS.md", "# Nested\nNo console in here.\n");
  const head = new Map(headTree);
  head.set("api/.github/AGENTS.md", "# Nested\nNo console in here.\n");
  head.set("api/server.ts", "export const s = 1;\n");
  const { items } = standardItems(subjectOf({ base, head }));
  const nested = items.filter((item) => item.input.rule.path === "api/.github/AGENTS.md");
  expect(nested.map((item) => item.input.hunk.path)).toEqual([]);
  expect(items.some((item) => item.input.rule.path === "api/AGENTS.md" && item.input.hunk.path === "api/server.ts")).toBe(true);
});

test("a path with a secret-shaped segment is withheld in the hunk's path and label, the rule's path and its scope", () => {
  const secret = "ghp_16C7e42F292c6912E7710c838347Ae178B4a";
  const base = new Map(baseTree);
  const head = new Map(headTree);
  base.set(`${secret}/AGENTS.md`, "# Folder\nBe kind.\n");
  head.set(`${secret}/AGENTS.md`, "# Folder\nBe kind.\n");
  base.set(`${secret}/a.ts`, "export const a = 1;\n");
  head.set(`${secret}/a.ts`, "export const a = 2;\n");
  const { items } = standardItems(subjectOf({ base, head }));
  const mine = items.filter((item) => item.input.rule.path.includes("AGENTS.md") && item.input.hunk.path.endsWith("a.ts") && item.input.rule.scope !== "");
  expect(mine).toHaveLength(1);
  const shown = JSON.stringify([mine[0]!.input, standardGate.state(mine[0]!.input)]);
  expect(shown).not.toContain(secret);
  expect(shown).toContain("withheld");
  // Every other path is as it was.
  expect(items.some((item) => item.input.hunk.path === "src/a.ts")).toBe(true);
});

test("pairs over the cap are published as not judged when the run is planned, so the page shows them while it judges", async () => {
  const dir = mkdtempSync(join(tmpdir(), "streets-standard-"));
  scratch.push(dir);
  const head = new Map(headTree);
  for (let n = 0; n < 120; n++) head.set(`gen/f${n}.ts`, lines(3, (row) => `export const v${row} = ${n};`));
  const subject = subjectOf({ base: baseTree, head });
  const planned: { known: number; pending: number; notJudged: number }[] = [];
  const outcomes: string[] = [];
  const client = fakeClient(() => answer(0.02, 0.01));
  await standardRunner({
    client,
    cacheDir: dir,
    base: "b",
    head: "h",
    baseTree,
    headTree: head,
    subject,
    events: {
      plan: (_set, known, pending) => planned.push({ known: known.length, pending: pending.length, notJudged: known.filter((outcome) => outcome.status === "not judged").length }),
      outcome: (_gate, outcome) => outcomes.push(outcome.status),
    },
  });
  expect(planned).toHaveLength(1);
  expect(planned[0]!.notJudged).toBe(7 + 120 * 3 - 300);
  expect(planned[0]!.pending).toBe(300);
});
