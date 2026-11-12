import { expect, test } from "vitest";
import { CLAIM_THRESHOLDS, claimGate, describeThresholds, explainClaimVerdict } from "../src/jev/claim-gate.ts";
import type { JevAnswer } from "../src/jev/client.ts";
import { explainStandardVerdict, STANDARD_THRESHOLDS, standardGate } from "../src/jev/standard-gate.ts";
import { clearsTier, tierLevel } from "../src/tier-table.ts";

const yes = (value: number): JevAnswer => ({ type: "yes-no", yes: value });
const claim = (shown: number, contradicted: number, tier?: number) => claimGate.decide({ shown: yes(shown), contradicted: yes(contradicted) }, tier === undefined ? CLAIM_THRESHOLDS : { ...CLAIM_THRESHOLDS, tier: tierLevel(tier) });
const standard = (breaks: number, before: number, tier?: number) => standardGate.decide({ breaks: yes(breaks), before: yes(before) }, tier === undefined ? STANDARD_THRESHOLDS : { ...STANDARD_THRESHOLDS, tier: tierLevel(tier) });

test("a settle needs 1 - P(wrong) >= the tier, compared to a billionth, on the line included", () => {
  expect(tierLevel(99.9)).toBe(0.999);
  expect(tierLevel(95)).toBe(0.95);
  expect(clearsTier(0.001, 0.999)).toBe(true);
  expect(clearsTier(0.0011, 0.999)).toBe(false);
  expect(clearsTier(0.05, 0.95)).toBe(true);
  expect(clearsTier(0.0500001, 0.95)).toBe(false);
  // No tier (a record from before tiers): nothing more to clear. Not a number: never clears.
  expect(clearsTier(0.5, undefined)).toBe(true);
  expect(clearsTier(Number.NaN, 0.95)).toBe(false);
});

test("claim: a settle passes the gate's own limits, and then the tier on P(wrong) = (1 - shown) + contradicted", () => {
  // No tier: today's rule.
  expect(claim(0.9, 0.1)).toBe("settled");
  // Both pass the gate's own clear limits (shown >= 0.9, contradicted <= 0.1) at every tier; the tier is what differs.
  expect(claim(0.97, 0.02, 95)).toBe("settled"); // wrong at most 0.03 + 0.02 = 0.05
  expect(claim(0.97, 0.02, 99)).toBe("undecided");
  expect(claim(0.9995, 0.0004, 99.9)).toBe("settled"); // 0.0005 + 0.0004 = 0.0009
  expect(claim(0.998, 0.0004, 99.9)).toBe("undecided"); // 0.002 + 0.0004: passes the gate's limits, not the tier's
  // The tier never loosens the gate: a probability the gate would not settle is not settled at a loose tier.
  expect(claim(0.89, 0.02, 95)).toBe("undecided");
  expect(claim(0.99, 0.2, 95)).toBe("undecided");
});

test("claim: a tier never unsettles a flag, and never settles what cannot be read", () => {
  expect(claim(0.2, 0.5, 99.9)).toBe("flagged");
  expect(claim(0.2, 0.9, 95)).toBe("flagged");
  expect(claimGate.decide({ shown: yes(0.99999) }, { ...CLAIM_THRESHOLDS, tier: 0.95 })).toBe("undecided");
});

test("standard: P(wrong) is the chance the lines break the rule; the base question still has to be answered and clean", () => {
  expect(standard(0.1, 0.01)).toBe("settled");
  expect(standard(0.04, 0.01, 95)).toBe("settled");
  expect(standard(0.06, 0.01, 95)).toBe("undecided"); // passes clear <= 0.1, not 1 - 0.06 >= 0.95
  expect(standard(0.005, 0.01, 99)).toBe("settled");
  expect(standard(0.02, 0.01, 99)).toBe("undecided");
  expect(standard(0.0009, 0.01, 99.9)).toBe("settled");
  expect(standard(0.002, 0.01, 99.9)).toBe("undecided");
  // Flags and the base guard are the gate's own, whatever the tier.
  expect(standard(0.9, 0.01, 99.9)).toBe("flagged");
  expect(standard(0.0001, 0.7, 95)).toBe("undecided");
  expect(standardGate.decide({ breaks: yes(0.0001) }, { ...STANDARD_THRESHOLDS, tier: 0.95 })).toBe("undecided");
});

test("the words say the tier's rule, and say a settle held back by the tier is undecided for that reason", () => {
  const tiered = { ...CLAIM_THRESHOLDS, tier: 0.999 };
  expect(describeThresholds(tiered)).toMatch(/1 - P\(wrong\)/);
  expect(describeThresholds(tiered)).toMatch(/99\.9%/);
  expect(describeThresholds(CLAIM_THRESHOLDS)).not.toMatch(/tier/);
  const answers = { shown: yes(0.998), contradicted: yes(0.0004) };
  expect(explainClaimVerdict(answers, tiered, "undecided")).toMatch(/passes the gate's own limits but not the tier of 99\.9%/);
  expect(explainClaimVerdict({ shown: yes(0.9995), contradicted: yes(0.0004) }, tiered, "settled")).toMatch(/Settled/);
  const standardAnswers = { breaks: yes(0.06), before: yes(0.01) };
  expect(explainStandardVerdict(standardAnswers, { ...STANDARD_THRESHOLDS, tier: 0.95 }, "undecided")).toMatch(/not the tier of 95%/);
});
