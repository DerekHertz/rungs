import { expect, test } from "vitest";
import { CLAIM_THRESHOLDS } from "../src/jev/claim-gate.ts";
import type { JudgedRecord } from "../src/jev/judged-types.ts";
import { countMarks } from "../src/judged-marks.ts";
import type { JudgedMark } from "../src/judged-marks.ts";
import { folds, markTier, markTierWhy, splitSettled } from "../src/judged-fold.ts";
import { standardLines } from "../src/standards-marks.ts";

const record = (verdict: JudgedRecord["verdict"], pick?: JudgedRecord["pick"]): JudgedRecord => ({
  tier: "judged",
  key: "claim:0",
  about: { claim: 0 },
  question: { id: "claim", version: "claim-v2" },
  shown: { state: { claim: "c" }, questions: {} },
  answers: { shown: { type: "yes-no", yes: 0.9995 }, contradicted: { type: "yes-no", yes: 0.0001 } },
  thresholds: CLAIM_THRESHOLDS,
  verdict,
  ...(pick === undefined ? {} : { pick }),
  model: "jev-1.14.0",
  inputTokens: 1200,
  usd: 0.0000504,
});
const judged = (verdict: JudgedRecord["verdict"], pick?: JudgedRecord["pick"]): JudgedMark => ({ kind: "judged", verdict, record: record(verdict, pick) });
const picked = { rule: 1, percent: 99.9, rank: 0 as const, why: ["effects reached: 2 kinds of call out", "stakes: possible harm, no vocabulary is stored"] };

test("only a settled mark of an adopted gate folds: flagged, undecided, not judged, judging and an untrusted settle stay open", () => {
  expect(folds(judged("settled"), true)).toBe(true);
  expect(folds(judged("settled"), false)).toBe(false);
  expect(folds(judged("flagged"), true)).toBe(false);
  expect(folds(judged("undecided"), true)).toBe(false);
  expect(folds({ kind: "not judged", reason: "off" }, true)).toBe(false);
  expect(folds({ kind: "pending" }, true)).toBe(false);
  expect(folds(undefined, true)).toBe(false);
});

test("folding keeps every item and the order of those left open, so the row's count is the same before and after", () => {
  const items = [
    { name: "a", mark: judged("flagged") },
    { name: "b", mark: judged("settled") },
    { name: "c", mark: judged("undecided") },
    { name: "d", mark: judged("settled") },
    { name: "e", mark: { kind: "not judged", reason: "x" } as JudgedMark },
  ];
  const { open, folded } = splitSettled(items, (item) => folds(item.mark, true));
  expect(open.map((item) => item.name)).toEqual(["a", "c", "e"]);
  expect(folded.map((item) => item.name)).toEqual(["b", "d"]);
  expect(open.length + folded.length).toBe(items.length);
  // The counts are over every item, folded or not.
  expect(countMarks(items.map((item) => item.mark))).toMatchObject({ settled: 2, flagged: 1, undecided: 1, notJudged: 1 });
  // Nothing judged reorders: with every item folded or none, the open list is the input in its own order.
  expect(splitSettled(items, () => false).open).toEqual(items);
  expect(splitSettled(items, () => false).folded).toEqual([]);
});

test("a mark says its tier and why; a record from before tiers, and a mark with no answer, say nothing", () => {
  expect(markTier(judged("settled", picked))).toBe("99.9%");
  expect(markTierWhy(judged("settled", picked))).toBe("tier 99.9%: effects reached: 2 kinds of call out; stakes: possible harm, no vocabulary is stored");
  expect(markTier(judged("settled"))).toBe("");
  expect(markTierWhy({ kind: "pending" })).toBe("");
  expect(markTier({ kind: "not judged", reason: "off" })).toBe("");
});

test("the Standards row's order does not depend on tiers: flagged first, then undecided, not judged, judging, settled, each in the server's order", () => {
  const standard = (key: string, verdict: JudgedRecord["verdict"]): JudgedRecord => ({ ...record(verdict, picked), key, about: { nodes: [] }, question: { id: "standard", version: "standard-v2" } });
  const document = { tier: "judged" as const, status: "on" as const, sets: [{ tier: "judged" as const, base: "b", head: "h", question: { id: "standard", version: "standard-v2" }, model: "m", records: [standard("1", "settled"), standard("2", "flagged"), standard("3", "undecided"), standard("4", "settled"), standard("5", "flagged")] }], notJudged: [], usd: 0, costUnknown: 0 };
  expect(standardLines(document).map((line) => line.key)).toEqual(["2", "5", "3", "1", "4"]);
});
