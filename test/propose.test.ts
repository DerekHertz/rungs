import { expect, test } from "vitest";
import { extract } from "../src/extract/extract.ts";
import type { FileTree } from "../src/graph.ts";
import { narrow, unitsOf } from "../src/jev/membership-source.ts";
import { membershipGate, termText } from "../src/jev/membership-gate.ts";
import { termFacts } from "../src/jev/membership-source.ts";
import { MAX_FILES_SHOWN, MAX_NAMES_PER_FILE, MAX_PROPOSED, needsFallback, ownCoverage, problemWithProposals, proposalAsk, readProposals, withProposed } from "../src/propose.ts";
import type { ReadContext, StoredProposals } from "../src/propose.ts";
import { collectVocabulary, keyOf } from "../src/vocabulary.ts";
import type { Term } from "../src/vocabulary.ts";

const DATE = keyOf("Date arithmetic");
const treeOf = (files: Record<string, string>): FileTree => new Map(Object.entries(files));
const fn = (name: string): string => `export function ${name}() {}\n`;

function analyse(files: Record<string, string>) {
  const tree = treeOf(files);
  const graph = extract(tree);
  const vocabulary = collectVocabulary({ graph, tree });
  const units = unitsOf(graph, tree);
  return { tree, graph, vocabulary, units, narrowed: narrow(units, vocabulary.terms, tree) };
}

test("fewer than half: the fallback applies; exactly half or more: it does not; no code at all: it does not", () => {
  expect(needsFallback({ of: 10, mapped: 4 })).toBe(true);
  expect(needsFallback({ of: 10, mapped: 5 })).toBe(false);
  expect(needsFallback({ of: 10, mapped: 6 })).toBe(false);
  expect(needsFallback({ of: 3, mapped: 1 })).toBe(true);
  expect(needsFallback({ of: 2, mapped: 1 })).toBe(false);
  expect(needsFallback({ of: 1, mapped: 0 })).toBe(true);
  expect(needsFallback({ of: 0, mapped: 0 })).toBe(false);
});

test("own coverage counts a file as mapped when a function in it shares a word with a term the repository wrote", () => {
  const found = analyse({ "docs/a.md": "# Billing\n", "src/billing.js": fn("sendBill"), "src/zz.js": fn("qq"), "src/yy.js": fn("rr") });
  expect(ownCoverage(found.graph, found.units, found.narrowed)).toEqual({ of: 3, mapped: 1 });
});

test("a repository with no code files has coverage of zero over zero, and the fallback does not apply", () => {
  const found = analyse({ "README.md": "# Notes\n\ntext\n" });
  const coverage = ownCoverage(found.graph, found.units, found.narrowed);
  expect(coverage).toEqual({ of: 0, mapped: 0 });
  expect(needsFallback(coverage)).toBe(false);
});

const context = (over: Partial<ReadContext> = {}): ReadContext => ({ shown: new Map([["lib/a.js", "lib/a.js"], ["lib/b.js", "lib/b.js"]]), ownKeys: new Set(["order"]), rejected: new Set(), ...over });
const good = { name: "Date arithmetic", description: "Works out days between dates.", files: ["lib/a.js"] };

test("a proposed term is a Term with a claimed description and the files it named, and no pins", () => {
  const { terms, dropped } = readProposals({ terms: [good] }, context());
  expect(terms).toEqual([{ key: DATE, name: "Date arithmetic", spellings: ["Date arithmetic"], pins: [], claimed: { description: "Works out days between dates.", files: ["lib/a.js"] } }]);
  expect(Object.values(dropped).every((count) => count === 0)).toBe(true);
});

test("a proposal that is the same concept as a term the repository wrote, or as another proposal, is counted and dropped", () => {
  const { terms, dropped } = readProposals({ terms: [{ ...good, name: "Orders" }, good, { ...good, name: "date  arithmetics" }] }, context());
  expect(terms.map((term) => term.name)).toEqual(["Date arithmetic"]);
  expect(dropped.duplicate).toBe(2);
});

test("a term a person rejected is not taken up", () => {
  const { terms, dropped } = readProposals({ terms: [good] }, context({ rejected: new Set([DATE]) }));
  expect(terms).toEqual([]);
  expect(dropped.rejected).toBe(1);
});

test("files the model was not shown are counted, and a term that names none it was shown is dropped", () => {
  const { terms, dropped } = readProposals({ terms: [{ ...good, files: ["lib/a.js", "lib/nowhere.js"] }, { ...good, name: "Slugs", files: ["lib/nowhere.js"] }] }, context());
  expect(terms.map((term) => term.claimed?.files)).toEqual([["lib/a.js"]]);
  expect(dropped).toMatchObject({ unknownFiles: 2, noFile: 1 });
});

test("a generic or too-short name, a name or description shaped like a secret, and an empty description are not usable", () => {
  const secret = `ghp_${"a1B2c3D4e5F6g7H8i9J0"}`;
  const { terms, dropped } = readProposals({ terms: [{ ...good, name: "Utils" }, { ...good, name: "ab" }, { ...good, name: secret }, { ...good, name: "Fine name", description: secret }, { ...good, name: "Blank", description: "  " }, { ...good, name: "one two three four five six" }] }, context());
  expect(terms).toEqual([]);
  expect(dropped.unusable).toBe(6);
});

test("more terms than the limit are counted, never silently gone", () => {
  const many = Array.from({ length: MAX_PROPOSED + 3 }, (_, i) => ({ ...good, name: `Concept ${["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima", "mike", "nancy", "oscar"][i]}` }));
  const { terms, dropped } = readProposals({ terms: many }, context());
  expect(terms).toHaveLength(MAX_PROPOSED);
  expect(dropped.overLimit).toBe(3);
});

test("an answer with no list of terms, and an answer whose every term is malformed, fail; an empty list is an answer of no terms", () => {
  expect(() => readProposals(undefined, context())).toThrow(/no list of terms/);
  expect(() => readProposals({ terms: "x" }, context())).toThrow(/no list of terms/);
  expect(() => readProposals({ terms: [{ name: 3 }, null, { name: "x", description: "d", files: "no" }] }, context())).toThrow(/malformed/);
  expect(readProposals({ terms: [] }, context())).toMatchObject({ terms: [] });
  // One malformed term among usable ones is counted, not a failed call.
  expect(readProposals({ terms: [{ name: 3 }, good] }, context())).toMatchObject({ dropped: { unusable: 1 } });
});

test("the model is shown paths and names and the repository's words, never source text, and a path with a secret-shaped part is not shown", () => {
  const secret = `ghp_${"a1B2c3D4e5F6g7H8i9J0"}`;
  const found = analyse({ "docs/a.md": "# Billing\n", "lib/a.js": "export function sendBill() {\n  return 'SOURCE-TEXT-MARKER';\n}\n", [`lib/${secret}.js`]: fn("leak") });
  const ask = proposalAsk({ graph: found.graph, units: found.units, own: found.vocabulary.terms, rejectedNames: [] });
  expect(ask.user).toContain("lib/a.js: sendBill");
  expect(ask.user).toContain("Billing");
  expect(ask.user).not.toContain("SOURCE-TEXT-MARKER");
  expect(ask.user).not.toContain(secret);
  expect(ask.system).not.toContain("SOURCE-TEXT-MARKER");
  expect([...ask.shown.values()]).toEqual(["lib/a.js"]);
});

test("a long file list and a long name list are cut and the cut is told, to the model and in the count", () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < MAX_FILES_SHOWN + 5; i++) files[`lib/f${String(i).padStart(4, "0")}.js`] = i === 0 ? Array.from({ length: MAX_NAMES_PER_FILE + 2 }, (_, n) => fn(`name${"abcdefghijklmnop"[n]}`)).join("") : fn(`q${i}`);
  const found = analyse(files);
  const ask = proposalAsk({ graph: found.graph, units: found.units, own: found.vocabulary.terms, rejectedNames: [] });
  expect(ask.filesShown).toBe(MAX_FILES_SHOWN);
  expect(ask.filesOf).toBe(MAX_FILES_SHOWN + 5);
  expect(ask.user).toContain("5 more code files are not shown");
  expect(ask.user).toContain("and 2 more");
});

test("what the model is asked has one digest for the same code and words, whatever a person rejected; the rejected names are told to it", () => {
  const found = analyse({ "docs/a.md": "# Billing\n", "lib/a.js": fn("sendBill") });
  const plain = proposalAsk({ graph: found.graph, units: found.units, own: found.vocabulary.terms, rejectedNames: [] });
  const told = proposalAsk({ graph: found.graph, units: found.units, own: found.vocabulary.terms, rejectedNames: ["Date arithmetic"] });
  expect(told.digest).toBe(plain.digest);
  expect(told.user).toContain("Date arithmetic");
  expect(plain.user).not.toContain("rejected");
  const other = analyse({ "docs/a.md": "# Billing\n", "lib/a.js": fn("sendInvoice") });
  expect(proposalAsk({ graph: other.graph, units: other.units, own: other.vocabulary.terms, rejectedNames: [] }).digest).not.toBe(plain.digest);
});

test("a proposed term is a candidate for every unit of the files it named, after those that share a word; an own term is narrowed as before", () => {
  const found = analyse({ "docs/a.md": "# Bills\n", "lib/a.js": fn("zq") + fn("sendBill"), "lib/b.js": fn("other") });
  const claimed: Term = { key: DATE, name: "Date arithmetic", spellings: ["Date arithmetic"], pins: [], claimed: { description: "Days between dates.", files: ["lib/a.js"] } };
  const withIt = narrow(found.units, [...found.vocabulary.terms, claimed], found.tree);
  const key = (name: string): string => found.units.find((unit) => unit.name === name)!.key;
  expect(withIt.units.get(key("zq"))!.candidates).toEqual([DATE]);
  expect(withIt.units.get(key("sendBill"))!.candidates).toEqual(["bill", DATE]);
  expect(withIt.units.get(key("other"))!.candidates).toEqual([]);
  // Nothing changes for the terms the repository wrote.
  for (const unit of found.units) expect(withIt.units.get(unit.key)!.candidates.filter((one) => one !== DATE)).toEqual(found.narrowed.units.get(unit.key)!.candidates);
});

test("Jev is told a proposed term is not written in the repository, with the model's description; an own term's text is as it was", () => {
  const found = analyse({ "docs/a.md": "# Bills\n\nInvoices and payments.\n", "lib/a.js": fn("sendBill") });
  const claimed: Term = { key: DATE, name: "Date arithmetic", spellings: ["Date arithmetic"], pins: [], claimed: { description: "Days between dates.", files: ["lib/a.js"] } };
  const text = termText(termFacts(claimed, found.tree));
  expect(text).toBe("Term: Date arithmetic\nProposed by a model, not written in this repository. The model described it as: Days between dates.");
  const billing = found.vocabulary.terms.find((term) => term.key === "bill")!;
  expect(termText(termFacts(billing, found.tree))).toContain("Written in this repository as:");
  expect(termText(termFacts(billing, found.tree))).not.toContain("Proposed");
  expect(membershipGate.version).toBe("membership-v1");
});

test("a stored proposal that is not whole is named, and a proposed term the repository now writes is not repeated", () => {
  const stored: StoredProposals = { tier: "claimed", model: "m", asked: "d", usd: null, basis: { of: 6, mapped: 1 }, terms: [{ key: "bill", name: "Bills", spellings: ["Bills"], pins: [], claimed: { description: "d", files: ["lib/a.js"] } }], dropped: { duplicate: 0, rejected: 0, unusable: 0, noFile: 0, unknownFiles: 0, overLimit: 0 }, shown: { files: 6, of: 6 } };
  expect(problemWithProposals(stored)).toBeUndefined();
  for (const [field, wrong] of [["tier", "judged"], ["usd", -1], ["usd", "1"], ["basis", { of: -1, mapped: 0 }], ["terms", [{ key: "x" }]], ["dropped", {}], ["shown", null]] as const) expect(problemWithProposals({ ...stored, [field]: wrong })).toBe(field);
  const own = analyse({ "docs/a.md": "# Billing\n", "lib/a.js": fn("sendBill") }).vocabulary.terms;
  expect(withProposed(own, stored).filter((term) => term.key === "bill")).toHaveLength(1);
  expect(withProposed(own, undefined)).toBe(own);
});
