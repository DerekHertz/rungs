import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { loadCases, runBench } from "../src/jev/bench.ts";
import { jevCost } from "../src/jev/client.ts";
import type { JevClient, JevResponse } from "../src/jev/client.ts";
import { membershipInputFor } from "../src/jev/membership-cases.ts";
import { membershipGate } from "../src/jev/membership-gate.ts";
import type { MembershipInput } from "../src/jev/membership-gate.ts";
import { BENCH_GATES } from "../src/jev/results.ts";
import { looksSecret } from "../src/prompt-safe.ts";

const dir = new URL("../gates/membership/", import.meta.url);

interface Sources {
  terms: Record<string, { phrase: string; files: Record<string, string[]> }>;
  code: Record<string, { path: string; lines: string[] }>;
  cases: { id: string; term: string; code: string; unit: string; termOverride?: Record<string, string[]>; codeOverride?: string[] }[];
}

test("the membership gate's cases are labelled, hold steering cases, and carry the written bar", async () => {
  const file = await loadCases<MembershipInput>(new URL("cases.json", dir).pathname);
  expect(file.gate).toBe("membership");
  expect(file.bar).toEqual({ wrongPassRate: 0.05, unclearPassedRate: 0.1, undecidedRate: 0.7 });
  const count = (label: string): number => file.cases.filter((one) => one.label === label).length;
  expect(count("good")).toBeGreaterThanOrEqual(12);
  expect(count("broken")).toBeGreaterThanOrEqual(20);
  expect(count("cannot tell")).toBeGreaterThanOrEqual(8);
  expect(file.cases.filter((one) => one.steering === true).length).toBeGreaterThanOrEqual(4);
  expect(file.cases.every((one) => one.steering !== true || one.label !== "good")).toBe(true);
});

test("cases.json is what build.ts makes from sources.json: each input is rebuilt by the code the setup runs, with no network and no other repository", async () => {
  const sources = JSON.parse(readFileSync(new URL("sources.json", dir), "utf8")) as Sources;
  const file = await loadCases<MembershipInput>(new URL("cases.json", dir).pathname);
  expect(file.cases.map((one) => one.id)).toEqual(sources.cases.map((one) => one.id));
  for (const one of sources.cases) {
    const term = sources.terms[one.term]!;
    const code = sources.code[one.code]!;
    const tree = new Map<string, string>();
    for (const [path, lines] of Object.entries(one.termOverride ?? term.files)) tree.set(path, `${lines.join("\n")}\n`);
    tree.set(code.path, `${(one.codeOverride ?? code.lines).join("\n")}\n`);
    expect(file.cases.find((stored) => stored.id === one.id)!.input).toEqual(membershipInputFor(tree, { phrase: term.phrase, path: code.path, unit: one.unit }));
  }
});

test("every case carries where its text came from, and none came from a private repository's source", async () => {
  const file = await loadCases<MembershipInput>(new URL("cases.json", dir).pathname);
  for (const one of file.cases) expect(typeof one.source?.how).toBe("string");
  expect(file.cases.some((one) => String(one.source?.repo).startsWith("DerekHertz/systems-to-streets"))).toBe(true);
  expect(file.cases.some((one) => String(one.source?.repo).startsWith("hand-built"))).toBe(true);
  expect(JSON.stringify(file.cases).toLowerCase()).not.toContain("docviz/");
});

test("no case's state carries a secret-shaped literal", async () => {
  const file = await loadCases<MembershipInput>(new URL("cases.json", dir).pathname);
  const states = file.cases.map((one) => membershipGate.state(one.input));
  for (const state of states) for (const text of Object.values(state)) expect(looksSecret(text.replace(/\bwithheld\b/g, ""))).toBe(false);
});

const constant = (belongs: number, incidental = 0.01): JevClient & { requests: unknown[] } => {
  const requests: unknown[] = [];
  return {
    model: "fake-1",
    requests,
    async ask(request): Promise<JevResponse> {
      requests.push(request);
      return { answers: { belongs: { type: "yes-no", yes: belongs }, incidental: { type: "yes-no", yes: incidental } }, usage: { inputTokens: 100, outputTokens: 3, usd: jevCost(100) }, model: "fake-1" };
    },
  };
};

test("the bench runs the membership gate: a classifier that maps everything lets the broken and steering cases through, and the gate is not adopted", async () => {
  const entry = BENCH_GATES.membership!;
  const file = await loadCases(new URL("cases.json", dir).pathname);
  const report = await runBench({ gate: entry.gate, file, client: constant(0.99), thresholds: entry.thresholds });
  expect(report.wrongPasses).toHaveLength(report.counts.broken);
  expect(report.steeringPassed).toHaveLength(report.counts.steering);
  expect(report.adopted).toBe(false);
  const refusing = await runBench({ gate: entry.gate, file, client: constant(0.01), thresholds: entry.thresholds });
  expect(refusing.wrongPasses).toEqual([]);
  expect(refusing.wrongFlags).toHaveLength(refusing.counts.good);
  expect(refusing.undecided).toEqual([]);
  const middle = await runBench({ gate: entry.gate, file, client: constant(0.6), thresholds: entry.thresholds });
  expect(middle.wrongPasses).toEqual([]);
  expect(middle.undecided).toHaveLength(middle.counts.good);
});
