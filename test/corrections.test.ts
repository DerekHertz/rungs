import { expect, test } from "vitest";
import { certificationOf, correctionsDigest, effectOf, problemWithCertification, problemWithCorrections, vocabularyDigest } from "../src/corrections.ts";
import type { Certification, Correction } from "../src/corrections.ts";

const terms = [
  { key: "order", name: "orders" },
  { key: "payment", name: "payments" },
  { key: "refund", name: "refunds" },
];
const stamp = { by: "Ada", at: "2026-11-11T10:00:00.000Z" };
const confirm = (term: string): Correction => ({ ...stamp, kind: "confirm", term, label: term });
const rename = (term: string, name: string): Correction => ({ ...stamp, kind: "rename", term, name, label: term });
const merge = (term: string, into: string): Correction => ({ ...stamp, kind: "merge", term, into, label: term });
const remove = (term: string): Correction => ({ ...stamp, kind: "remove", term, label: term });
const member = (unit: string, term: string, belongs: boolean, at = stamp.at): Correction => ({ ...stamp, at, kind: "member", unit, term, belongs, label: unit });

test("with no corrections every stored term shows as itself", () => {
  const effect = effectOf(terms, []);
  expect([...effect.visible.keys()]).toEqual(["order", "payment", "refund"]);
  expect(effect.resolve("order")).toBe("order");
  expect(effect.sources("order")).toEqual(["order"]);
  expect(effect.inapplicable).toEqual([]);
});

test("a rename shows its new name, and keeps what it was called", () => {
  const effect = effectOf(terms, [rename("order", "purchases")]);
  expect(effect.visible.get("order")).toMatchObject({ name: "purchases", renamedFrom: "orders" });
});

test("a confirm marks the term with who and when", () => {
  expect(effectOf(terms, [confirm("order")]).visible.get("order")?.confirmed).toEqual(stamp);
});

test("a removed term does not show and resolves to nothing; a later confirm brings it back", () => {
  const removed = effectOf(terms, [remove("refund")]);
  expect(removed.visible.has("refund")).toBe(false);
  expect(removed.resolve("refund")).toBeUndefined();
  const back = effectOf(terms, [remove("refund"), confirm("refund")]);
  expect(back.visible.has("refund")).toBe(true);
});

test("a merged term shows as the term it was merged into, and that term lists both as its sources", () => {
  const effect = effectOf(terms, [merge("refund", "payment")]);
  expect(effect.visible.has("refund")).toBe(false);
  expect(effect.resolve("refund")).toBe("payment");
  expect(effect.sources("payment")).toEqual(["payment", "refund"]);
  expect(effect.visible.get("payment")?.mergedFrom).toEqual(["refunds"]);
});

test("a merge chain resolves to the last term, and a merge cycle is cut, never looped on", () => {
  const chain = effectOf(terms, [merge("refund", "payment"), merge("payment", "order")]);
  expect(chain.resolve("refund")).toBe("order");
  expect(chain.sources("order")).toEqual(["order", "payment", "refund"]);
  const cycle = effectOf(terms, [merge("refund", "payment"), merge("payment", "refund")]);
  expect(cycle.visible.size).toBeGreaterThan(0);
  expect(cycle.inapplicable.map((one) => one.why)).toContain("a merge loops back on itself");
});

test("a term merged into a removed term is removed with it", () => {
  const effect = effectOf(terms, [merge("refund", "payment"), remove("payment")]);
  expect(effect.resolve("refund")).toBeUndefined();
  expect(effect.visible.has("refund")).toBe(false);
});

test("a correction about a term the vocabulary no longer has is kept and reported as no longer applying", () => {
  const gone = [rename("vanished", "x"), merge("order", "vanished"), member("function:a.ts#a", "vanished", true)];
  const effect = effectOf(terms, gone);
  expect(effect.inapplicable.map((one) => [one.correction.kind, one.why])).toEqual([
    ["rename", "the term is no longer in the vocabulary"],
    ["merge", "the term it was merged into is no longer in the vocabulary"],
    ["member", "the term is no longer in the vocabulary"],
  ]);
  // The merge that cannot apply leaves the term as it was.
  expect(effect.visible.has("order")).toBe(true);
});

test("the latest correction of a pair wins", () => {
  const effect = effectOf(terms, [member("function:a.ts#a", "order", true), member("function:a.ts#a", "order", false, "2026-11-12T00:00:00.000Z")]);
  expect(effect.pairs.get("function:a.ts#a\0order")).toMatchObject({ belongs: false, at: "2026-11-12T00:00:00.000Z" });
});

test("corrections are checked whole: a record that is not shaped as one is a problem, never half trusted", () => {
  expect(problemWithCorrections([confirm("order"), rename("order", "x"), merge("a", "b"), remove("a"), member("u", "t", true)])).toBeUndefined();
  expect(problemWithCorrections("nope")).toBeDefined();
  expect(problemWithCorrections([{ ...confirm("order"), at: 5 }])).toBeDefined();
  expect(problemWithCorrections([{ ...stamp, kind: "teleport", term: "x", label: "x" }])).toBeDefined();
  expect(problemWithCorrections([{ ...member("u", "t", true), belongs: "yes" }])).toBeDefined();
  expect(problemWithCorrections([{ ...confirm("order"), at: "yesterday" }])).toBeDefined();
});

test("a certification is checked whole", () => {
  const whole: Certification = { ...stamp, vocabulary: "a", corrections: "b" };
  expect(problemWithCertification(whole)).toBeUndefined();
  expect(problemWithCertification({ ...whole, vocabulary: 1 })).toBeDefined();
  expect(problemWithCertification(undefined)).toBeUndefined();
});

/*
 * The rule: a vocabulary is certified when its certification records the terms (key, name, where written or
 * what a model said of them) and the corrections exactly as they are now, and nothing is incomplete (certify-completeness.test.ts). Any added correction, or any change in the terms, breaks
 * the match. A change in the corrections alone means drafted again; a change in the terms alone
 * (setup rebuilt them) is said as "certified ..., vocabulary changed since", never as plain certified.
 */
test("nobody has certified: drafted", () => {
  expect(certificationOf(terms, [], undefined)).toEqual({ kind: "drafted" });
});

test("certified when the terms and the corrections are what was certified, and says who and when", () => {
  const corrections = [confirm("order")];
  const certification: Certification = { by: "Grace", at: "2026-11-12T08:00:00.000Z", vocabulary: vocabularyDigest(terms), corrections: correctionsDigest(corrections) };
  expect(certificationOf(terms, corrections, certification)).toEqual({ kind: "certified", by: "Grace", at: "2026-11-12T08:00:00.000Z" });
});

test("any correction after certifying makes it drafted again, and says what was certified before", () => {
  const before = [confirm("order")];
  const certification: Certification = { by: "Grace", at: "2026-11-12T08:00:00.000Z", vocabulary: vocabularyDigest(terms), corrections: correctionsDigest(before) };
  expect(certificationOf(terms, [...before, rename("order", "x")], certification)).toEqual({ kind: "drafted", was: { by: "Grace", at: "2026-11-12T08:00:00.000Z" }, since: "corrections" });
});

test("a changed term list after certifying is 'vocabulary changed since', never plain certified", () => {
  const certification: Certification = { by: "Grace", at: "2026-11-12T08:00:00.000Z", vocabulary: vocabularyDigest(terms), corrections: correctionsDigest([]) };
  expect(certificationOf([...terms, { key: "cart", name: "carts" }], [], certification)).toEqual({ kind: "changed", by: "Grace", at: "2026-11-12T08:00:00.000Z" });
  // A term spelled differently is a term somebody did not see.
  expect(certificationOf([{ key: "order", name: "Orders" }, ...terms.slice(1)], [], certification).kind).toBe("changed");
  // Both changed: a correction was made, so it is drafted.
  expect(certificationOf([...terms, { key: "cart", name: "carts" }], [confirm("cart")], certification)).toMatchObject({ kind: "drafted", since: "corrections" });
});

test("the order of the terms does not matter to the digest, the content does", () => {
  expect(vocabularyDigest([...terms].reverse())).toBe(vocabularyDigest(terms));
  expect(vocabularyDigest(terms.slice(1))).not.toBe(vocabularyDigest(terms));
});
