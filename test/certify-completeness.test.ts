import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, test } from "vitest";
import { certificationOf, correctionsDigest, vocabularyDigest } from "../src/corrections.ts";
import type { Certification } from "../src/corrections.ts";
import { coverageOf } from "../src/memberships.ts";
import type { StoredMemberships } from "../src/memberships.ts";
import { jevCost } from "../src/jev/client.ts";
import type { JevClient, JevResponse } from "../src/jev/client.ts";
import { reportLines, termsOf } from "../src/setup.ts";
import type { StoredVocabulary } from "../src/setup.ts";
import { vocabularyCommand } from "../src/vocabulary-command.ts";
import { commit, dates, docOf, fn, poor, read, repo, saying, temp } from "./propose-fixtures.ts";
import { setUp } from "./setup-no-stakes.ts";

/*
 * The tier 3 rule: a vocabulary is never shown as certified for something the person did not review, and
 * incomplete data is never certified.
 */

let minute = 0;
const run = (dir: string, cacheDir: string, args: string[], name = "Ada Lovelace") => vocabularyCommand([...args, "--dir", dir], { cacheDir, now: () => new Date(Date.UTC(2026, 10, 12, 9, minute++)), gitName: async () => name });
const text = (result: { out: readonly string[]; err: readonly string[] }): string => [...result.out, ...result.err].join("\n");

const ORDERS = { "README.md": "# Orders\n\ntext\n", "src/ok.ts": "export function fine(): void {}\n" };
const BROKEN = { "src/broken.ts": "export function broken(" };

const answering: JevClient = {
  model: "fake-1",
  async ask(): Promise<JevResponse> {
    return { answers: { belongs: { type: "yes-no", yes: 0.03 }, incidental: { type: "yes-no", yes: 0.02 } }, usage: { inputTokens: 1, outputTokens: 1, usd: jevCost(1) }, model: "fake-1" };
  },
};

/* ---- finding 4: the digest covers what the person reviewed ---- */

test("a refresh that keeps a proposed term's name and changes its description and files is certified no longer", async () => {
  const dir = repo(poor);
  const cacheDir = temp("streets-cache-");
  await setUp({ dir, cacheDir, propose: saying(dates) });
  expect((await run(dir, cacheDir, ["certify"])).code).toBe(0);
  const earlier = await read(dir, cacheDir);
  expect(docOf(earlier).certification).toMatchObject({ kind: "certified", by: "Ada Lovelace" });

  commit(dir, { "lib/k6.js": fn("helper") });
  const billing = dates.map((one) => (one.name === "Date arithmetic" ? { ...one, description: "Billing penalties.", files: ["lib/k1.js"] } : one));
  const again = await setUp({ dir, cacheDir, propose: saying(billing) });
  expect(again.proposing).toMatchObject({ status: "proposed", asked: true });
  const stored = await read(dir, cacheDir);
  expect(termsOf(stored).find((term) => term.name === "Date arithmetic")!.claimed).toMatchObject({ description: "Billing penalties.", files: ["lib/k1.js"] });
  const tree = { ...poor, "lib/k6.js": fn("helper") };
  expect(stored.vocabulary.terms).toEqual(earlier.vocabulary.terms);
  expect(docOf(stored, tree).certification).toMatchObject({ kind: "changed", by: "Ada Lovelace" });
  expect(text(await run(dir, cacheDir, ["list"]))).toContain("vocabulary changed since");
  expect(reportLines({ ...again, stored }).join("\n")).toContain("vocabulary changed since");
});

test("the same description under another model is not what was certified", () => {
  const term = { key: "date arithmetic", name: "Date arithmetic", pins: [], claimed: { description: "Dates.", files: ["a.js"] } };
  const certification: Certification = { by: "Grace", at: "2026-11-12T08:00:00.000Z", vocabulary: vocabularyDigest([term], "model-a"), corrections: correctionsDigest([]) };
  expect(certificationOf([term], [], certification, { model: "model-a" }).kind).toBe("certified");
  expect(certificationOf([term], [], certification, { model: "model-b" }).kind).toBe("changed");
  expect(certificationOf([{ ...term, claimed: { ...term.claimed, files: ["a.js", "b.js"] } }], [], certification, { model: "model-a" }).kind).toBe("changed");
  expect(certificationOf([{ ...term, claimed: { ...term.claimed, description: "Billing." } }], [], certification, { model: "model-a" }).kind).toBe("changed");
});

test("where an own term is written is part of what was certified", () => {
  const pin = { source: "heading" as const, path: "docs/a.md", range: { start: 1, end: 1 }, written: "Orders" };
  const term = { key: "order", name: "Orders", pins: [pin] };
  const certification: Certification = { by: "Grace", at: "2026-11-12T08:00:00.000Z", vocabulary: vocabularyDigest([term]), corrections: correctionsDigest([]) };
  expect(certificationOf([term], [], certification).kind).toBe("certified");
  expect(certificationOf([{ ...term, pins: [{ ...pin, path: "docs/b.md" }] }], [], certification).kind).toBe("changed");
  expect(certificationOf([{ ...term, pins: [{ ...pin, range: { start: 4, end: 4 } }] }], [], certification).kind).toBe("changed");
  expect(certificationOf([{ ...term, pins: [] }], [], certification).kind).toBe("changed");
  expect(certificationOf([{ ...term, pins: [pin, { ...pin, source: "export", path: "src/o.ts" }] }], [], certification).kind).toBe("changed");
});

test("a certification made when only keys and names were digested reads as changed, never certified", () => {
  const terms = [{ key: "order", name: "Orders", pins: [] }];
  const older = createHash("sha256").update(JSON.stringify(terms.map((term) => [term.key, term.name]))).digest("hex").slice(0, 16);
  const certification: Certification = { by: "Grace", at: "2026-11-12T08:00:00.000Z", vocabulary: older, corrections: correctionsDigest([]) };
  expect(certificationOf(terms, [], certification)).toEqual({ kind: "changed", by: "Grace", at: "2026-11-12T08:00:00.000Z" });
});

test("a proposed term a person's correction keeps stays certified while nothing about it moves, and not when its words do", async () => {
  const dir = repo(poor);
  const cacheDir = temp("streets-cache-");
  await setUp({ dir, cacheDir, propose: saying(dates) });
  const key = termsOf(await read(dir, cacheDir)).find((term) => term.name === "Date arithmetic")!.key;
  await run(dir, cacheDir, ["confirm", key]);
  expect((await run(dir, cacheDir, ["certify"])).code).toBe(0);
  commit(dir, { "lib/k6.js": fn("helper") });
  const tree = { ...poor, "lib/k6.js": fn("helper") };
  await setUp({ dir, cacheDir, propose: saying(dates) });
  expect(docOf(await read(dir, cacheDir), tree).certification?.kind).toBe("certified");
  commit(dir, { "lib/k7.js": fn("common") });
  await setUp({ dir, cacheDir, propose: saying(dates.map((one) => (one.name === "Date arithmetic" ? { ...one, description: "Something else." } : one))) });
  expect(docOf(await read(dir, cacheDir), { ...tree, "lib/k7.js": fn("common") }).certification?.kind).toBe("changed");
});

/* ---- finding 5: incomplete data is never certified ---- */

test("a vocabulary with a file that could not be read is not certified, and the refusal names the file", async () => {
  const dir = repo({ ...ORDERS, ...BROKEN });
  const cacheDir = temp("streets-cache-");
  await setUp({ dir, cacheDir });
  const stored = await read(dir, cacheDir);
  expect(stored.vocabulary.status).toBe("found");
  expect(stored.vocabulary.unread.map((one) => one.path)).toContain("src/broken.ts");
  const refused = await run(dir, cacheDir, ["certify"]);
  expect(refused.code).toBe(1);
  expect(text(refused)).toContain("src/broken.ts");
  expect(text(refused)).toContain("Nothing was certified");
  expect((await read(dir, cacheDir)).certification).toBeUndefined();
  expect(text(await run(dir, cacheDir, ["list"]))).toContain("drafted");
});

test("a vocabulary certified whole that has since gained an unread file does not read plainly certified", async () => {
  const dir = repo(ORDERS);
  const cacheDir = temp("streets-cache-");
  await setUp({ dir, cacheDir });
  expect((await run(dir, cacheDir, ["certify"])).code).toBe(0);
  const whole = await read(dir, cacheDir);
  expect(docOf(whole, ORDERS).certification?.kind).toBe("certified");
  // The tree being drawn has gained a file that cannot be read.
  expect(docOf(whole, { ...ORDERS, ...BROKEN }).certification).toMatchObject({ kind: "changed", by: "Ada Lovelace" });
  // A rebuilt store has gained it.
  commit(dir, BROKEN);
  const rebuilt = await setUp({ dir, cacheDir });
  const stored = await read(dir, cacheDir);
  expect(stored.certification).toBeDefined();
  expect(docOf(stored, { ...ORDERS, ...BROKEN }).certification?.kind).toBe("changed");
  expect(text(await run(dir, cacheDir, ["list"]))).toContain("vocabulary changed since");
  expect(text(await run(dir, cacheDir, ["list"]))).toContain("src/broken.ts");
  expect(reportLines({ ...rebuilt, stored }).join("\n")).toContain("vocabulary changed since");
  const again = await run(dir, cacheDir, ["certify"]);
  expect(again.code).toBe(1);
  expect(text(again)).toContain("src/broken.ts");
});

test("code no adapter reads is incomplete too: it is named by count, and refused", async () => {
  const dir = repo({ ...ORDERS, "tools/job.py": "def job():\n    return 1\n" });
  const cacheDir = temp("streets-cache-");
  await setUp({ dir, cacheDir });
  const stored = await read(dir, cacheDir);
  expect(stored.vocabulary.notAnalysed).toBe(1);
  const refused = await run(dir, cacheDir, ["certify"]);
  expect(refused.code).toBe(1);
  expect(text(refused)).toContain("no adapter");
});

/** The store with other memberships, and the coverage that follows from them (a store whose coverage does not is refused as damaged). */
const withMemberships = (whole: StoredVocabulary, memberships: StoredMemberships): StoredVocabulary => ({ ...whole, memberships, coverage: coverageOf(whole.coverage.of, memberships) }) as StoredVocabulary;
const staled = (whole: StoredVocabulary): StoredVocabulary => withMemberships(whole, { ...whole.memberships!, records: whole.memberships!.records.map((record, index) => (index === 0 ? { ...record, stale: "the function changed" } : record)) });

async function judgedWorld(): Promise<{ dir: string; cacheDir: string; file: string; stored: () => StoredVocabulary & Record<string, unknown> }> {
  const dir = repo({ "README.md": "# Orders\n\ntext\n", "src/orders/place.ts": "export function placeOrder(): void {}\n", "src/orders/cancel.ts": "export function cancelOrder(): void {}\n" });
  const cacheDir = temp("streets-cache-");
  const first = await setUp({ dir, cacheDir, judge: answering });
  return { dir, cacheDir, file: first.file, stored: () => JSON.parse(readFileSync(first.file, "utf8")) };
}

test("judged memberships that are not judged, stale or cut keep a vocabulary from being certified; a person's word on the pair settles it", async () => {
  const { dir, cacheDir, file, stored } = await judgedWorld();
  const whole = stored();
  const memberships = whole.memberships!;
  expect(memberships.records.length).toBeGreaterThan(0);
  expect((await run(dir, cacheDir, ["certify"])).code).toBe(0);
  writeFileSync(file, JSON.stringify({ ...whole, certification: undefined }));

  const states: [string, StoredVocabulary][] = [
    ["not judged", withMemberships(whole, { ...memberships, records: memberships.records.slice(1) })],
    ["stale", staled(whole)],
    ["left out by the cap", withMemberships(whole, { ...memberships, units: memberships.units.map((unit, index) => (index === 0 ? { ...unit, candidates: unit.candidates.slice(1), cut: [...unit.cut, memberships.records[0]!.term] } : unit)) })],
  ];
  for (const [word, damaged] of states) {
    writeFileSync(file, JSON.stringify(damaged));
    const refused = await run(dir, cacheDir, ["certify"]);
    expect(refused.code, word).toBe(1);
    expect(text(refused), word).toContain(word);
    expect(stored().certification, word).toBeUndefined();
  }
  // Not judged: the person says yes or no to that very pair, and then it is known.
  const missing = memberships.records[0]!;
  writeFileSync(file, JSON.stringify(states[0]![1]));
  expect((await run(dir, cacheDir, ["member", missing.unit, missing.term, "no"])).code).toBe(0);
  expect((await run(dir, cacheDir, ["certify"])).code).toBe(0);
});

test("a vocabulary that was never judged can still be certified: it certifies terms and corrections, and the page says not judged", async () => {
  const dir = repo(ORDERS);
  const cacheDir = temp("streets-cache-");
  await setUp({ dir, cacheDir });
  expect((await run(dir, cacheDir, ["certify"])).code).toBe(0);
});

test("a certified vocabulary whose judged answers later go stale does not read plainly certified", async () => {
  const { dir, cacheDir, file, stored } = await judgedWorld();
  expect((await run(dir, cacheDir, ["certify"])).code).toBe(0);
  writeFileSync(file, JSON.stringify(staled(stored())));
  expect(text(await run(dir, cacheDir, ["list"]))).toContain("vocabulary changed since");
});

test("a vocabulary certified as having no terms does not read certified once the terms are unknown", async () => {
  const dir = repo({ "README.md": "# Notes\n\ntext\n" });
  const cacheDir = temp("streets-cache-");
  const first = await setUp({ dir, cacheDir });
  const none = await read(dir, cacheDir);
  expect(none.vocabulary.status).toBe("none");
  expect((await run(dir, cacheDir, ["certify"])).code).toBe(0);
  const whole = JSON.parse(readFileSync(first.file, "utf8"));
  writeFileSync(first.file, JSON.stringify({ ...whole, vocabulary: { ...whole.vocabulary, status: "unknown", reason: "a test title is not a string literal" } }));
  expect(docOf(await read(dir, cacheDir), { "README.md": "# Notes\n\ntext\n" }).certification).toMatchObject({ kind: "changed" });
});
