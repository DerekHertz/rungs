import { expect, test } from "vitest";
import { CLAIM_THRESHOLDS } from "../src/jev/claim-gate.ts";
import type { JudgedDocument, JudgedRecord } from "../src/jev/judged-types.ts";
import { claimMarks, costText, countMarks, countsText, judgedSummary } from "../src/judged-marks.ts";
import { claimsSummary } from "../src/review-summary.ts";

const record = (claim: number, verdict: JudgedRecord["verdict"]): JudgedRecord => ({
  tier: "judged",
  key: `claim:${claim}`,
  about: { claim },
  question: { id: "claim", version: "claim-v1" },
  shown: { state: { claim: "c" }, questions: {} },
  answers: { shown: { type: "yes-no", yes: 0.9 }, contradicted: { type: "yes-no", yes: 0.1 } },
  thresholds: CLAIM_THRESHOLDS,
  verdict,
  model: "jev-1.14.0",
  inputTokens: 1200,
  usd: 0.0000504,
});
const set = (records: JudgedRecord[]) => ({ tier: "judged" as const, base: "b", head: "h", question: { id: "claim", version: "claim-v1" }, model: "jev-1.14.0", records });
const on = (records: JudgedRecord[], notJudged: JudgedDocument["notJudged"] = []): JudgedDocument => ({ tier: "judged", status: "on", sets: [set(records)], notJudged, usd: 0, costUnknown: 0 });
const claims = [
  { index: 0, ids: ["file:a.ts"] },
  { index: 1, ids: ["file:b.ts"] },
  { index: 2, ids: ["file:c.ts"] },
  { index: 3, ids: [] },
  { index: 4, ids: ["file:d.ts"] },
];

test("each claim has its record's verdict, or not judged with the reason it has none", () => {
  const marks = claimMarks(on([record(0, "settled"), record(1, "flagged"), record(2, "undecided")], [{ gate: "claim", key: "claim:4", about: { claim: 4 }, reason: "Jev 500: down" }]), claims, true)!;
  expect([0, 1, 2].map((index) => marks.get(index))).toMatchObject([{ kind: "judged", verdict: "settled" }, { kind: "judged", verdict: "flagged" }, { kind: "judged", verdict: "undecided" }]);
  expect(marks.get(3)).toMatchObject({ kind: "not judged", reason: expect.stringMatching(/no changed place is linked/) });
  expect(marks.get(4)).toEqual({ kind: "not judged", reason: "Jev 500: down" });
  expect(claimMarks(on([]), [{ index: 0, ids: [] }], false)!.get(0)).toMatchObject({ reason: expect.stringMatching(/--link/) });
});

test("with judging off every claim reads not judged with the document's reason, and the summary adds nothing", () => {
  const off: JudgedDocument = { tier: "judged", status: "off", reason: "judging is off: pass --judge to send source text to TypeSafe", sets: [], notJudged: [], usd: 0, costUnknown: 0 };
  const marks = claimMarks(off, claims, true)!;
  expect([...marks.values()].every((mark) => mark.kind === "not judged" && mark.reason.includes("--judge"))).toBe(true);
  expect(judgedSummary(off, marks)).toBe("");
  expect(claimMarks(null, claims, true)).toBeNull();
  expect(claimsSummary("d", claims, "ok", 0, judgedSummary(off, marks))).toBe("4 of 5 linked");
});

test("the row summary counts the marks, number first, after the links", () => {
  const document = on([record(0, "settled"), record(1, "flagged"), record(2, "settled")]);
  const marks = claimMarks(document, claims, true)!;
  expect(countMarks(marks.values())).toEqual({ settled: 2, flagged: 1, undecided: 0, notJudged: 2 });
  expect(countsText(countMarks(marks.values()))).toBe("2 settled, 1 flagged, 2 not judged");
  expect(claimsSummary("d", claims, "ok", 0, judgedSummary(document, marks))).toBe("4 of 5 linked · 2 settled, 1 flagged, 2 not judged");
});

test("a cost the service did not report is unknown, never zero", () => {
  expect(costText(record(0, "settled"))).toBe("1,200 input tokens, $0.000050");
  expect(costText({ inputTokens: null, usd: null })).toBe("cost unknown");
});
