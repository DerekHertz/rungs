import { expect, test } from "vitest";
import type { NodeId } from "../src/graph.ts";
import type { About, JudgedDocument, JudgedRecord } from "../src/jev/judged-types.ts";
import { STANDARD_THRESHOLDS } from "../src/jev/standard-gate.ts";
import { rateText } from "../src/jev/rate.ts";
import type { GateRate } from "../src/jev/rate.ts";
import { describeGateThresholds, explainVerdict, questionLabel } from "../src/jev/gate-words.ts";
import { standardLines, standardsSummary } from "../src/standards-marks.ts";
import type { StandardsDocument } from "../src/standards-marks.ts";

const about = (path: string, heading: string, file: string): About => ({
  nodes: [`file:${file}` as NodeId],
  standard: { rule: { path, heading, ancestors: [], lines: { start: 1, end: 3 }, edited: false }, hunk: { path: file, base: { start: 1, end: 4 }, head: { start: 1, end: 5 } } },
});
const record = (key: string, verdict: JudgedRecord["verdict"], breaks: number, before: number | null, over: Partial<JudgedRecord> = {}): JudgedRecord => ({
  tier: "judged",
  key,
  about: about("AGENTS.md", "Tests", `src/${key}.ts`),
  question: { id: "standard", version: "standard-v1" },
  shown: { state: { rule: "r" }, questions: {} },
  answers: { breaks: { type: "yes-no", yes: breaks }, ...(before === null ? {} : { before: { type: "yes-no" as const, yes: before } }) },
  thresholds: STANDARD_THRESHOLDS,
  verdict,
  model: "jev-1.14.0",
  inputTokens: 1000,
  usd: 0.00004,
  ...over,
});
const doc = (records: JudgedRecord[], notJudged: JudgedDocument["notJudged"] = []): JudgedDocument => ({
  tier: "judged",
  status: "on",
  sets: [{ tier: "judged", base: "b", head: "h", question: { id: "standard", version: "standard-v1" }, model: "jev-1.14.0", records }],
  notJudged,
  usd: 0,
  costUnknown: 0,
});
const found: StandardsDocument = { tier: "derived", tableVersion: 1, status: "found", rules: [{ path: "AGENTS.md", heading: "Tests", kind: "agent instructions", range: { start: 1, end: 3 }, edited: false, scope: "" }, { path: "AGENTS.md", heading: "Naming", kind: "agent instructions", range: { start: 4, end: 6 }, edited: true, scope: "" }], unread: [] };

test("lines come flagged first, then undecided, not judged and settled; each names its rule, hunk and probability", () => {
  const lines = standardLines(
    doc(
      [record("a", "settled", 0.01, 0.01), record("b", "flagged", 0.93, 0.02), record("c", "undecided", 0.3, 0.1)],
      [{ gate: "standard", key: "standard:file:x.bin", about: { nodes: ["file:x.bin" as NodeId] }, reason: "binary file" }],
    ),
  );
  expect(lines.map((line) => [line.key, line.mark.kind === "judged" ? line.mark.verdict : "not judged"])).toEqual([
    ["b", "flagged"],
    ["c", "undecided"],
    ["standard:file:x.bin", "not judged"],
    ["a", "settled"],
  ]);
  expect(lines[0]).toMatchObject({ breaks: 0.93, base: "new", rule: { path: "AGENTS.md", heading: "Tests" }, hunk: { path: "src/b.ts" }, nodes: ["file:src/b.ts"] });
});

test("a violation the base already had is told from a new one; an unanswered base question is unknown, never new", () => {
  const lines = standardLines(doc([record("old", "undecided", 0.9, 0.8), record("new", "flagged", 0.9, 0.05), record("noanswer", "flagged", 0.9, null)]));
  expect(Object.fromEntries(lines.map((line) => [line.key, line.base]))).toEqual({ old: "already", new: "new", noanswer: "unknown" });
});

test("the summary counts the marks number first, with the rules' count; none of them reads as none found while any is unasked", () => {
  const document = doc([record("a", "settled", 0.01, 0.01), record("b", "flagged", 0.93, 0.02), record("c", "settled", 0.01, 0.01)], [{ gate: "standard", key: "k", about: { nodes: [] }, reason: "binary file" }]);
  expect(standardsSummary(found, document, standardLines(document), true)).toBe("1 flagged, 2 settled, 1 not judged · 2 rules");
  expect(standardsSummary(found, document, standardLines(document), false)).toBe("1 flagged, 2 settled, 1 not judged · 2 rules (standard gate not adopted)");
  expect(standardsSummary(found, doc([]), [], true)).toBe("no hunk to judge · 2 rules");
});

test("with judging off the row reads not judged; unknown rules and no rules are said as they are", () => {
  const off: JudgedDocument = { tier: "judged", status: "off", reason: "judging is off", sets: [], notJudged: [], usd: 0, costUnknown: 0 };
  expect(standardsSummary(found, off, [], true)).toBe("2 rules, not judged");
  expect(standardsSummary(found, null, [], true)).toBe("2 rules, not judged");
  expect(standardsSummary({ ...found, status: "none", rules: [] }, off, [], true)).toBe("no written rules");
  expect(standardsSummary({ ...found, status: "unknown", rules: [], reason: "x" }, off, [], true)).toBe("rules could not be read");
  expect(standardsSummary(null, off, [], true)).toBeNull();
});

test("pending pairs read as judging, and rule files that could not be read are counted in", () => {
  const pending: JudgedDocument = { ...doc([record("a", "settled", 0.01, 0.01)]), status: "pending", pending: [{ gate: "standard", key: "p", about: about("AGENTS.md", "Tests", "src/p.ts") }] };
  const lines = standardLines(pending);
  expect(lines.map((line) => line.mark.kind)).toEqual(["pending", "judged"]);
  expect(standardsSummary(found, pending, lines, true)).toBe("1 settled, 1 judging… · 2 rules");
  expect(standardsSummary({ ...found, unread: ["docs/CONTRIBUTING.md"] }, pending, lines, true)).toContain("1 rule file not read");
});

test("the gate's words: its questions are labelled and its thresholds described from the record's own numbers", () => {
  expect(questionLabel("standard", "breaks")).toBe("Broken by the changed lines?");
  expect(questionLabel("claim", "shown")).toBe("Shown by the changed places?");
  expect(questionLabel("other", "x")).toBe("x");
  expect(describeGateThresholds("standard", STANDARD_THRESHOLDS)).toBe("Settled when broken is at most 10% and the base question was answered and is under 50% (the base's lines did not already break the rule). Flagged when broken is at least 50% and the base did not already break the rule (its answer under 50%, or missing: then it is flagged, not hidden). Otherwise undecided: that includes a clean-looking change whose base already broke the rule, or whose base answer is missing.");
});

test("the standard gate's rate is worded for hunks, not claims", () => {
  const rate: GateRate = {
    gate: "standard",
    version: "standard-v1",
    model: "jev-1.14.0",
    run: "2026-11-12-jev-1.14.0",
    counts: { cases: 10, good: 4, broken: 4, cannotTell: 2, steering: 2 },
    wrongPasses: 1,
    unclearPassed: 0,
    steeringPassed: 0,
    wrongFlags: 0,
    undecided: 1,
    notJudged: 0,
    changed: 0,
    usdPerCase: 0.00004,
    bar: [{ measure: "wrongPassRate", max: 0.05, got: 0.25, met: false }],
    blockers: [],
    adopted: false,
  };
  const text = rateText(rate);
  expect(text).toMatch(/^Standard gate: 1 wrong pass of 4 broken cases/);
  expect(text).toContain("not adopted");
  expect(text).toContain("a settled mark is not evidence that the change keeps the rule");
  expect(text).not.toMatch(/claim holds/);
});

test("a verdict is explained from the answers: undecided because the base already broke the rule, or because its answer is missing; flagged without a base answer says so", () => {
  const yes = (value: number) => ({ type: "yes-no" as const, yes: value });
  const explain = (answers: Record<string, ReturnType<typeof yes>>, verdict: "settled" | "flagged" | "undecided") => explainVerdict("standard", answers, STANDARD_THRESHOLDS, verdict);
  const already = explain({ breaks: yes(0.01), before: yes(0.9) }, "undecided");
  expect(already).toMatch(/undecided/i);
  expect(already).toMatch(/base.*already broke the rule \(90%\)/);
  expect(already).toMatch(/never settled/);
  const missing = explain({ breaks: yes(0.01) }, "undecided");
  expect(missing).toMatch(/undecided/i);
  expect(missing).toMatch(/base question has no answer/);
  expect(explain({ breaks: yes(0.9) }, "flagged")).toMatch(/flagged/i);
  expect(explain({ breaks: yes(0.9) }, "flagged")).toMatch(/no answer.*not hidden|not hidden/);
  expect(explain({ breaks: yes(0.9), before: yes(0.8) }, "undecided")).toMatch(/already broke the rule \(80%\).*not a new violation/);
  expect(explain({ breaks: yes(0.01), before: yes(0.01) }, "settled")).toMatch(/settled/i);
  expect(explain({ breaks: yes(0.3), before: yes(0.01) }, "undecided")).toMatch(/between/);
  expect(explainVerdict("claim", {}, {}, "settled")).toBe("");
});

