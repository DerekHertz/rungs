import { expect, test } from "vitest";
import type { Why } from "../src/defining.ts";
import { fileCard, harmRow, omittedText, percent, shownPath, termsLine, termsNaming } from "../src/file-card.ts";
import type { DocFile, VocabularyDoc } from "../src/file-card.ts";
import type { NodeId } from "../src/graph.ts";

const why = (over: Partial<Why> = {}): Why => ({ contracts: [], dependents: [], unknownDependents: 0, testReachUnknown: false, unread: false, effects: [], testReaches: [], isTest: false, ...over });
const counts = (over: Partial<DocFile["units"]> = {}): DocFile["units"] => ({ total: 2, withTerm: 0, notJudged: 0, stale: 0, noTerm: 0, noCandidate: 0, ...over });
const file = (over: Partial<DocFile> = {}): DocFile => ({ path: "src/run.ts", terms: [], units: counts(), members: [], ...over });
const doc = (over: Partial<VocabularyDoc> = {}): VocabularyDoc => ({ tier: "derived", state: "stored", terms: [], termsStatus: "found", judged: true, withheldPaths: 0, files: [], ...over });
const sandbox = { key: "sandbox", name: "sandbox", probability: 0.977 };

test("a probability is floored, so a page never says 100% of an answer that is not certain", () => {
  expect(percent(0.977)).toBe("97%");
  expect(percent(0.999)).toBe("99%");
  expect(percent(1)).toBe("100%");
});

test("a withheld stored path or name is shown as withheld", () => {
  expect(shownPath(null)).toBe("withheld");
  expect(shownPath("src/a.ts")).toBe("src/a.ts");
});

test("no stored vocabulary: the card says so and names the command, never an empty terms line", () => {
  expect(termsLine(doc({ state: "none", terms: [] }), undefined).text).toBe("no vocabulary yet (run streets setup)");
  expect(termsLine(undefined, undefined).text).toBe("no vocabulary yet (run streets setup)");
});

test("a vocabulary the page could not load is unavailable, not 'no vocabulary'", () => {
  expect(termsLine(null, undefined).text).toBe("vocabulary unavailable: the page could not load it");
});

test("an unreadable stored vocabulary says why and is not 'no terms'", () => {
  const line = termsLine(doc({ state: "unreadable", why: "it is not JSON" }), undefined);
  expect(line.text).toBe("the stored vocabulary could not be read (it is not JSON): run streets setup");
  expect(line.chips).toEqual([]);
});

test("a vocabulary nobody has judged against says not judged, and how to judge", () => {
  expect(termsLine(doc({ judged: false }), file()).text).toBe("not judged (run streets setup --judge)");
});

test("terms of a file are chips with the probability, strongest first, with what is unknown beside them", () => {
  const line = termsLine(doc(), file({ terms: [sandbox, { key: "payment", name: "payments", probability: 0.92 }], units: counts({ total: 5, withTerm: 3, notJudged: 1, stale: 1 }) }));
  expect(line.chips).toEqual([
    { key: "sandbox", name: "sandbox", text: "sandbox 97%" },
    { key: "payment", name: "payments", text: "payments 92%" },
  ]);
  expect(line.text).toBe("1 of 5 functions, classes and constants not judged, 1 stale");
});

test("a file with no term that has pairs not judged or stale says that, never 'no terms'", () => {
  expect(termsLine(doc(), file({ units: counts({ notJudged: 2 }) })).text).toBe("not judged");
  expect(termsLine(doc(), file({ units: counts({ stale: 1 }) })).text).toBe("stale: the answer is out of date");
  expect(termsLine(doc(), file({ units: counts({ notJudged: 1, stale: 1 }) })).text).toBe("not judged, 1 stale");
  expect(termsLine(doc(), file({ units: counts({ notJudged: 1 }) })).text).not.toContain("no term");
});

test("only a file whose every function was judged says it has no term", () => {
  expect(termsLine(doc(), file({ units: counts({ total: 2, noTerm: 2 }) })).text).toBe("no term: all 2 functions, classes and constants were judged and none is mapped to one");
  expect(termsLine(doc(), file({ units: counts({ total: 0 }) })).text).toBe("no function, class or constant in it to map to a term");
  expect(termsLine(doc(), undefined).text).toBe("no function, class or constant in it to map to a term");
});

test("a function no term is a candidate for reads 'no candidate term', which the narrowing rule says, never 'judged'", () => {
  expect(termsLine(doc(), file({ units: counts({ total: 1, noCandidate: 1 }) })).text).toBe("no candidate term: no term shares a word with its function, class or constant");
  expect(termsLine(doc(), file({ units: counts({ total: 3, noCandidate: 3 }) })).text).toBe("no candidate term: no term shares a word with any of its 3 functions, classes and constants");
  expect(termsLine(doc(), file({ units: counts({ total: 3, noTerm: 1, noCandidate: 2 }) })).text).toBe("no term: 1 of 3 functions, classes and constants judged and none is mapped to one, 2 with no candidate term");
  expect(termsLine(doc(), file({ units: counts({ total: 2, noCandidate: 1, notJudged: 1 }) })).text).toBe("not judged");
});

test("a store built with other rules reads stale (rules changed), never a member and never 'no term'", () => {
  const line = termsLine(doc({ rules: "table 2, this version uses 3" }), file({ units: counts({ total: 2, stale: 2 }) }));
  expect(line.text).toBe("stale (rules changed: run streets setup)");
  expect(line.chips).toEqual([]);
});

test("a file whose code is not read says its terms are not known, never that it has no function", () => {
  expect(termsLine(doc(), file({ path: "worker.py", unread: "no adapter", units: counts({ total: 0 }) })).text).toBe("this file's code is not read (no adapter): its terms are not known");
  expect(termsLine(doc(), file({ unread: "could not be read", units: counts({ total: 0 }) })).text).toBe("this file's code is not read (could not be read): its terms are not known");
  expect(termsLine(doc(), file({ unread: "no adapter", units: counts({ total: 0 }) })).chips).toEqual([]);
});

test("a stale file says why, the actual reason the shared rule gave, and lists several neutrally", () => {
  expect(termsLine(doc(), file({ units: counts({ stale: 1 }), staleWhy: ["the term's definition changed"] })).text).toBe("stale: the term's definition changed");
  expect(termsLine(doc(), file({ units: counts({ stale: 2 }), staleWhy: ["the function changed", "the term's definition changed"] })).text).toBe("stale: the function changed; the term's definition changed");
  expect(termsLine(doc(), file({ terms: [sandbox], units: counts({ withTerm: 1, stale: 1 }), staleWhy: ["the question changed"] })).text).toBe("1 stale (the question changed)");
  expect(termsLine(doc(), file({ units: counts({ notJudged: 1, stale: 1 }), staleWhy: ["the function changed"] })).text).toBe("not judged, 1 stale (the function changed)");
});

test("members left out of a capped list are counted by what they are, current or stale, never all as members", () => {
  expect(omittedText({ current: 0, stale: 1 })).toBe("and 1 more not listed (1 stale)");
  expect(omittedText({ current: 1, stale: 2 })).toBe("and 3 more not listed (1 current, 2 stale)");
  expect(omittedText({ current: 2, stale: 0 })).toBe("and 2 more not listed (2 current)");
});

test("a file that could not be read has its terms not judged", () => {
  expect(termsLine(doc(), undefined, true).text).toBe("not judged: the file could not be read");
});

test("a vocabulary of no terms, or of unknown terms, says which", () => {
  expect(termsLine(doc({ termsStatus: "none" }), undefined).text).toBe("no terms: everything was read and the repository wrote none");
  expect(termsLine(doc({ termsStatus: "unknown", reason: "a file could not be read: a.ts" }), undefined).text).toBe("terms unknown: a file could not be read: a.ts");
});

test("a vocabulary built with other rules says so beside the terms", () => {
  expect(termsLine(doc({ rules: "table 2, this version uses 3", terms: [] }), file({ terms: [sandbox] })).note).toBe("built with other rules (table 2, this version uses 3): run streets setup");
});

test("the card is a fixed template in order: what it is, what rests on it, what this change did to it; the harm row is left out until stakes exist", () => {
  const card = fileCard({ doc: doc(), file: file({ terms: [sandbox] }), role: "source", kind: "altered", why: why({ dependents: ["src/a.ts", "src/b.ts"], contracts: ["run signature changed"], effects: ["new process spawn"], testReaches: ["test/run.test.ts"] }) });
  expect(card.map((row) => row.id)).toEqual(["is", "rests", "did"]);
  const [is, rests, did] = card;
  expect(is!.label).toBe("What it is");
  expect(is!.lines.map((line) => [line.label, line.tier])).toEqual([["terms", "judged"], ["role", "derived"]]);
  expect(is!.lines[1]!.text).toBe("source");
  expect(rests!.lines[0]).toMatchObject({ tier: "derived", text: "2 files rest on it", list: ["src/a.ts", "src/b.ts"] });
  expect(did!.lines.map((line) => line.text)).toEqual(["altered", "1 contract moved", "1 new effect", "1 test file reach it"]);
  expect(did!.lines.every((line) => line.tier === "derived")).toBe(true);
});

test("a file with no role says so and a file nothing rests on says so", () => {
  const card = fileCard({ doc: doc(), file: file(), role: undefined, kind: "added", why: why() });
  expect(card[0]!.lines[1]!.text).toBe("no role: the path matches no convention");
  expect(card[1]!.lines[0]).toMatchObject({ text: "no file rests on it" });
  expect(card[1]!.lines[0]!.list).toBeUndefined();
});

test("the card counts unread files as unknown, never as a plain count", () => {
  const card = fileCard({ doc: doc(), file: undefined, role: "source", kind: "altered", why: why({ dependents: ["src/a.ts"], unknownDependents: 2 }) });
  expect(card[1]!.lines[0]!.text).toBe("at least 1 file rests on it, plus unknown via 2 unread files");
});

test("the harm row is omitted without stakes, and is a judged row with them", () => {
  expect(harmRow(undefined)).toBeUndefined();
  expect(fileCard({ doc: doc(), file: file(), role: "source", kind: "altered", why: why() }).some((row) => row.id === "harm")).toBe(false);
  const row = harmRow({ harms: [{ kind: "data loss", probability: 0.8 }] });
  expect(row?.lines[0]).toMatchObject({ tier: "judged", text: "data loss 80%" });
});

test("stakes given to the card put the harm row between what rests on it and what this change did", () => {
  const card = fileCard({ doc: doc(), file: file(), role: "source", kind: "altered", why: why(), stakes: { harms: [{ kind: "money", probability: 0.5 }] } });
  expect(card.map((row) => row.id)).toEqual(["is", "rests", "harm", "did"]);
});

test("a risk or contract entry names the terms of the function it is about, and of the file when it is about the file", () => {
  const entry = file({ members: [{ id: "function:src/run.ts#run" as NodeId, terms: [sandbox] }], terms: [sandbox, { key: "payment", name: "payments", probability: 0.92 }] });
  const vocabulary = doc({ files: [entry] });
  expect(termsNaming(vocabulary, "src/run.ts", ["function:src/run.ts#run" as NodeId])).toEqual(["sandbox"]);
  // A function that is not a member of any term names none: the file's terms are not borrowed for it.
  expect(termsNaming(vocabulary, "src/run.ts", ["function:src/run.ts#other" as NodeId])).toEqual([]);
  expect(termsNaming(vocabulary, "src/run.ts", ["file:src/run.ts" as NodeId])).toEqual(["sandbox", "payments"]);
  expect(termsNaming(doc({ state: "none" }), "src/run.ts", ["file:src/run.ts" as NodeId])).toEqual([]);
  expect(termsNaming(null, "src/run.ts", [])).toEqual([]);
});
