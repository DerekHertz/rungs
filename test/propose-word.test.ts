import { writeFileSync } from "node:fs";
import { expect, test } from "vitest";
import type { Correction } from "../src/corrections.ts";
import { termsLine } from "../src/file-card.ts";
import { jevCost } from "../src/jev/client.ts";
import type { JevClient, JevResponse } from "../src/jev/client.ts";
import { reportLines } from "../src/setup.ts";
import type { StoredVocabulary } from "../src/setup.ts";
import { keyOf } from "../src/vocabulary.ts";
import { vocabularyCommand } from "../src/vocabulary-command.ts";
import { commit, dateKey, dates, docOf, fn, poor, read, repo, saying, stamp, temp, withWord } from "./propose-fixtures.ts";
import type { Terms } from "./propose-fixtures.ts";
import { setUp } from "./setup-no-stakes.ts";

/*
 * A person's word survives a refresh, and a term keeps the provenance of every part it is made of.
 * The cases are the ones a refresh, merge, rename, removal or confirm can reach.
 */

const calendar: Terms = [{ name: "Calendar maths", description: "Calendars and offsets.", files: ["lib/k3.js"] }];
const both: Terms = [...dates, ...calendar];
const shaping: Terms = [{ name: "Text shaping", description: "Slugs and truncated text.", files: ["lib/k4.js"] }];
const calendarKey = keyOf("Calendar maths");
const textKey = keyOf("Text shaping");
const more = { "lib/k6.js": fn("padLeft") };
const grown = { ...poor, ...more };
const judgedYes: JevClient = {
  model: "fake-1",
  async ask(): Promise<JevResponse> {
    return { answers: { belongs: { type: "yes-no", yes: 0.97 }, incidental: { type: "yes-no", yes: 0.02 } }, usage: { inputTokens: 1, outputTokens: 1, usd: jevCost(1) }, model: "fake-1" };
  },
};
const say = (kind: "confirm" | "remove" | "rename" | "merge", term: string, label: string, extra: Record<string, string> = {}): Correction => ({ ...stamp, kind, term, label, ...extra }) as Correction;

/** Proposes `first`, stores `corrections` over it, adds a file and refreshes with an answer of `second`. */
async function refreshed(first: Terms, corrections: Correction[], second: Terms, files: Record<string, string> = more): Promise<{ dir: string; cacheDir: string; after: StoredVocabulary; tree: Record<string, string> }> {
  const dir = repo(poor);
  const cacheDir = temp("streets-cache-");
  const one = await setUp({ dir, cacheDir, propose: saying(first) });
  writeFileSync(one.file, JSON.stringify({ ...(await read(dir, cacheDir)), corrections }));
  commit(dir, files);
  await setUp({ dir, cacheDir, propose: saying(second) });
  return { dir, cacheDir, after: await read(dir, cacheDir), tree: { ...poor, ...files } };
}

/* ---- finding 1: an empty answer ---- */

test("a valid empty answer is reported as a model that was asked and proposed no terms, never as proposed terms or as no terms needed", async () => {
  const dir = repo(poor);
  const cacheDir = temp("streets-cache-");
  const result = await setUp({ dir, cacheDir, propose: saying([]) });
  const text = reportLines(result).join("\n");
  expect(text).toContain("a model was asked and proposed no terms");
  expect(text).toContain("under half");
  expect(text).not.toContain("a model proposed terms");
  expect(text).not.toContain("proposed terms (claimed, not written in the repository): 0");
  expect(text).not.toContain("so no term is proposed");
  const stored = await read(dir, cacheDir);
  expect(stored.proposals).toMatchObject({ terms: [], answered: 0 });
  const again = await setUp({ dir, cacheDir, propose: saying(dates) });
  expect(again.proposing).toMatchObject({ status: "proposed", asked: false });
  const reused = reportLines(again).join("\n");
  expect(reused).toContain("a model was asked and proposed no terms");
  expect(reused).not.toContain("a model proposed terms");
  const plain = reportLines(await setUp({ dir, cacheDir })).join("\n");
  expect(plain).toContain("a model was asked and proposed no terms");
});

test("the page and the command line say a model proposed no terms, and the coverage stays reported as low", async () => {
  const dir = repo(poor);
  const cacheDir = temp("streets-cache-");
  await setUp({ dir, cacheDir, propose: saying([]) });
  const doc = docOf(await read(dir, cacheDir));
  expect(doc.proposed).toMatchObject({ count: 0, answered: 0 });
  const line = termsLine(doc, doc.files.find((file) => file.path === "lib/k1.js"));
  expect(line.note).toContain("a model was asked and proposed no terms");
  expect(line.note).toContain("own words reach 2 of 6 files");
  const listed = await vocabularyCommand(["list", "--dir", dir], { cacheDir });
  expect(listed.out.join("\n")).toContain("a model was asked and proposed no terms");
});

test("with no proposals stored, nothing says a model was asked", async () => {
  const dir = repo(poor);
  const cacheDir = temp("streets-cache-");
  await setUp({ dir, cacheDir });
  expect(docOf(await read(dir, cacheDir)).proposed).toBeUndefined();
});

/* ---- finding 2: a refresh keeps what a person's word names ---- */

test("a proposal merged away by a person is not resurrected when a refresh no longer proposes its merge target", async () => {
  const { after, tree } = await refreshed(both, [say("merge", dateKey, "Date arithmetic", { into: calendarKey })], shaping);
  expect(after.proposals!.terms.map((term) => term.key)).toEqual(expect.arrayContaining([dateKey, calendarKey, textKey]));
  const doc = docOf(after, tree);
  expect(doc.terms.map((term) => term.name)).not.toContain("Date arithmetic");
  expect(doc.terms.find((term) => term.key === calendarKey)).toMatchObject({ name: "Calendar maths", mergedFrom: ["Date arithmetic"] });
  expect(doc.corrections!.noLongerApply).toEqual([]);
});

test("a proposal a person confirmed, renamed or spoke for a function of is kept by a refresh that does not propose it again", async () => {
  for (const word of [say("confirm", dateKey, "Date arithmetic"), say("rename", dateKey, "Date arithmetic", { name: "Dates" })]) {
    const { after, tree } = await refreshed(dates, [word], shaping);
    const doc = docOf(after, tree);
    expect(doc.terms.find((term) => term.key === dateKey)).toBeDefined();
    expect(doc.corrections!.noLongerApply).toEqual([]);
  }
  const dir = repo(poor);
  const cacheDir = temp("streets-cache-");
  const one = await setUp({ dir, cacheDir, propose: saying(dates), judge: judgedYes });
  const stored = await read(dir, cacheDir);
  const unit = stored.memberships!.units.find((one) => one.name === "multiply")!;
  const said: Correction = { ...stamp, kind: "member", unit: unit.key, term: dateKey, belongs: true, label: "multiply, term Date arithmetic" };
  writeFileSync(one.file, JSON.stringify({ ...stored, corrections: [said] }));
  commit(dir, more);
  await setUp({ dir, cacheDir, propose: saying(shaping) });
  const doc = docOf(await read(dir, cacheDir), grown);
  expect(doc.terms.find((term) => term.key === dateKey)!.members.map((member) => member.name)).toContain("multiply");
  expect(doc.corrections!.noLongerApply).toEqual([]);
});

test("a proposal no correction names is still dropped by a refresh that does not propose it again", async () => {
  const { after } = await refreshed(both, [say("merge", dateKey, "Date arithmetic", { into: calendarKey })], shaping);
  expect(after.proposals!.terms.map((term) => term.key).sort()).toEqual([calendarKey, dateKey, textKey].sort());
  expect(after.proposals!.terms.map((term) => term.name)).not.toContain("Number folding");
});

test("a proposal a correction names is kept when the repository's own words rise to half, and the others are dropped", async () => {
  const dir = repo(poor);
  const cacheDir = temp("streets-cache-");
  const one = await setUp({ dir, cacheDir, propose: saying(both) });
  writeFileSync(one.file, JSON.stringify({ ...(await read(dir, cacheDir)), corrections: [say("merge", dateKey, "Date arithmetic", { into: calendarKey })] }));
  const words = { "docs/words.md": "# Slugs\n\n# Means\n\n# Totals\n\n# Truncates\n\n# Days\n\n# Csv\n\n# Multiplies\n\n# Pads\n" };
  commit(dir, words);
  const better = await setUp({ dir, cacheDir });
  expect(better.proposing).toMatchObject({ status: "not needed", kept: 2 });
  const stored = await read(dir, cacheDir);
  expect(stored.proposals!.terms.map((term) => term.key).sort()).toEqual([calendarKey, dateKey].sort());
  const doc = docOf(stored, { ...poor, ...words });
  expect(doc.terms.find((term) => term.key === calendarKey)).toMatchObject({ mergedFrom: ["Date arithmetic"] });
  expect(doc.corrections!.noLongerApply).toEqual([]);
  expect(reportLines(better).join("\n")).toContain("kept because a person's correction names");
});

test("a removed proposal stays removed through a refresh that proposes it again", async () => {
  const { after, tree } = await refreshed(dates, [say("remove", dateKey, "Date arithmetic")], dates);
  expect(docOf(after, tree).terms.map((term) => term.name)).not.toContain("Date arithmetic");
  expect(after.proposals!.dropped.rejected).toBe(1);
});

/* ---- finding 3: a merged term keeps every part's provenance ---- */

test("an own term merged into a proposed one keeps the proposal's claim, description, model and count, and its pins are not the model's", async () => {
  const dir = repo(poor);
  const cacheDir = temp("streets-cache-");
  await setUp({ dir, cacheDir, propose: saying(dates), judge: judgedYes });
  const stored = await read(dir, cacheDir);
  const multiply = keyOf("multiply");
  expect(stored.vocabulary.terms.some((term) => term.key === multiply)).toBe(true);
  const doc = docOf(withWord(stored, [say("merge", multiply, "multiply", { into: dateKey })]));
  const merged = doc.terms.find((term) => term.key === dateKey)!;
  expect(merged.mergedFrom).toEqual(["multiply"]);
  expect(merged.proposed).toEqual([{ name: "Date arithmetic", description: "Dates and the days between them.", files: ["lib/k3.js"], model: "claude-sonnet-x" }]);
  expect(merged.pins.length).toBeGreaterThan(0);
  expect(doc.proposed).toMatchObject({ count: 3, model: "claude-sonnet-x" });
  const chips = doc.files.flatMap((file) => file.terms).filter((ref) => ref.key === dateKey);
  expect(chips.length).toBeGreaterThan(0);
  expect(chips.every((ref) => ref.claimed === true)).toBe(true);
});

test("a proposal merged into an own term, and a chain of merges through an own term, are claimed and say which parts the model proposed", async () => {
  const dir = repo(poor);
  const cacheDir = temp("streets-cache-");
  await setUp({ dir, cacheDir, propose: saying(both), judge: judgedYes });
  const stored = await read(dir, cacheDir);
  const csv = keyOf("csv");
  const csvName = stored.vocabulary.terms.find((term) => term.key === csv)!.name;
  const into = docOf(withWord(stored, [say("merge", dateKey, "Date arithmetic", { into: csv })])).terms.find((term) => term.key === csv)!;
  expect(into.mergedFrom).toEqual(["Date arithmetic"]);
  expect(into.proposed!.map((part) => part.name)).toEqual(["Date arithmetic"]);
  const chain = docOf(withWord(stored, [say("merge", dateKey, "Date arithmetic", { into: csv }), say("merge", csv, "csv", { into: calendarKey })])).terms.find((term) => term.key === calendarKey)!;
  expect(chain.proposed!.map((part) => part.name).sort()).toEqual(["Calendar maths", "Date arithmetic"]);
  expect(chain.mergedFrom!.slice().sort()).toEqual(["Date arithmetic", csvName]);
});

test("two own terms merged together are not claimed, and a term with no proposed part has no proposal to show", async () => {
  const dir = repo(poor);
  const cacheDir = temp("streets-cache-");
  await setUp({ dir, cacheDir, propose: saying(dates), judge: judgedYes });
  const stored = await read(dir, cacheDir);
  const doc = docOf(withWord(stored, [say("merge", keyOf("csv"), "csv", { into: keyOf("multiply") })]));
  expect(doc.terms.find((term) => term.key === keyOf("multiply"))!.proposed).toBeUndefined();
  expect(doc.proposed!.count).toBe(3);
});

test("the command line marks a merged term that has a proposed part", async () => {
  const dir = repo(poor);
  const cacheDir = temp("streets-cache-");
  await setUp({ dir, cacheDir, propose: saying(dates), judge: judgedYes });
  expect((await vocabularyCommand(["merge", "multiply", "Date arithmetic", "--dir", dir, "--by", "Dana"], { cacheDir })).code).toBe(0);
  expect((await vocabularyCommand(["list", "--dir", dir], { cacheDir })).out.join("\n")).toMatch(/Date arithmetic \(dat arithmetic\): proposed by a model \(claimed\).*merged in: multiply/);
  const csvName = (await read(dir, cacheDir)).vocabulary.terms.find((term) => term.key === keyOf("csv"))!.name;
  expect((await vocabularyCommand(["merge", "Date arithmetic", csvName, "--dir", dir, "--by", "Dana"], { cacheDir })).code).toBe(0);
  expect((await vocabularyCommand(["list", "--dir", dir], { cacheDir })).out.join("\n")).toMatch(new RegExp(`${csvName} \\(csv\\): proposed by a model \\(claimed\\).*merged in: multiply, Date arithmetic`));
});

test("renaming or confirming a proposed term keeps it claimed, and an own term merged into it is not made the model's by a rename", async () => {
  const dir = repo(poor);
  const cacheDir = temp("streets-cache-");
  await setUp({ dir, cacheDir, propose: saying(dates), judge: judgedYes });
  const stored = await read(dir, cacheDir);
  const doc = docOf(withWord(stored, [say("merge", keyOf("multiply"), "multiply", { into: dateKey }), say("rename", keyOf("multiply"), "multiply", { name: "Product" }), say("rename", dateKey, "Date arithmetic", { name: "Dates" }), say("confirm", dateKey, "Dates")]));
  expect(doc.terms.find((term) => term.key === dateKey)).toMatchObject({ name: "Dates", mergedFrom: ["Product"], confirmed: stamp, proposed: [expect.objectContaining({ name: "Dates" })] });
});

/* ---- the rest of the class ---- */

test("a term the repository starts to write itself is its own, and a person's confirm of the proposal still applies to it", async () => {
  const words = { "docs/dates.md": "# Date arithmetic\n" };
  const { after, tree } = await refreshed(dates, [say("confirm", dateKey, "Date arithmetic")], dates, words);
  expect(after.proposals!.terms.map((term) => term.key)).not.toContain(dateKey);
  const doc = docOf(after, { ...tree });
  const date = doc.terms.find((term) => term.key === dateKey);
  expect(date).toMatchObject({ confirmed: stamp });
  expect(date!.proposed).toBeUndefined();
  expect(doc.corrections!.noLongerApply).toEqual([]);
});

test("an answer that proposes a kept term again replaces its description; one that does not leaves the stored one", async () => {
  const again: Terms = [{ name: "Date arithmetic", description: "Calendar days and their differences.", files: ["lib/k3.js"] }];
  const confirmed = [say("confirm", dateKey, "Date arithmetic")];
  const renewed = await refreshed(dates, confirmed, again);
  expect(renewed.after.proposals!.terms.find((term) => term.key === dateKey)!.claimed!.description).toBe("Calendar days and their differences.");
  const left = await refreshed(dates, confirmed, shaping);
  expect(left.after.proposals!.terms.find((term) => term.key === dateKey)!.claimed!.description).toBe("Dates and the days between them.");
});
