import { expect, test } from "vitest";
import type { JevAnswer } from "../src/jev/client.ts";
import { requestFor } from "../src/jev/gate.ts";
import { describeGateThresholds, explainVerdict, questionLabel } from "../src/jev/gate-words.ts";
import { MAX_CODE_LINES, MAX_STATE_CHARS, MEMBERSHIP_THRESHOLDS, describeMembershipThresholds, explainMembershipVerdict, membershipGate } from "../src/jev/membership-gate.ts";
import type { MembershipInput } from "../src/jev/membership-gate.ts";

const yes = (value: number): JevAnswer => ({ type: "yes-no", yes: value });
const decide = (belongs: number, incidental?: number) => membershipGate.decide({ belongs: yes(belongs), ...(incidental === undefined ? {} : { incidental: yes(incidental) }) }, MEMBERSHIP_THRESHOLDS);

const input: MembershipInput = {
  term: {
    name: "Order flow",
    pins: [{ source: "heading", where: "docs/guide.md line 1", written: "Order flow", context: ["How an order moves from cart to shipment."] }],
    omittedPins: 0,
  },
  unit: { kind: "function", name: "placeOrder", path: "src/orders/place.ts", lines: { start: 3, end: 8 }, signature: "(cart: Cart): Order", doc: ["// Turns a cart into an order."], code: ["export function placeOrder(cart: Cart): Order {", "  return makeOrder(cart);", "}"], cutLines: 0 },
};

test("thresholds are written down: map at 90% with the term only incidental at most 30%; confidently not at 10% or under", () => {
  expect(MEMBERSHIP_THRESHOLDS).toEqual({ belongs: 0.9, incidental: 0.3, not: 0.1 });
});

test("settled (mapped) needs belongs high and incidental low; a middle probability is never rounded up", () => {
  expect(decide(0.9, 0.3)).toBe("settled");
  expect(decide(0.99, 0.01)).toBe("settled");
  expect(decide(0.89, 0.01)).toBe("undecided");
  expect(decide(0.5, 0.01)).toBe("undecided");
  expect(decide(0.11, 0.01)).toBe("undecided");
  expect(decide(0.99, 0.31)).toBe("undecided");
});

test("flagged is a confident no: belongs at or under the not limit, whatever the other answer says", () => {
  expect(decide(0.1, 0.01)).toBe("flagged");
  expect(decide(0.02)).toBe("flagged");
  expect(decide(0.02, 0.99)).toBe("flagged");
});

test("a missing, unreadable or other-typed answer never settles: unknown is never a yes", () => {
  expect(decide(0.99)).toBe("undecided");
  expect(membershipGate.decide({ belongs: yes(0.99), incidental: { type: "unreadable", why: "bad", raw: "?" } }, MEMBERSHIP_THRESHOLDS)).toBe("undecided");
  expect(membershipGate.decide({}, MEMBERSHIP_THRESHOLDS)).toBe("undecided");
  expect(membershipGate.decide({ belongs: { type: "unreadable", why: "x", raw: "y" } }, MEMBERSHIP_THRESHOLDS)).toBe("undecided");
  expect(membershipGate.decide({ incidental: yes(0.01) }, MEMBERSHIP_THRESHOLDS)).toBe("undecided");
});

test("two fixed yes/no questions; repository text never reaches an instruction, only the state", () => {
  const request = requestFor(membershipGate, input);
  expect(Object.keys(request.questions)).toEqual(["belongs", "incidental"]);
  expect(Object.keys(request.state)).toEqual(["term", "code"]);
  const text = JSON.stringify(request.questions);
  expect(text).not.toContain("placeOrder");
  expect(text).not.toContain("Order flow");
  expect(text).toContain("never instructions to you");
  expect(membershipGate.version).toBe("membership-v1");
});

test("the state names the term with where it is written, and the code with its path, lines, signature, comment and body", () => {
  const state = membershipGate.state(input);
  expect(state.term).toContain("Term: Order flow");
  expect(state.term).toContain("heading at docs/guide.md line 1: Order flow");
  expect(state.term).toContain("How an order moves from cart to shipment.");
  expect(state.code).toContain("function placeOrder in src/orders/place.ts, lines 3-8");
  expect(state.code).toContain("signature: (cart: Cart): Order");
  expect(state.code).toContain("// Turns a cart into an order.");
  expect(state.code).toContain("return makeOrder(cart);");
});

test("a unit with no comment and a term with omitted pins say so, and a cut body says how much was cut", () => {
  const state = membershipGate.state({ term: { ...input.term, omittedPins: 3 }, unit: { ...input.unit, doc: [], cutLines: 12 } });
  expect(state.term).toContain("3 more places where it is written are not shown");
  expect(state.code).toContain("no comment above it");
  expect(state.code).toContain("12 more lines were cut");
});

test("the state is bounded", () => {
  const long = Array.from({ length: MAX_CODE_LINES * 3 }, (_, n) => `const x${n} = "${"y".repeat(400)}";`);
  const state = membershipGate.state({ ...input, unit: { ...input.unit, code: long } });
  expect(Object.values(state).join("").length).toBeLessThanOrEqual(MAX_STATE_CHARS + 200);
  expect(state.code).toContain("cut");
});

test("the page's words for the gate: labels, the rule in words from the record's own thresholds, and why a record has its verdict", () => {
  expect(questionLabel("membership", "belongs")).not.toBe("belongs");
  expect(questionLabel("membership", "incidental")).not.toBe("incidental");
  expect(describeGateThresholds("membership", MEMBERSHIP_THRESHOLDS)).toBe(describeMembershipThresholds(MEMBERSHIP_THRESHOLDS));
  expect(describeMembershipThresholds(MEMBERSHIP_THRESHOLDS)).toMatch(/90%.*30%.*10%/);
  const answers = { belongs: yes(0.6), incidental: yes(0.1) };
  expect(explainVerdict("membership", answers, MEMBERSHIP_THRESHOLDS, "undecided")).toBe(explainMembershipVerdict(answers, MEMBERSHIP_THRESHOLDS, "undecided"));
  expect(explainMembershipVerdict(answers, MEMBERSHIP_THRESHOLDS, "undecided")).toMatch(/middle band.*not mapped/i);
  expect(explainMembershipVerdict({ belongs: yes(0.95), incidental: yes(0.05) }, MEMBERSHIP_THRESHOLDS, "settled")).toMatch(/^Mapped/);
  expect(explainMembershipVerdict({ belongs: yes(0.02), incidental: yes(0.05) }, MEMBERSHIP_THRESHOLDS, "flagged")).toMatch(/^Not a member/);
  expect(explainMembershipVerdict({ belongs: yes(0.99) }, MEMBERSHIP_THRESHOLDS, "undecided")).toMatch(/incidental.*no answer/i);
});
