import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { compare, contractsMoved } from "../src/compare.ts";
import { extract } from "../src/extract/extract.ts";
import type { FileTree, NodeId } from "../src/graph.ts";
import { MAX_CLAIM_CHARS, MAX_PLACES, MAX_STATE_CHARS, CLAIM_THRESHOLDS, claimGate } from "../src/jev/claim-gate.ts";
import type { ClaimInput } from "../src/jev/claim-gate.ts";
import { claimItems, ownersOf } from "../src/jev/claim-source.ts";
import type { JevAnswer, JevClient } from "../src/jev/client.ts";
import { MAX_HUNK_LINES, STANDARD_THRESHOLDS, standardGate } from "../src/jev/standard-gate.ts";
import type { StandardInput } from "../src/jev/standard-gate.ts";
import { standardItems } from "../src/jev/standard-source.ts";
import { judgeItems } from "../src/jev/store.ts";
import type { Item } from "../src/jev/store.ts";
import type { Gate } from "../src/jev/gate.ts";
import type { JudgeSubject } from "../src/jev/subject.ts";
import { folds } from "../src/judged-fold.ts";
import { kindOfRecord } from "../src/kind-of-miss.ts";
import { collectStandards } from "../src/standards.ts";
import { tierLevel } from "../src/tier-table.ts";
import { testTiers } from "./jev-fixtures.ts";

/*
 * Every way the evidence a gate shows can be shortened must set the record's `cut`, and the kind of
 * miss reads only that. Each case builds the evidence with the real source builder, judges it with a
 * fake client that answers "clean over the tier", and asks what kind the record is: whole evidence
 * is "no miss found", shortened evidence is "kind unknown".
 */

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "kind-cut-"));
  scratch.push(dir);
  return dir;
};

const yes = (value: number): JevAnswer => ({ type: "yes-no", yes: value });
const clientAnswering = (answers: Record<string, JevAnswer>): JevClient & { calls: number } => {
  const client = {
    model: "fake-1",
    calls: 0,
    async ask() {
      client.calls += 1;
      return { answers, usage: { inputTokens: 10, outputTokens: 1, usd: 0 }, model: "fake-1" };
    },
  };
  return client;
};

function subjectOf(base: FileTree, head: FileTree, claims: JudgeSubject["claims"] = []): JudgeSubject {
  const baseGraph = extract(base);
  const graph = extract(head);
  const comparison = compare(baseGraph, graph, { base, head });
  return { comparison, contracts: contractsMoved(comparison, baseGraph, graph), claims, baseTree: base, headTree: head, head: ownersOf(graph), base: ownersOf(baseGraph), standards: collectStandards({ graph: baseGraph, tree: base }, head), tiers: testTiers };
}

async function recordOf<Input>(gate: Gate<Input>, item: Item<Input>, answers: Record<string, JevAnswer>, cacheDir = tmp()) {
  const run = await judgeItems({ gate, items: [item], thresholds: item.thresholds!, client: clientAnswering(answers), base: "b", head: "h", cacheDir });
  const outcome = run.outcomes[0]!;
  if (outcome.status !== "judged") throw new Error(outcome.reason);
  return outcome.record;
}

/** Clean over the gate's own limits, held back only by a tier of 99.9%. */
const heldStandard = (item: Item<StandardInput>) => recordOf(standardGate, { ...item, thresholds: { ...STANDARD_THRESHOLDS, tier: tierLevel(99.9) } }, { breaks: yes(0.02), before: yes(0.1) });
const heldClaim = (item: Item<ClaimInput>) => recordOf(claimGate, { ...item, thresholds: { ...CLAIM_THRESHOLDS, tier: tierLevel(99.9) } }, { shown: yes(0.97), contradicted: yes(0.02) });
/** Not shown, not contradicted: ungrounded when the evidence was whole. */
const notShownClaim = (item: Item<ClaimInput>, shown = 0.2) => recordOf(claimGate, { ...item, thresholds: CLAIM_THRESHOLDS }, { shown: yes(shown), contradicted: yes(0.01) });

const RULES = "# Project\n\n## Safety\nNever call eval.\n";
const lines = (count: number, make: (index: number) => string): string => `${Array.from({ length: count }, (_, index) => make(index + 1)).join("\n")}\n`;
const withRules = (files: [string, string][], rules = RULES): { base: FileTree; head: FileTree } => {
  const base: FileTree = new Map([["package.json", "{}\n"], ["AGENTS.md", rules]]);
  const head: FileTree = new Map([["package.json", "{}\n"], ["AGENTS.md", rules], ...files]);
  return { base, head };
};

async function standardOf(files: [string, string][], rules = RULES) {
  const { base, head } = withRules(files, rules);
  const { items } = standardItems(subjectOf(base, head));
  expect(items.length).toBeGreaterThan(0);
  return heldStandard(items[0]!);
}

async function claimOf(files: [string, string][], ids: string[], text = "It adds helpers.", base: FileTree = new Map([["package.json", "{}\n"]]), head?: FileTree) {
  const tree: FileTree = head ?? new Map([["package.json", "{}\n"], ...files]);
  const items = claimItems(subjectOf(base, tree, [{ index: 0, text, ids: ids as NodeId[] }]));
  return items[0]!;
}

test("standard: whole evidence held back by the tier is no miss found, with a cut that says so", async () => {
  const record = await standardOf([["src/a.ts", "export const a = 1;\n"]]);
  expect(record.cut).toEqual([]);
  expect(kindOfRecord(record)?.kind).toBe("no miss found");
});

test("standard: a source line clipped at 200 characters (the eval that safeClip removed) is unknown", async () => {
  const record = await standardOf([["src/a.ts", `${"doThing(); ".repeat(25)}eval(userInput);\n`]]);
  expect(record.shown.state["after the change (head)"]).not.toContain("eval(userInput)");
  expect(record.cut?.length).toBeGreaterThan(0);
  const found = kindOfRecord(record)!;
  expect(found.kind).toBe("unknown");
  expect(found.why).toMatch(/clipped/);
});

test("standard: a rule cut to its first characters is unknown", async () => {
  const record = await standardOf([["src/a.ts", "export const a = 1;\n"]], `# Rules\n${"Be careful. ".repeat(900)}\n`);
  expect(kindOfRecord(record)?.kind).toBe("unknown");
});

test("standard: a heading or a path clipped at 200 characters is unknown", async () => {
  const heading = await standardOf([["src/a.ts", "export const a = 1;\n"]], `# ${"Long heading ".repeat(30)}\nNever call eval.\n`);
  expect(kindOfRecord(heading)?.kind).toBe("unknown");
  const path = await standardOf([[`src/${"deep-folder-name/".repeat(15)}a.ts`, "export const a = 1;\n"]]);
  expect(kindOfRecord(path)?.kind).toBe("unknown");
});

test("standard: a hunk side over its line guard, or a state over its budget, is cut (reached only by a hand-built input)", () => {
  const base = withRules([["src/a.ts", "export const a = 1;\n"]]);
  const input = standardItems(subjectOf(base.base, base.head)).items[0]!.input;
  expect(standardGate.cut!(input)).toEqual([]);
  const tall = { ...input, hunk: { ...input.hunk, after: Array.from({ length: MAX_HUNK_LINES + 5 }, (_, index) => `+${index + 1}: x`) } };
  expect(standardGate.cut!(tall).join(" ")).toMatch(/5 more lines/);
  const wide = { ...input, hunk: { ...input.hunk, after: Array.from({ length: MAX_HUNK_LINES }, () => `+1: ${"x".repeat(900)}`) } };
  expect(standardGate.cut!(wide).join(" ")).toMatch(/state budget/);
  expect(Object.values(standardGate.state(wide)).join("").length).toBeGreaterThan(0);
});

test("standard: a breach seen is still breaks a standard, over a clipped line", async () => {
  const { base, head } = withRules([["src/a.ts", `${"doThing(); ".repeat(25)}more();\neval(userInput);\n`]]);
  const item = standardItems(subjectOf(base, head)).items[0]!;
  const record = await recordOf(standardGate, { ...item, thresholds: { ...STANDARD_THRESHOLDS, tier: tierLevel(99.9) } }, { breaks: yes(0.9), before: yes(0.1) });
  expect(kindOfRecord(record)?.kind).toBe("breaks a standard");
});

test("claim: whole evidence held back by the tier is no miss found, and not shown is ungrounded", async () => {
  const item = await claimOf([["src/a.ts", "export const a = 1;\n"]], ["file:src/a.ts"]);
  const record = await heldClaim(item);
  expect(record.cut).toEqual([]);
  expect(kindOfRecord(record)?.kind).toBe("no miss found");
  expect(kindOfRecord(await notShownClaim(item))?.kind).toBe("ungrounded");
});

test("claim: a changed line clipped at 200 characters is unknown", async () => {
  const item = await claimOf([["src/a.ts", `${"doThing(); ".repeat(25)}eval(userInput);\n`]], ["file:src/a.ts"]);
  for (const record of [await heldClaim(item), await notShownClaim(item)]) {
    expect(record.cut?.join(" ")).toMatch(/clipped/);
    expect(kindOfRecord(record)?.kind).toBe("unknown");
  }
});

test("claim: a derived fact clipped at 200 characters (a long signature) is unknown", async () => {
  const params = Array.from({ length: 30 }, (_, index) => `parameter${index}: number`).join(", ");
  const base: FileTree = new Map([["package.json", "{}\n"], ["src/a.ts", "export function a() {}\n"]]);
  const head: FileTree = new Map([["package.json", "{}\n"], ["src/a.ts", `export function a(${params}) {}\n`]]);
  const item = (claimItems(subjectOf(base, head, [{ index: 0, text: "a takes parameters.", ids: ["file:src/a.ts" as NodeId] }])))[0]!;
  expect(item.input.places[0]!.facts.join("\n")).toContain("...");
  expect(kindOfRecord(await heldClaim(item))?.kind).toBe("unknown");
});

test("claim: changed lines cut at the per-place cap are unknown", async () => {
  const item = await claimOf([["src/a.ts", lines(100, (n) => `export const n${n} = ${n};`)]], ["file:src/a.ts"]);
  expect(kindOfRecord(await heldClaim(item))?.kind).toBe("unknown");
  expect(kindOfRecord(await notShownClaim(item))?.kind).toBe("unknown");
});

test("claim: derived facts cut at the per-place cap are unknown, whatever the lines show", async () => {
  const files: [string, string][] = [["src/a.ts", lines(50, (n) => `export function f${n}() {}`)]];
  const item = await claimOf(files, ["file:src/a.ts"]);
  expect(item.input.places[0]!.lines.length).toBeLessThan(60);
  expect(item.input.places[0]!.cutFacts).toBeGreaterThan(0);
  expect(kindOfRecord(await heldClaim(item))?.kind).toBe("unknown");
});

test("claim: linked places left out past the cap are unknown", async () => {
  const files: [string, string][] = Array.from({ length: MAX_PLACES + 3 }, (_, index) => [`src/f${index}.ts`, `export const v${index} = ${index};\n`]);
  const item = await claimOf(files, files.map(([path]) => `file:${path}`));
  expect(item.input.omittedPlaces).toBe(3);
  expect(kindOfRecord(await heldClaim(item))?.kind).toBe("unknown");
  expect(kindOfRecord(await notShownClaim(item))?.kind).toBe("unknown");
});

test("claim: places left out to fit the state budget, or one cut to fit it, are unknown", async () => {
  const wide = (name: string): [string, string] => [name, lines(60, (n) => `export const w${n} = "${"x".repeat(190)}";`)];
  const files = [wide("src/a.ts"), wide("src/b.ts"), wide("src/c.ts"), wide("src/d.ts")];
  const item = await claimOf(files, files.map(([path]) => `file:${path}`));
  const state = claimGate.state(item.input);
  expect(state.omitted).toMatch(/state within its budget/);
  expect(Object.values(state).join("").length).toBeLessThanOrEqual(MAX_STATE_CHARS + 200);
  expect(kindOfRecord(await heldClaim(item))?.kind).toBe("unknown");
  const first = { ...item.input, places: [{ ...item.input.places[0]!, lines: Array.from({ length: 60 }, () => `+1: ${"y".repeat(900)}`) }] };
  expect(claimGate.cut!({ ...first, claim: "x".repeat(MAX_STATE_CHARS - 100) }).join(" ")).toMatch(/state budget/);
});

test("claim: a claim cut to its first characters is unknown", async () => {
  const item = await claimOf([["src/a.ts", "export const a = 1;\n"]], ["file:src/a.ts"], `It adds a. ${"More words. ".repeat(300)}`);
  expect(item.input.claim.length).toBeGreaterThan(MAX_CLAIM_CHARS);
  expect(kindOfRecord(await heldClaim(item))?.kind).toBe("unknown");
  expect(kindOfRecord(await notShownClaim(item))?.kind).toBe("unknown");
});

test("claim: a place with no changed lines available (binary) is unknown; one with nothing changed in its lines is whole", async () => {
  const binary = await claimOf([["src/logo.bin", "a\u0000b\n"]], ["file:src/logo.bin"]);
  expect(kindOfRecord(await notShownClaim(binary))?.kind).toBe("unknown");
  const same: FileTree = new Map([["package.json", "{}\n"], ["src/a.ts", "export const a = 1;\n"]]);
  const moved: FileTree = new Map([["package.json", "{}\n"], ["src/b.ts", "export const a = 1;\n"]]);
  const item = claimItems(subjectOf(same, moved, [{ index: 0, text: "a moved.", ids: ["file:src/b.ts" as NodeId] }]))[0]!;
  expect(item.input.places[0]!.noLines).toMatch(/no line changed/);
  expect(kindOfRecord(await notShownClaim(item))?.kind).toBe("ungrounded");
});

test("claim: a tie between shown and not shown is unknown, and a strict majority against shown is ungrounded", async () => {
  const item = await claimOf([["src/a.ts", "export const a = 1;\n"]], ["file:src/a.ts"]);
  const found = kindOfRecord(await notShownClaim(item, 0.5))!;
  expect(found.kind).toBe("unknown");
  expect(found.why).toMatch(/not sure/);
  expect(kindOfRecord(await notShownClaim(item, 0.49))?.kind).toBe("ungrounded");
});

test("the store records the cut from the input, also for a record read back, and one written before has it filled in with no new call", async () => {
  const dir = tmp();
  const item = await claimOf([["src/a.ts", `${"doThing(); ".repeat(25)}eval(userInput);\n`]], ["file:src/a.ts"]);
  const client = clientAnswering({ shown: yes(0.2), contradicted: yes(0.01) });
  const request = { gate: claimGate, items: [item], thresholds: CLAIM_THRESHOLDS, client, base: "b", head: "h", cacheDir: dir };
  const first = await judgeItems(request);
  expect(client.calls).toBe(1);
  const file = join(dir, "judged", readdirSync(join(dir, "judged"))[0]!);
  const saved = JSON.parse(readFileSync(file, "utf8")) as { records: Record<string, unknown>[] };
  for (const record of saved.records) delete record.cut;
  writeFileSync(file, JSON.stringify(saved));
  const again = await judgeItems(request);
  expect(client.calls).toBe(1);
  const [was, now] = [first.outcomes[0]!, again.outcomes[0]!];
  if (was.status !== "judged" || now.status !== "judged") throw new Error("not judged");
  expect(now.cached).toBe(true);
  expect(now.record.cut).toEqual(was.record.cut);
  expect(now.record.cut?.length).toBeGreaterThan(0);
});

/* A settle is a claim of absence (nothing contradicts it, nothing breaches the rule): over cut evidence it cannot be made. */

const settles = { shown: yes(1), contradicted: yes(0) };
const longRule = `# Rules\n${"Be careful. ".repeat(900)}\n`;
const manyLines = (): [string, string] => ["src/a.ts", lines(100, (n) => `export const n${n} = ${n};`)];

test("verdict: a claim with more changed lines than were shown, answered shown and not contradicted, is undecided, never settled", async () => {
  const item = await claimOf([manyLines()], ["file:src/a.ts"]);
  const record = await recordOf(claimGate, { ...item, thresholds: CLAIM_THRESHOLDS }, settles);
  expect(record.cut?.length).toBeGreaterThan(0);
  expect(record.verdict).toBe("undecided");
  expect(kindOfRecord(record)?.kind).toBe("unknown");
  const tiered = await recordOf(claimGate, { ...item, thresholds: { ...CLAIM_THRESHOLDS, tier: tierLevel(95) } }, settles);
  expect(tiered.verdict).toBe("undecided");
});

test("verdict: a rule cut to its first characters, answered no breach and none before, is undecided, never settled", async () => {
  const { base, head } = withRules([["src/a.ts", "export const a = 1;\n"]], longRule);
  const item = standardItems(subjectOf(base, head)).items[0]!;
  const record = await recordOf(standardGate, { ...item, thresholds: STANDARD_THRESHOLDS }, { breaks: yes(0), before: yes(0) });
  expect(record.cut?.join(" ")).toMatch(/characters of the rule were cut/);
  expect(record.verdict).toBe("undecided");
  expect(kindOfRecord(record)?.kind).toBe("unknown");
});

test("verdict: whole evidence still settles, and a breach or a contradiction seen over cut evidence still flags", async () => {
  const whole = await claimOf([["src/a.ts", "export const a = 1;\n"]], ["file:src/a.ts"]);
  expect((await recordOf(claimGate, { ...whole, thresholds: CLAIM_THRESHOLDS }, settles)).verdict).toBe("settled");
  const cut = await claimOf([manyLines()], ["file:src/a.ts"]);
  expect((await recordOf(claimGate, { ...cut, thresholds: CLAIM_THRESHOLDS }, { shown: yes(0.1), contradicted: yes(0.95) })).verdict).toBe("flagged");
  const { base, head } = withRules([["src/a.ts", "export const a = 1;\n"]], longRule);
  const rule = standardItems(subjectOf(base, head)).items[0]!;
  expect((await recordOf(standardGate, { ...rule, thresholds: STANDARD_THRESHOLDS }, { breaks: yes(0.9), before: yes(0) })).verdict).toBe("flagged");
});

test("verdict: a settled record already on file over cut evidence is decided again when read back, with no new call, and page, fold and kind agree", async () => {
  const dir = tmp();
  const item = await claimOf([manyLines()], ["file:src/a.ts"]);
  const client = clientAnswering(settles);
  const request = { gate: claimGate, items: [{ ...item, thresholds: CLAIM_THRESHOLDS }], thresholds: CLAIM_THRESHOLDS, client, base: "b", head: "h", cacheDir: dir };
  await judgeItems(request);
  const file = join(dir, "judged", readdirSync(join(dir, "judged"))[0]!);
  const saved = JSON.parse(readFileSync(file, "utf8")) as { records: Record<string, unknown>[] };
  for (const record of saved.records) {
    record.verdict = "settled";
    delete record.cut;
  }
  writeFileSync(file, JSON.stringify(saved));
  const again = await judgeItems(request);
  expect(client.calls).toBe(1);
  const outcome = again.outcomes[0]!;
  if (outcome.status !== "judged") throw new Error("not judged");
  expect(outcome.cached).toBe(true);
  expect(outcome.record.verdict).toBe("undecided");
  expect(kindOfRecord(outcome.record)?.kind).toBe("unknown");
  expect(folds({ kind: "judged", verdict: outcome.record.verdict, record: outcome.record }, true)).toBe(false);
});
