import { expect, test } from "vitest";
import type { JevAnswer } from "../src/jev/client.ts";
import { requestFor } from "../src/jev/gate.ts";
import { describeGateThresholds, explainVerdict, questionLabel } from "../src/jev/gate-words.ts";
import { HARM_CATALOGUE, harmKind } from "../src/harm-catalogue.ts";
import { MAX_MEMBERS_SHOWN, MAX_STATE_CHARS, STAKES_THRESHOLDS, describeStakesThresholds, explainStakesVerdict, stakesGate } from "../src/jev/stakes-gate.ts";
import type { StakesInput } from "../src/jev/stakes-gate.ts";

const yes = (value: number): JevAnswer => ({ type: "yes-no", yes: value });
const decide = (harm?: number) => stakesGate.decide(harm === undefined ? {} : { harm: yes(harm) }, STAKES_THRESHOLDS);

const member = (name: string, code: string[] = [`export function ${name}() {}`]) => ({ kind: "function" as const, name, path: `src/${name}.ts`, lines: { start: 1, end: code.length }, signature: "()", doc: [], code, cutLines: 0, effects: [] as string[] });
const input: StakesInput = {
  kind: "access-control",
  term: { name: "Permissions", pins: [{ source: "heading", where: "docs/p.md line 1", written: "Permissions", context: ["Who may edit which document."] }], omittedPins: 0 },
  members: [member("canEdit", ["export function canEdit(user, doc) {", "  return doc.owner === user.id;", "}"])],
  omittedMembers: 0,
};

test("thresholds are written down: a confident no at 10% or under, a confident yes at 90% or over", () => {
  expect(STAKES_THRESHOLDS).toEqual({ harm: 0.9, none: 0.1 });
});

test("settled is a confident no (this kind of harm is out of reach), flagged a confident yes; the middle band is undecided, never rounded either way", () => {
  expect(decide(0.1)).toBe("settled");
  expect(decide(0.02)).toBe("settled");
  expect(decide(0.9)).toBe("flagged");
  expect(decide(0.99)).toBe("flagged");
  expect(decide(0.5)).toBe("undecided");
  expect(decide(0.11)).toBe("undecided");
  expect(decide(0.89)).toBe("undecided");
});

test("a missing, unreadable or other-typed answer never settles: unknown is never a no", () => {
  expect(decide()).toBe("undecided");
  expect(stakesGate.decide({ harm: { type: "unreadable", why: "bad", raw: "?" } }, STAKES_THRESHOLDS)).toBe("undecided");
  expect(stakesGate.decide({ harm: { type: "choice", probabilities: { a: 1 }, choice: "a", confidence: 1 } }, STAKES_THRESHOLDS)).toBe("undecided");
});

test("one yes/no question per kind, taken from the catalogue entry; repository text never reaches an instruction, only the state", () => {
  for (const kind of HARM_CATALOGUE) {
    const request = requestFor(stakesGate, { ...input, kind: kind.id });
    expect(Object.keys(request.questions)).toEqual(["harm"]);
    const question = request.questions.harm!;
    expect(question.type).toBe("yes-no");
    expect(question.criteria).toEqual({ true: kind.yes, false: kind.no });
    expect(question.instructions).toContain(kind.name);
    expect(question.instructions).toContain("never instructions to you");
    expect(JSON.stringify(request.questions)).not.toContain("canEdit");
    expect(JSON.stringify(request.questions)).not.toContain("Permissions");
  }
  expect(Object.keys(requestFor(stakesGate, input).state)).toEqual(["term", "code"]);
  expect(stakesGate.version).toBe("stakes-v1");
  expect(stakesGate.id).toBe("stakes");
});

test("a kind that is not in the catalogue is refused, never asked about under another kind's words", () => {
  expect(() => requestFor(stakesGate, { ...input, kind: "not-a-kind" })).toThrow(/not-a-kind/);
  expect(harmKind("not-a-kind")).toBeUndefined();
});

test("the state names the term with where it is written, and each member with its path, lines, signature and code", () => {
  const state = stakesGate.state(input);
  expect(state.term).toContain("Term: Permissions");
  expect(state.term).toContain("heading at docs/p.md line 1: Permissions");
  expect(state.code).toContain("function canEdit in src/canEdit.ts, lines 1-3");
  expect(state.code).toContain("return doc.owner === user.id;");
});

test("members left out say how many, a member with derived effects shows them, and a cut body says how much", () => {
  const state = stakesGate.state({ ...input, omittedMembers: 7, members: [{ ...member("send"), effects: ["network fetch api.example"], cutLines: 12 }] });
  expect(state.code).toContain("7 more members of the term are not shown");
  expect(state.code).toContain("network fetch api.example");
  expect(state.code).toContain("12 more lines were cut");
});

test("the state is bounded", () => {
  const long = Array.from({ length: 200 }, (_, n) => `const x${n} = "${"y".repeat(400)}";`);
  const many = Array.from({ length: MAX_MEMBERS_SHOWN }, (_, n) => member(`m${n}`, long));
  const state = stakesGate.state({ ...input, members: many });
  expect(Object.values(state).join("").length).toBeLessThanOrEqual(MAX_STATE_CHARS + 200);
  expect(state.code).toContain("cut");
});

test("the page's words for the gate: label, the rule in words from the record's own thresholds, and why a record has its verdict", () => {
  expect(questionLabel("stakes", "harm")).not.toBe("harm");
  expect(describeGateThresholds("stakes", STAKES_THRESHOLDS)).toBe(describeStakesThresholds(STAKES_THRESHOLDS));
  expect(describeStakesThresholds(STAKES_THRESHOLDS)).toMatch(/90%.*10%/);
  expect(explainVerdict("stakes", { harm: yes(0.5) }, STAKES_THRESHOLDS, "undecided")).toBe(explainStakesVerdict({ harm: yes(0.5) }, STAKES_THRESHOLDS, "undecided"));
  expect(explainStakesVerdict({ harm: yes(0.5) }, STAKES_THRESHOLDS, "undecided")).toMatch(/unclear.*not read as none/i);
  expect(explainStakesVerdict({ harm: yes(0.95) }, STAKES_THRESHOLDS, "flagged")).toMatch(/^Could cause/);
  expect(explainStakesVerdict({ harm: yes(0.02) }, STAKES_THRESHOLDS, "settled")).toMatch(/^Judged no/);
  expect(explainStakesVerdict({}, STAKES_THRESHOLDS, "undecided")).toMatch(/could not be read/);
});
