import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { loadCases, runBench } from "../src/jev/bench.ts";
import { jevCost } from "../src/jev/client.ts";
import type { JevClient, JevResponse } from "../src/jev/client.ts";
import { BENCH_GATES } from "../src/jev/results.ts";
import { standardInputFor } from "../src/jev/standard-cases.ts";
import { standardGate } from "../src/jev/standard-gate.ts";
import type { StandardInput } from "../src/jev/standard-gate.ts";

const dir = new URL("../gates/standard/", import.meta.url);

test("the standard gate's cases are labelled, hold steering cases, and carry the written bar", async () => {
  const file = await loadCases<StandardInput>(new URL("cases.json", dir).pathname);
  expect(file.gate).toBe("standard");
  expect(file.bar).toEqual({ wrongPassRate: 0.05, unclearPassedRate: 0.1, undecidedRate: 0.7 });
  const count = (label: string): number => file.cases.filter((one) => one.label === label).length;
  expect(count("good")).toBeGreaterThanOrEqual(10);
  expect(count("broken")).toBeGreaterThanOrEqual(10);
  expect(count("cannot tell")).toBeGreaterThanOrEqual(5);
  expect(file.cases.filter((one) => one.steering === true).length).toBeGreaterThanOrEqual(4);
  expect(file.cases.every((one) => one.steering !== true || one.label !== "good")).toBe(true);
  // A case for each of the rule's states the gate must tell apart: a new file, a removed file and a violation the base already had.
  expect(file.cases.some((one) => one.input.hunk.base === null)).toBe(true);
  expect(file.cases.some((one) => one.input.hunk.head === null)).toBe(true);
  expect(file.cases.some((one) => one.id.includes("already-there"))).toBe(true);
});

test("cases.json is what build.ts makes from sources.json: each input is rebuilt by the code the page runs, with no network", async () => {
  const sources = JSON.parse(readFileSync(new URL("sources.json", dir), "utf8")) as {
    rules: Record<string, { heading: string; body: string }>;
    cases: { id: string; rule: string; ruleExtra?: string; files: Record<string, { base: string[] | null; head: string[] | null }> }[];
  };
  const file = await loadCases<StandardInput>(new URL("cases.json", dir).pathname);
  expect(file.cases.map((one) => one.id)).toEqual(sources.cases.map((one) => one.id));
  for (const one of sources.cases) {
    const rule = sources.rules[one.rule]!;
    const ruleFile = `# Working rules\n\n## ${rule.heading}\n\n${rule.body}${one.ruleExtra === undefined ? "" : `\n\n${one.ruleExtra}`}\n`;
    const base = new Map([["AGENTS.md", ruleFile]]);
    const head = new Map([["AGENTS.md", ruleFile]]);
    for (const [path, text] of Object.entries(one.files)) {
      if (text.base !== null) base.set(path, `${text.base.join("\n")}\n`);
      if (text.head !== null) head.set(path, `${text.head.join("\n")}\n`);
    }
    const input = standardInputFor(base, head, { heading: rule.heading });
    expect(file.cases.find((stored) => stored.id === one.id)!.input).toEqual(input);
  }
});

test("no case's state carries a secret-shaped literal", async () => {
  const file = await loadCases<StandardInput>(new URL("cases.json", dir).pathname);
  const text = JSON.stringify(file.cases.map((one) => standardGate.state(one.input)));
  expect(text).not.toContain("sk-live-4eC39HqLyjWDarjtT1zdp7dc");
  expect(text).not.toContain("ghp_16C7e42F292c6912E7710c838347Ae178B4a");
});

const constant = (breaks: number): JevClient & { requests: unknown[] } => {
  const requests: unknown[] = [];
  return {
    model: "fake-1",
    requests,
    async ask(request): Promise<JevResponse> {
      requests.push(request);
      return { answers: { breaks: { type: "yes-no", yes: breaks }, before: { type: "yes-no", yes: 0.01 } }, usage: { inputTokens: 100, outputTokens: 3, usd: jevCost(100) }, model: "fake-1" };
    },
  };
};

test("the bench runs the standard gate: a classifier that settles everything lets the broken and steering cases through, and the gate is not adopted", async () => {
  const entry = BENCH_GATES.standard!;
  const file = await loadCases(new URL("cases.json", dir).pathname);
  const report = await runBench({ gate: entry.gate, file, client: constant(0.01), thresholds: entry.thresholds });
  expect(report.counts.cases).toBe(45);
  expect(report.wrongPasses).toHaveLength(report.counts.broken);
  expect(report.steeringPassed).toHaveLength(report.counts.steering);
  expect(report.adopted).toBe(false);
  const flagging = await runBench({ gate: entry.gate, file, client: constant(0.99), thresholds: entry.thresholds });
  expect(flagging.wrongPasses).toEqual([]);
  expect(flagging.wrongFlags).toHaveLength(flagging.counts.good);
  expect(flagging.undecided).toEqual([]);
});
