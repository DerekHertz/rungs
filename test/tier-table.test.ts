import { expect, test } from "vitest";
import { COMPLEXITY_CUTOFFS, DEFAULT_TIERS, TIER_RULE_VERSION, complexityRank, parseTiers, pickTier, stakesRank, tierText, unknownTier } from "../src/tier-table.ts";
import type { ComplexityFacts, StakesFacts } from "../src/tier-table.ts";

const small: ComplexityFacts = { blastRadius: 0, unreadMayRest: 0, effects: 0, lines: 5 };
const none: StakesFacts = { status: "none", terms: ["order"] };

test("the default table is 99.9 / 99 / 95, strictest first, and the rule is versioned", () => {
  expect(DEFAULT_TIERS).toEqual([99.9, 99, 95]);
  expect(TIER_RULE_VERSION).toBe(1);
  expect(COMPLEXITY_CUTOFFS).toEqual({ strict: { effects: 1, blastRadius: 10, lines: 200 }, middle: { blastRadius: 3, lines: 40 } });
});

test("parseTiers takes three descending numbers in (0, 100) and says what is wrong otherwise", () => {
  expect(parseTiers("99.9,99,95")).toEqual([99.9, 99, 95]);
  expect(parseTiers(" 99.99 , 99.5 , 80 ")).toEqual([99.99, 99.5, 80]);
  for (const bad of ["99.9,99", "99.9,99,95,90", "95,99,99.9", "99,99,95", "100,99,95", "99.9,99,0", "x,y,z", "", "99.9,,95", "99.9;99;95", "1e2,99,95", "99.9,99,-5"]) expect(parseTiers(bad), bad).toMatch(/^invalid --tiers/);
});

test("complexity: any effect, a blast radius of ten, two hundred lines, or lines not known are the strictest; three files or forty lines the middle; the rest the loosest", () => {
  const rank = (facts: Partial<ComplexityFacts>): number => complexityRank({ ...small, ...facts }).rank;
  expect(rank({})).toBe(2);
  expect(rank({ effects: 1 })).toBe(0);
  expect(rank({ blastRadius: 9 })).toBe(1);
  expect(rank({ blastRadius: 10 })).toBe(0);
  expect(rank({ blastRadius: 2 })).toBe(2);
  expect(rank({ blastRadius: 3 })).toBe(1);
  expect(rank({ lines: 39 })).toBe(2);
  expect(rank({ lines: 40 })).toBe(1);
  expect(rank({ lines: 199 })).toBe(1);
  expect(rank({ lines: 200 })).toBe(0);
  // Unknown is never small: lines not known is strict, and unread files that may rest on it count toward the radius.
  expect(rank({ lines: null })).toBe(0);
  expect(rank({ blastRadius: 2, unreadMayRest: 1 })).toBe(1);
  expect(rank({ blastRadius: 5, unreadMayRest: 5 })).toBe(0);
});

test("stakes: only a complete judged none is loose; could cause and every unknown state are the strictest", () => {
  expect(stakesRank(none).rank).toBe(2);
  expect(stakesRank({ status: "could cause", harms: ["money in payment"] }).rank).toBe(0);
  expect(stakesRank({ status: "possible", reason: "no vocabulary is stored" }).rank).toBe(0);
});

test("the strictest of complexity and stakes decides, and the pick says which of them did", () => {
  expect(pickTier(small, none)).toMatchObject({ percent: 95, rank: 2, rule: 1 });
  expect(pickTier({ ...small, lines: 60 }, none)).toMatchObject({ percent: 99, rank: 1 });
  expect(pickTier({ ...small, effects: 2 }, none)).toMatchObject({ percent: 99.9, rank: 0 });
  const stakes = pickTier(small, { status: "could cause", harms: ["money in payment"] });
  expect(stakes).toMatchObject({ percent: 99.9, rank: 0, why: ["stakes: could cause harm in money in payment"] });
  const both = pickTier({ ...small, effects: 2 }, { status: "possible", reason: "no vocabulary is stored" });
  expect(both.why).toEqual(["effects reached: 2 kinds of call out", "stakes: possible harm, no vocabulary is stored"]);
  expect(tierText(both)).toBe("tier 99.9%: effects reached: 2 kinds of call out; stakes: possible harm, no vocabulary is stored");
  // A middle complexity with loose stakes reads as the complexity; the loose stakes do not hide it.
  expect(pickTier({ ...small, blastRadius: 4 }, none).why).toEqual(["blast radius: 4 files rest on it"]);
});

test("a reviewer's table changes the percents, never the rank", () => {
  expect(pickTier(small, none, [99.99, 99.5, 90]).percent).toBe(90);
  expect(pickTier({ ...small, lines: 60 }, none, [99.99, 99.5, 90]).percent).toBe(99.5);
  expect(pickTier({ ...small, effects: 1 }, none, [99.99, 99.5, 90]).percent).toBe(99.99);
});

test("a caller that knows nothing of an item gets the strictest tier, never the loosest", () => {
  expect(unknownTier({ ids: [] })).toMatchObject({ percent: 99.9, rank: 0 });
});
