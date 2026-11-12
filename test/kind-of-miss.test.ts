import { expect, test } from "vitest";
import { CLAIM_GATE_ID, CLAIM_THRESHOLDS, claimGate } from "../src/jev/claim-gate.ts";
import type { JevAnswer } from "../src/jev/client.ts";
import type { JudgedRecord } from "../src/jev/judged-types.ts";
import { STANDARD_GATE_ID, STANDARD_THRESHOLDS, standardGate } from "../src/jev/standard-gate.ts";
import { kindOfMark, kindOfRecord, kindText } from "../src/kind-of-miss.ts";
import type { JudgedMark } from "../src/judged-marks.ts";
import { tierLevel } from "../src/tier-table.ts";

const yes = (value: number): JevAnswer => ({ type: "yes-no", yes: value });
const unreadable: JevAnswer = { type: "unreadable", raw: "maybe", why: "not a probability" };

/** A real record: the verdict comes from the gate's own decide, so a test cannot disagree with the gate. */
function claimRecord(answers: Record<string, JevAnswer>, tier?: number): JudgedRecord {
  const thresholds = tier === undefined ? CLAIM_THRESHOLDS : { ...CLAIM_THRESHOLDS, tier: tierLevel(tier) };
  return { tier: "judged", key: "claim:0", about: { claim: 0 }, question: { id: CLAIM_GATE_ID, version: "claim-v2" }, shown: { state: {}, questions: {} }, cut: [], answers, thresholds, verdict: claimGate.decide(answers, thresholds), model: "m", inputTokens: 1, usd: 0 };
}
function standardRecord(answers: Record<string, JevAnswer>, tier?: number): JudgedRecord {
  const thresholds = tier === undefined ? STANDARD_THRESHOLDS : { ...STANDARD_THRESHOLDS, tier: tierLevel(tier) };
  return { tier: "judged", key: "standard:0", about: { nodes: [] }, question: { id: STANDARD_GATE_ID, version: "standard-v2" }, shown: { state: {}, questions: {} }, cut: [], answers, thresholds, verdict: standardGate.decide(answers, thresholds), model: "m", inputTokens: 1, usd: 0 };
}
const claim = (shown: number, contradicted: number, tier?: number) => kindOfRecord(claimRecord({ shown: yes(shown), contradicted: yes(contradicted) }, tier));
const standard = (breaks: number, before: number, tier?: number) => kindOfRecord(standardRecord({ breaks: yes(breaks), before: yes(before) }, tier));

test("a settled item has no miss, so it has no kind", () => {
  expect(claim(0.99, 0.01)).toBeNull();
  expect(standard(0.01, 0.01)).toBeNull();
});

test("claim: a flag is contradicted", () => {
  expect(claim(0.2, 0.6)?.kind).toBe("contradicted");
  expect(claim(0.99, 0.5)?.kind).toBe("contradicted");
});

test("claim: more likely not shown than shown is ungrounded, even when it is also a little contradicted", () => {
  expect(claim(0.4, 0.02)?.kind).toBe("ungrounded");
  expect(claim(0.49, 0.02)?.kind).toBe("ungrounded");
  expect(claim(0.2, 0.3)?.kind).toBe("ungrounded");
});

test("claim: an even split between shown and not shown is a tie, so unknown, not ungrounded", () => {
  const found = claim(0.5, 0.01)!;
  expect(found.kind).toBe("unknown");
  expect(found.why).toMatch(/not sure/);
  expect(claim(0.5, 0.01, 99.9)?.kind).toBe("unknown");
});

test("claim: a probability in the middle band is Jev being unsure, so no kind is named", () => {
  // Between the settle limit and the flag line: not shown enough to settle but more likely shown, or contradicted a little.
  for (const found of [claim(0.85, 0.02), claim(0.6, 0.02), claim(0.97, 0.3), claim(0.6, 0.45), claim(0.97, 0.11)]) {
    expect(found?.kind).toBe("unknown");
    expect(found?.why).toMatch(/not sure/);
  }
});

test("claim: no check failed its own limit but the tier is not cleared is no miss found, never a kind", () => {
  const found = claim(0.97, 0.02, 99.9);
  expect(found?.kind).toBe("no miss found");
  expect(found?.why).toContain("99.9%");
  expect(claim(0.97, 0.02, 95)).toBeNull();
});

test("claim: an answer that cannot be read is unknown, never a kind", () => {
  expect(kindOfRecord(claimRecord({ shown: yes(0.1), contradicted: unreadable }))?.kind).toBe("unknown");
  expect(kindOfRecord(claimRecord({ shown: yes(0.1) }))?.kind).toBe("unknown");
  expect(kindOfRecord(claimRecord({}))?.kind).toBe("unknown");
});

test("an answer that is not a probability in 0..1 (a stored record can say anything) is unknown, never no miss found", () => {
  const nan = { type: "yes-no", yes: Number.NaN } satisfies JevAnswer;
  expect(kindOfRecord({ ...claimRecord({ shown: yes(0.2), contradicted: yes(0.2) }), answers: { shown: nan, contradicted: yes(0.01) } })?.kind).toBe("unknown");
  expect(kindOfRecord({ ...claimRecord({ shown: yes(0.2), contradicted: yes(0.2) }), answers: { shown: yes(1.5), contradicted: yes(0.01) } })?.kind).toBe("unknown");
  expect(kindOfRecord({ ...standardRecord({ breaks: yes(0.02), before: yes(0.1) }, 99.9), answers: { breaks: nan, before: yes(0.1) } })?.kind).toBe("unknown");
  expect(kindOfRecord({ ...standardRecord({ breaks: yes(0.02), before: yes(0.1) }, 99.9), answers: { breaks: yes(0.02), before: nan } })?.kind).toBe("unknown");
});

test("standard: a new violation is flagged and breaks a standard", () => {
  expect(standard(0.8, 0.1)?.kind).toBe("breaks a standard");
  expect(standard(0.8, 0.1)?.why).toContain("new");
});

test("standard: a violation the base already had is still breaks a standard, and says it is old", () => {
  const found = standard(0.8, 0.9);
  expect(found?.kind).toBe("breaks a standard");
  expect(found?.why).toMatch(/already/);
});

test("standard: a change in the middle band is Jev being unsure, so no kind is named, and the chance is in the words", () => {
  const found = standard(0.3, 0.1);
  expect(found?.kind).toBe("unknown");
  expect(found?.why).toContain("30%");
  expect(standard(0.11, 0.1)?.kind).toBe("unknown");
});

test("standard: clean lines held back by the tier is no miss found", () => {
  expect(standard(0.02, 0.1, 99.9)?.kind).toBe("no miss found");
  expect(standard(0.02, 0.1, 95)).toBeNull();
});

test("standard: clean-looking lines whose base answer is missing, or whose base already broke the rule, are unknown", () => {
  expect(kindOfRecord(standardRecord({ breaks: yes(0.02) }))?.kind).toBe("unknown");
  expect(kindOfRecord(standardRecord({ breaks: yes(0.02), before: unreadable }))?.kind).toBe("unknown");
  expect(standard(0.02, 0.9)?.kind).toBe("unknown");
});

test("standard: an unreadable breaks answer is unknown, and a flag with a missing base answer still breaks a standard", () => {
  expect(kindOfRecord(standardRecord({ breaks: unreadable, before: yes(0.1) }))?.kind).toBe("unknown");
  expect(kindOfRecord(standardRecord({ breaks: yes(0.9) }))?.kind).toBe("breaks a standard");
});

test("a gate this page does not classify gives unknown, and a settled one of them still none", () => {
  const other = { ...claimRecord({ shown: yes(0.1), contradicted: yes(0.1) }), question: { id: "membership", version: "m-v1" } };
  expect(kindOfRecord(other)?.kind).toBe("unknown");
  expect(kindOfRecord({ ...other, verdict: "settled" })).toBeNull();
});

test("a mark: judged reads its record, not judged and judging are unknown with why, and a settled mark has no kind", () => {
  const judged = (record: JudgedRecord): JudgedMark => ({ kind: "judged", verdict: record.verdict, record });
  expect(kindOfMark(judged(claimRecord({ shown: yes(0.2), contradicted: yes(0.01) })))?.kind).toBe("ungrounded");
  expect(kindOfMark(judged(claimRecord({ shown: yes(0.99), contradicted: yes(0.01) })))).toBeNull();
  expect(kindOfMark({ kind: "not judged", reason: "no key" })).toEqual({ kind: "unknown", why: "not judged: no key" });
  expect(kindOfMark({ kind: "pending" })?.kind).toBe("unknown");
});

test("the words: a kind says its name and why, and unknown says it is unknown", () => {
  expect(kindText({ kind: "ungrounded", why: "shown 40%" })).toBe("ungrounded");
  expect(kindText({ kind: "unknown", why: "not judged: no key" })).toBe("kind unknown");
  expect(kindText({ kind: "no miss found", why: "x" })).toBe("no miss found");
});

const cutBy = (record: JudgedRecord, ...cut: string[]): JudgedRecord => ({ ...record, cut });

test("a record that says nothing was left out is read as whole, and one with no cut says nothing, so it is read as cut", () => {
  const held = claimRecord({ shown: yes(0.97), contradicted: yes(0.02) }, 99.9);
  expect(kindOfRecord(held)?.kind).toBe("no miss found");
  const { cut, ...undated } = held;
  void cut;
  const found = kindOfRecord(undated)!;
  expect(found.kind).toBe("unknown");
  expect(found.why).toMatch(/does not say/);
  expect(kindOfRecord({ ...claimRecord({ shown: yes(0.2), contradicted: yes(0.01) }), cut: undefined })?.kind).toBe("unknown");
});

test("claim: not shown over cut evidence is unknown, never ungrounded, and says what was cut", () => {
  const ungrounded = claimRecord({ shown: yes(0.2), contradicted: yes(0.01) });
  expect(kindOfRecord(ungrounded)?.kind).toBe("ungrounded");
  const found = kindOfRecord(cutBy(ungrounded, "40 changed lines of altered src/a.ts were cut"))!;
  expect(found.kind).toBe("unknown");
  expect(found.why).toContain("40 changed lines");
});

test("a flag or a contradiction seen stays its kind even when more was cut", () => {
  expect(kindOfRecord(cutBy(claimRecord({ shown: yes(0.2), contradicted: yes(0.8) }), "x"))?.kind).toBe("contradicted");
  expect(kindOfRecord(cutBy(standardRecord({ breaks: yes(0.9), before: yes(0.1) }), "x"))?.kind).toBe("breaks a standard");
});

test("held back by the tier over cut evidence is unknown, not no miss found, for both gates", () => {
  expect(kindOfRecord(cutBy(claimRecord({ shown: yes(0.97), contradicted: yes(0.02) }, 99.9), "x"))?.kind).toBe("unknown");
  expect(kindOfRecord(cutBy(standardRecord({ breaks: yes(0.02), before: yes(0.1) }, 99.9), "x"))?.kind).toBe("unknown");
});
