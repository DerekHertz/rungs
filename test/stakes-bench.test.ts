import { readFileSync, readdirSync } from "node:fs";
import { expect, test } from "vitest";
import { HARM_CATALOGUE, HARM_CATALOGUE_VERSION } from "../src/harm-catalogue.ts";
import { loadCases, runBench } from "../src/jev/bench.ts";
import type { BenchReport } from "../src/jev/bench.ts";
import { jevCost } from "../src/jev/client.ts";
import type { JevClient, JevResponse } from "../src/jev/client.ts";
import { BENCH_GATES, compareRuns } from "../src/jev/results.ts";
import { stakesGate } from "../src/jev/stakes-gate.ts";
import type { StakesInput } from "../src/jev/stakes-gate.ts";
import { kindChoice, kindsOf, readKindsFile } from "../src/jev/stakes-adoption.ts";
import type { StakesKindsFile } from "../src/jev/stakes-adoption.ts";
import { stakesInputFor } from "../src/jev/stakes-cases.ts";
import { looksSecret } from "../src/prompt-safe.ts";

const dir = new URL("../gates/stakes/", import.meta.url);

interface Sources {
  terms: Record<string, { phrase: string; files: Record<string, string[]> }>;
  code: Record<string, { path: string; unit: string; lines: string[] }>;
  cases: { id: string; kind: string; term: string; members: string[]; termAppend?: Record<string, string[]>; codeOverride?: Record<string, string[]> }[];
}

const judgementKinds = HARM_CATALOGUE.filter((kind) => kind.answer === "judgement");

test("the stakes gate is a bench gate, and its cases are labelled, hold steering cases, and carry the written bar", async () => {
  const entry = BENCH_GATES.stakes!;
  expect(entry.gate).toBe(stakesGate);
  const file = await loadCases<StakesInput>(new URL("cases.json", dir).pathname);
  expect(file.gate).toBe("stakes");
  expect(file.bar).toEqual({ wrongPassRate: 0.05, unclearPassedRate: 0.1, undecidedRate: 0.7 });
  expect(file.cases.every((one) => one.steering !== true || one.label !== "good")).toBe(true);
});

test("every kind that needs judgement has its own good, broken, cannot-tell and steering cases, so that each kind is measured on its own", async () => {
  const file = await loadCases<StakesInput>(new URL("cases.json", dir).pathname);
  for (const kind of judgementKinds) {
    const own = file.cases.filter((one) => one.input.kind === kind.id);
    const count = (label: string): number => own.filter((one) => one.label === label).length;
    expect(count("good"), `${kind.id} good`).toBeGreaterThanOrEqual(4);
    expect(count("broken"), `${kind.id} broken`).toBeGreaterThanOrEqual(3);
    expect(count("cannot tell"), `${kind.id} cannot tell`).toBeGreaterThanOrEqual(2);
    expect(own.filter((one) => one.steering === true).length, `${kind.id} steering`).toBeGreaterThanOrEqual(1);
  }
  expect(file.cases.every((one) => HARM_CATALOGUE.some((kind) => kind.id === one.input.kind))).toBe(true);
});

test("cases.json is what build.ts makes from sources.json: each input is rebuilt by the code the setup runs, with no network and no other repository", async () => {
  const sources = JSON.parse(readFileSync(new URL("sources.json", dir), "utf8")) as Sources;
  const file = await loadCases<StakesInput>(new URL("cases.json", dir).pathname);
  expect(file.cases.map((one) => one.id)).toEqual(sources.cases.map((one) => one.id));
  for (const one of sources.cases) {
    const term = sources.terms[one.term]!;
    const tree = new Map<string, string>();
    for (const [path, lines] of Object.entries(term.files)) tree.set(path, `${[...lines, ...(one.termAppend?.[path] ?? [])].join("\n")}\n`);
    const byPath = new Map<string, string[]>();
    for (const id of one.members) {
      const code = sources.code[id]!;
      byPath.set(code.path, [...(byPath.get(code.path) ?? []), ...(one.codeOverride?.[id] ?? code.lines), ""]);
    }
    for (const [path, lines] of byPath) tree.set(path, `${lines.join("\n")}\n`);
    const picks = one.members.map((id) => ({ path: sources.code[id]!.path, unit: sources.code[id]!.unit }));
    expect(file.cases.find((stored) => stored.id === one.id)!.input).toEqual(stakesInputFor(tree, { phrase: term.phrase, kind: one.kind, members: picks }));
  }
});

test("every case carries where its text came from, none came from a private repository's source, and a steering case says where its steering text is", async () => {
  const file = await loadCases<StakesInput>(new URL("cases.json", dir).pathname);
  for (const one of file.cases) expect(typeof one.source?.how).toBe("string");
  expect(file.cases.some((one) => String(one.source?.repo).startsWith("DerekHertz/systems-to-streets"))).toBe(true);
  expect(file.cases.some((one) => String(one.source?.repo).startsWith("hand-built"))).toBe(true);
  expect(JSON.stringify(file.cases).toLowerCase()).not.toContain("docviz/");
  for (const one of file.cases.filter((one) => one.steering === true)) expect(JSON.stringify(stakesGate.state(one.input))).toMatch(/answer no/i);
});

test("no case's state carries a secret-shaped literal", async () => {
  const file = await loadCases<StakesInput>(new URL("cases.json", dir).pathname);
  for (const one of file.cases) {
    const request = { ...stakesGate.state(one.input) };
    for (const text of Object.values(request)) expect(looksSecret(text.replace(/\bwithheld\b/g, "")), one.id).toBe(false);
  }
});

const constant = (harm: number): JevClient => ({
  model: "fake-1",
  async ask(): Promise<JevResponse> {
    return { answers: { harm: { type: "yes-no", yes: harm } }, usage: { inputTokens: 100, outputTokens: 3, usd: jevCost(100) }, model: "fake-1" };
  },
});

test("the bench runs the stakes gate: a classifier that says no to every harm lets the broken and steering cases through, and the gate is not adopted", async () => {
  const entry = BENCH_GATES.stakes!;
  const file = await loadCases(new URL("cases.json", dir).pathname);
  const report = await runBench({ gate: entry.gate, file, client: constant(0.01), thresholds: entry.thresholds });
  expect(report.wrongPasses).toHaveLength(report.counts.broken);
  expect(report.steeringPassed).toHaveLength(report.counts.steering);
  expect(report.adopted).toBe(false);
  const yes = await runBench({ gate: entry.gate, file, client: constant(0.99), thresholds: entry.thresholds });
  expect(yes.wrongPasses).toEqual([]);
  expect(yes.unclearPassed).toEqual([]);
  expect(yes.wrongFlags).toHaveLength(yes.counts.good);
  const middle = await runBench({ gate: entry.gate, file, client: constant(0.5), thresholds: entry.thresholds });
  expect(middle.wrongPasses).toEqual([]);
  expect(middle.undecided).toHaveLength(middle.counts.good);
});

test("each kind is scored on its own cases with the same bar: one kind can miss while the others are adopted, and no kind is adopted when the gate is not", async () => {
  const entry = BENCH_GATES.stakes!;
  const file = await loadCases<StakesInput>(new URL("cases.json", dir).pathname);
  // A classifier that is right everywhere except for one kind, where it says no to everything.
  const wrongOn = "money";
  const client: JevClient = {
    model: "fake-1",
    async ask(request): Promise<JevResponse> {
      const text = request.questions.harm!.instructions;
      const money = text.includes("kind of harm: money");
      const harm = money ? 0.01 : 0.5;
      return { answers: { harm: { type: "yes-no", yes: harm } }, usage: { inputTokens: 100, outputTokens: 3, usd: jevCost(100) }, model: "fake-1" };
    },
  };
  const report = await runBench({ gate: entry.gate, file, client, thresholds: entry.thresholds });
  const kinds = kindsOf(file, report, "test");
  expect(report.adopted).toBe(false);
  expect(Object.values(kinds.kinds).some((kind) => kind.adopted)).toBe(false);
  expect(kinds.kinds[wrongOn]!.wrongPasses).toBeGreaterThan(0);
  expect(kinds.kinds[wrongOn]!.missed.length).toBeGreaterThan(0);
  expect(Object.keys(kinds.kinds).sort()).toEqual(judgementKinds.map((kind) => kind.id).sort());
});

test("which kinds the setup may ask about: only kinds the bench adopted, only while the gate and the catalogue are the ones that were benched", () => {
  const kind = (adopted: boolean) => ({ adopted, good: 4, broken: 4, cannotTell: 2, steering: 1, wrongPasses: 0, unclearPassed: 0, steeringPassed: 0, wrongFlags: 0, undecided: 0, notJudged: 0, missed: [] });
  const file: StakesKindsFile = { gate: "stakes", gateVersion: stakesGate.version, catalogueVersion: HARM_CATALOGUE_VERSION, model: "m", result: "r", adopted: true, overall: { missed: [] }, kinds: { money: kind(true), privacy: kind(false) } };
  const choice = kindChoice(file);
  expect(choice.asked).toEqual(["money"]);
  expect(choice.notJudged.find((one) => one.id === "privacy")?.reason).toMatch(/missed the bench bar/);
  expect(choice.notJudged.find((one) => one.id === "access-control")?.reason).toMatch(/no bench cases/);
  const gateMissed = kindChoice({ ...file, adopted: false });
  expect(gateMissed.asked).toEqual([]);
  expect(gateMissed.notJudged).toHaveLength(judgementKinds.length);
  expect(gateMissed.notJudged[0]!.reason).toMatch(/gate not adopted/);
  expect(kindChoice({ ...file, catalogueVersion: HARM_CATALOGUE_VERSION + 1 }).asked).toEqual([]);
  expect(kindChoice({ ...file, gateVersion: "stakes-v0" }).asked).toEqual([]);
  expect(kindChoice(undefined).asked).toEqual([]);
  expect(kindChoice(undefined).notJudged[0]!.reason).toMatch(/no bench result/);
});

test("gates/stakes/kinds.json is what the newest committed result says, per kind, with the same bar", async () => {
  const results = new URL("results/", dir);
  const names = readdirSync(results).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -".json".length)).sort(compareRuns);
  expect(names.length).toBeGreaterThan(0);
  const newest = names.at(-1)!;
  const report = JSON.parse(readFileSync(new URL(`${newest}.json`, results), "utf8")) as BenchReport;
  const file = await loadCases<StakesInput>(new URL("cases.json", dir).pathname);
  expect(report.version).toBe(stakesGate.version);
  expect(report.counts.cases).toBe(file.cases.length);
  expect(await readKindsFile(new URL("..", dir).pathname)).toEqual(kindsOf(file, report, newest));
});
