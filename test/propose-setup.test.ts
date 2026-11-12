import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { correctionsDigest, vocabularyDigest } from "../src/corrections.ts";
import type { Correction } from "../src/corrections.ts";
import { extract } from "../src/extract/extract.ts";
import type { FileTree } from "../src/graph.ts";
import { jevCost } from "../src/jev/client.ts";
import type { JevClient, JevRequest, JevResponse } from "../src/jev/client.ts";
import type { AgentRunner } from "../src/link.ts";
import { keyOf } from "../src/vocabulary.ts";
import { readVocabulary, reportLines, termsOf } from "../src/setup.ts";
import type { StoredVocabulary } from "../src/setup.ts";
import { vocabularyDocument } from "../src/vocabulary-doc.ts";
import { setUp } from "./setup-no-stakes.ts";

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});
const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
};
const identity = ["user.name=t", "user.email=t@example.com", "commit.gpgsign=false"];
const git = (dir: string, ...args: string[]): string => execFileSync("git", [...identity.flatMap((s) => ["-c", s]), ...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
function commit(dir: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  git(dir, "add", "--all");
  git(dir, "commit", "--quiet", "-m", "change");
}
function repo(files: Record<string, string>): string {
  const dir = temp("streets-propose-");
  git(dir, "init", "--quiet", "--initial-branch=main");
  commit(dir, files);
  return dir;
}
const fn = (name: string): string => `export function ${name}(a) {\n  return a;\n}\n`;

/** Six code files and no word the repository's own text shares between them: two of six map to an own term at most. */
const poor: Record<string, string> = {
  "package.json": '{\n  "name": "zq"\n}\n',
  "README.md": "# zq\n",
  "lib/k1.js": fn("multiply") + fn("compact"),
  "lib/k2.js": fn("total") + fn("mean"),
  "lib/k3.js": fn("isoDay") + fn("daysBetween"),
  "lib/k4.js": fn("slugify") + fn("truncate"),
  "lib/k5.js": fn("toCsv") + fn("fromCsv"),
  "bin/z.js": 'import { multiply } from "../lib/k1.js";\nconsole.log(multiply(1, 2));\n',
};
const well: Record<string, string> = {
  "package.json": '{\n  "description": "Online bookshop with a shopping cart and checkout"\n}\n',
  "README.md": "# Bookshop\n\n## Shopping cart\n\ntext\n\n## Checkout\n\ntext\n\n## Inventory\n\ntext\n",
  "src/cart/cart.js": fn("addToCart") + fn("removeFromCart"),
  "src/cart/total.js": fn("cartTotal"),
  "src/checkout/checkout.js": fn("placeOrder"),
  "src/checkout/payment.js": fn("chargeCard"),
  "src/inventory/stock.js": fn("stockLevel"),
  "src/inventory/restock.js": fn("restock"),
};

type Terms = { name: string; description: string; files: string[] }[];
const dates: Terms = [
  { name: "Date arithmetic", description: "Dates and the days between them.", files: ["lib/k3.js"] },
  { name: "Text shaping", description: "Slugs and truncated text.", files: ["lib/k4.js", "lib/k5.js"] },
  { name: "Number folding", description: "Totals and means over lists.", files: ["lib/k2.js", "lib/k1.js"] },
];
interface Fake extends AgentRunner {
  calls: number;
  prompts: string[];
}
function runner(answer: () => Promise<{ output: unknown; model: string; usd?: number | null }>): Fake {
  const fake: Fake = {
    calls: 0,
    prompts: [],
    async run(request) {
      fake.calls += 1;
      fake.prompts.push(request.prompt);
      return answer();
    },
  };
  return fake;
}
const saying = (terms: Terms, usd: number | null | undefined = 0.0123): Fake => runner(async () => ({ output: { terms }, model: "claude-sonnet-x", ...(usd === undefined ? {} : { usd }) }));
const read = async (dir: string, cacheDir: string): Promise<StoredVocabulary> => {
  const found = await readVocabulary(dir, cacheDir);
  if (found.kind !== "ok") throw new Error(found.kind);
  return found.stored;
};

test("a poorly named repository gets proposed terms, claimed, stored apart from the terms it wrote", async () => {
  const dir = repo(poor);
  const cacheDir = temp("streets-cache-");
  const ask = saying(dates);
  const result = await setUp({ dir, cacheDir, propose: ask });
  expect(ask.calls).toBe(1);
  expect(result.proposing).toMatchObject({ status: "proposed", asked: true, coverage: { of: 6 } });
  const stored = await read(dir, cacheDir);
  expect(stored.proposals).toMatchObject({ tier: "claimed", model: "claude-sonnet-x", usd: 0.0123 });
  expect(stored.proposals!.terms.map((term) => term.name)).toEqual(["Date arithmetic", "Number folding", "Text shaping"]);
  expect(stored.proposals!.terms[0]).toMatchObject({ pins: [], claimed: { files: ["lib/k3.js"] } });
  // Derived terms never hold a claimed one.
  expect(stored.vocabulary.terms.some((term) => term.claimed !== undefined || term.name === "Date arithmetic")).toBe(false);
  expect(termsOf(stored).filter((term) => term.claimed !== undefined)).toHaveLength(3);
  const text = reportLines(result).join("\n");
  expect(text).toContain("proposed terms (claimed, not written in the repository): 3, by claude-sonnet-x; cost $0.0123");
  expect(text).toContain("Date arithmetic: Dates and the days between them. (1 file)");
});

test("a well named repository gets none, and the model is never asked", async () => {
  const dir = repo(well);
  const cacheDir = temp("streets-cache-");
  const ask = saying(dates);
  const result = await setUp({ dir, cacheDir, propose: ask });
  expect(ask.calls).toBe(0);
  expect(result.proposing).toMatchObject({ status: "not needed" });
  expect((await read(dir, cacheDir)).proposals).toBeUndefined();
  expect(reportLines(result).join("\n")).toContain("so no term is proposed");
});

test("without --propose nothing is sent, nothing is proposed, and the report says how to ask", async () => {
  const dir = repo(poor);
  const cacheDir = temp("streets-cache-");
  const result = await setUp({ dir, cacheDir });
  expect(result.proposing).toMatchObject({ status: "not asked" });
  expect((await read(dir, cacheDir)).proposals).toBeUndefined();
  expect(reportLines(result).join("\n")).toContain("run `streets setup --propose`; nothing was sent");
});

test("a coverage of exactly half does not fall back; one file fewer does; a repository with no code files does not", async () => {
  const half = { "docs/a.md": "# Billing\n", "src/billing.js": fn("sendBill"), "src/zz.js": fn("qq") };
  const cacheDir = temp("streets-cache-");
  const ask = saying(dates);
  expect((await setUp({ dir: repo(half), cacheDir, propose: ask })).proposing).toMatchObject({ status: "not needed", coverage: { of: 2, mapped: 1 } });
  expect(ask.calls).toBe(0);
  const fewer = await setUp({ dir: repo({ ...half, "src/yy.js": fn("rr") }), cacheDir: temp("streets-cache-"), propose: ask });
  expect(fewer.proposing).toMatchObject({ status: "proposed", coverage: { of: 3, mapped: 1 } });
  expect(ask.calls).toBe(1);
  const none = await setUp({ dir: repo({ "README.md": "# Notes\n\ntext\n" }), cacheDir: temp("streets-cache-"), propose: ask });
  expect(none.proposing).toMatchObject({ status: "not needed", coverage: { of: 0, mapped: 0 } });
  expect(ask.calls).toBe(1);
  expect(reportLines(none).join("\n")).toContain("no analysed files");
});

test("a model call that fails, times out, answers nothing or answers malformed terms proposes nothing, and says so rather than saying none", async () => {
  const failures: [string, () => Promise<{ output: unknown; model: string }>][] = [
    ["claude CLI exited with 1: boom", () => Promise.reject(new Error("claude CLI exited with 1: boom"))],
    ["claude CLI timed out after 180s", () => Promise.reject(new Error("claude CLI timed out after 180s"))],
    ["no list of terms", () => Promise.resolve({ output: undefined, model: "m" })],
    ["no list of terms", () => Promise.resolve({ output: { terms: "none" }, model: "m" })],
    ["malformed", () => Promise.resolve({ output: { terms: [{ name: 1 }, 7] }, model: "m" })],
  ];
  for (const [why, answer] of failures) {
    const dir = repo(poor);
    const cacheDir = temp("streets-cache-");
    const result = await setUp({ dir, cacheDir, propose: runner(answer) });
    expect(result.proposing).toMatchObject({ status: "failed", kept: 0 });
    expect(result.proposing!.status === "failed" ? result.proposing!.why : "").toContain(why);
    expect((await read(dir, cacheDir)).proposals).toBeUndefined();
    expect(reportLines(result).join("\n")).toContain("whether terms would be proposed is not known");
  }
});

test("a failed call on a repository that has proposals keeps them, and the next setup asks again", async () => {
  const dir = repo(poor);
  const cacheDir = temp("streets-cache-");
  await setUp({ dir, cacheDir, propose: saying(dates) });
  commit(dir, { "lib/k6.js": fn("padLeft") });
  const failing = runner(() => Promise.reject(new Error("no network")));
  const result = await setUp({ dir, cacheDir, propose: failing });
  expect(result.proposing).toMatchObject({ status: "failed", kept: 3 });
  expect((await read(dir, cacheDir)).proposals!.terms).toHaveLength(3);
  const again = saying(dates);
  await setUp({ dir, cacheDir, propose: again });
  expect(again.calls).toBe(1);
});

test("a cost the call could not report is unknown, never zero", async () => {
  const silent: AgentRunner = { run: () => Promise.resolve({ output: { terms: dates }, model: "claude-sonnet-x" }) };
  for (const ask of [silent, saying(dates, null)]) {
    const dir = repo(poor);
    const cacheDir = temp("streets-cache-");
    const result = await setUp({ dir, cacheDir, propose: ask });
    expect((await read(dir, cacheDir)).proposals!.usd).toBeNull();
    expect(reportLines(result).join("\n")).toContain("cost unknown");
    expect(reportLines(result).join("\n")).not.toContain("$0");
  }
});

test("an answer of no terms is an answer: it is stored and not asked again", async () => {
  const dir = repo(poor);
  const cacheDir = temp("streets-cache-");
  const ask = saying([]);
  await setUp({ dir, cacheDir, propose: ask });
  expect((await read(dir, cacheDir)).proposals).toMatchObject({ terms: [] });
  await setUp({ dir, cacheDir, propose: ask });
  expect(ask.calls).toBe(1);
});

test("a proposal that duplicates a term the repository wrote is dropped and counted", async () => {
  const dir = repo(poor);
  const cacheDir = temp("streets-cache-");
  await setUp({ dir, cacheDir, propose: saying([{ name: "Slugify", description: "d", files: ["lib/k4.js"] }, ...dates]) });
  const stored = await read(dir, cacheDir);
  expect(stored.proposals!.terms.map((term) => term.name)).not.toContain("Slugify");
  expect(stored.proposals!.dropped.duplicate).toBe(1);
});

test("asking again about the same code and words sends nothing; new code asks again", async () => {
  const dir = repo(poor);
  const cacheDir = temp("streets-cache-");
  const ask = saying(dates);
  await setUp({ dir, cacheDir, propose: ask });
  const before = readFileSync((await setUp({ dir, cacheDir, propose: ask })).file, "utf8");
  expect(ask.calls).toBe(1);
  const reused = await setUp({ dir, cacheDir, propose: ask });
  expect(reused.proposing).toMatchObject({ status: "proposed", asked: false });
  expect(readFileSync(reused.file, "utf8")).toBe(before);
  commit(dir, { "lib/k6.js": fn("padLeft") });
  await setUp({ dir, cacheDir, propose: ask });
  expect(ask.calls).toBe(2);
});

test("an earlier setup's proposals are not lost by a setup without --propose, and are dropped once the repository's own words reach half", async () => {
  const dir = repo(poor);
  const cacheDir = temp("streets-cache-");
  await setUp({ dir, cacheDir, propose: saying(dates) });
  commit(dir, { "lib/k6.js": fn("padLeft") });
  await setUp({ dir, cacheDir });
  expect((await read(dir, cacheDir)).proposals!.terms).toHaveLength(3);
  commit(dir, { "docs/words.md": "# Slugs\n\n# Means\n\n# Totals\n\n# Truncates\n\n# Days\n\n# Csv\n\n# Multiplies\n\n# Pads\n" });
  const better = await setUp({ dir, cacheDir });
  expect(better.proposing).toMatchObject({ status: "not needed", dropped: 3 });
  expect((await read(dir, cacheDir)).proposals).toBeUndefined();
});

/* ---- a person's word, and certification ---- */

const stamp = { by: "Dana", at: "2026-11-12T10:00:00.000Z" };
const dateKey = keyOf("Date arithmetic");
const treeOf = (files: Record<string, string>): FileTree => new Map(Object.entries(files));
const docOf = (stored: StoredVocabulary, tree: Record<string, string> = poor) => {
  const head = treeOf(tree);
  return vocabularyDocument({ kind: "ok", stored }, { graph: extract(head), tree: head });
};
const withWord = (stored: StoredVocabulary, corrections: Correction[]): StoredVocabulary => ({ ...stored, corrections }) as StoredVocabulary;

test("a proposed term is drawn as claimed and has no pins; a person's rename and confirm apply to it", async () => {
  const dir = repo(poor);
  const cacheDir = temp("streets-cache-");
  await setUp({ dir, cacheDir, propose: saying(dates) });
  const stored = await read(dir, cacheDir);
  const plain = docOf(stored);
  expect(plain.proposed).toEqual({ count: 3, model: "claude-sonnet-x" });
  const date = plain.terms.find((term) => term.key === dateKey)!;
  expect(date).toMatchObject({ name: "Date arithmetic", pins: [], proposed: { description: "Dates and the days between them.", files: ["lib/k3.js"], model: "claude-sonnet-x" } });
  const worded = docOf(withWord(stored, [{ ...stamp, kind: "rename", term: dateKey, name: "Calendar maths", label: "Date arithmetic" }, { ...stamp, kind: "confirm", term: dateKey, label: "Calendar maths" }]));
  expect(worded.terms.find((term) => term.key === dateKey)).toMatchObject({ name: "Calendar maths", renamedFrom: "Date arithmetic", confirmed: stamp, proposed: expect.any(Object) });
});

test("a term the person removed is not shown, and is not proposed again on the next setup, even when new code asks the model again", async () => {
  const dir = repo(poor);
  const cacheDir = temp("streets-cache-");
  const first = await setUp({ dir, cacheDir, propose: saying(dates) });
  const stored = await read(dir, cacheDir);
  const removed: Correction = { ...stamp, kind: "remove", term: dateKey, label: "Date arithmetic" };
  writeFileSync(first.file, JSON.stringify({ ...stored, corrections: [removed] }));
  expect(docOf(await read(dir, cacheDir)).terms.map((term) => term.name)).not.toContain("Date arithmetic");
  commit(dir, { "lib/k6.js": fn("padLeft") });
  const ask = saying(dates);
  await setUp({ dir, cacheDir, propose: ask });
  expect(ask.calls).toBe(1);
  expect(ask.prompts[0]).toContain("Terms a person rejected");
  expect(ask.prompts[0]).toContain("Date arithmetic");
  const after = await read(dir, cacheDir);
  expect(after.proposals!.dropped.rejected).toBe(1);
  expect(after.proposals!.terms.filter((term) => term.key === dateKey)).toHaveLength(1);
  const shownNames = docOf(after, { ...poor, "lib/k6.js": fn("padLeft") }).terms.map((term) => term.name);
  expect(shownNames).not.toContain("Date arithmetic");
  expect(shownNames).toContain("Text shaping");
  // A confirm brings it back, and it is then proposed-and-kept.
  const confirmed = { ...after, corrections: [removed, { ...stamp, kind: "confirm" as const, term: dateKey, label: "Date arithmetic" }] } as StoredVocabulary;
  expect(docOf(confirmed, { ...poor, "lib/k6.js": fn("padLeft") }).terms.map((term) => term.name)).toContain("Date arithmetic");
});

test("a person's word on a function wins over what the judged answer says about a proposed term", async () => {
  const dir = repo(poor);
  const cacheDir = temp("streets-cache-");
  const judge: JevClient = {
    model: "fake-1",
    async ask(request: JevRequest): Promise<JevResponse> {
      return { answers: { belongs: { type: "yes-no", yes: 0.97 }, incidental: { type: "yes-no", yes: 0.02 } }, usage: { inputTokens: 1, outputTokens: 1, usd: jevCost(1) }, model: request.questions.belongs === undefined ? "x" : "fake-1" };
    },
  };
  await setUp({ dir, cacheDir, propose: saying(dates), judge });
  const stored = await read(dir, cacheDir);
  const unit = stored.memberships!.units.find((one) => one.name === "isoDay")!;
  expect(unit.candidates).toContain(dateKey);
  const judged = docOf(stored);
  expect(judged.terms.find((term) => term.key === dateKey)!.members.map((member) => member.name)).toContain("isoDay");
  expect(judged.files.find((file) => file.path === "lib/k3.js")!.terms).toEqual(expect.arrayContaining([expect.objectContaining({ key: dateKey, claimed: true, probability: 0.97 })]));
  const no = docOf(withWord(stored, [{ ...stamp, kind: "member", unit: unit.key, term: dateKey, belongs: false, label: "isoDay, term Date arithmetic" }]));
  expect(no.terms.find((term) => term.key === dateKey)!.members.map((member) => member.name)).not.toContain("isoDay");
  const yes = docOf(withWord(stored, [{ ...stamp, kind: "member", unit: stored.memberships!.units.find((one) => one.name === "multiply")!.key, term: dateKey, belongs: true, label: "multiply, term Date arithmetic" }]));
  expect(yes.terms.find((term) => term.key === dateKey)!.members.find((member) => member.name === "multiply")).toMatchObject({ corrected: stamp, probability: null });
});

test("Jev judges every mapping to a proposed term, and is shown that the term is a model's proposal", async () => {
  const dir = repo(poor);
  const cacheDir = temp("streets-cache-");
  const seen: string[] = [];
  const judge: JevClient = {
    model: "fake-1",
    async ask(request: JevRequest): Promise<JevResponse> {
      seen.push(request.state.term ?? "");
      return { answers: { belongs: { type: "yes-no", yes: 0.5 }, incidental: { type: "yes-no", yes: 0.5 } }, usage: { inputTokens: 1, outputTokens: 1, usd: jevCost(1) }, model: "fake-1" };
    },
  };
  await setUp({ dir, cacheDir, propose: saying(dates), judge });
  const stored = await read(dir, cacheDir);
  const proposedPairs = stored.memberships!.records.filter((record) => stored.proposals!.terms.some((term) => term.key === record.term));
  // Every unit of a file a proposed term named is asked about it: lib/k3.js has two units.
  expect(proposedPairs.filter((record) => record.term === dateKey)).toHaveLength(2);
  expect(seen.filter((text) => text.startsWith("Term: Date arithmetic\nProposed by a model, not written in this repository")).length).toBeGreaterThanOrEqual(2);
  // A middle-band answer maps nothing: the proposal alone puts no function in a term.
  expect(docOf(stored).terms.find((term) => term.key === dateKey)!.members).toEqual([]);
});

test("a vocabulary with proposed terms is never shown as certified unless a person certified it, and a certification does not outlive a change of terms", async () => {
  const dir = repo(poor);
  const cacheDir = temp("streets-cache-");
  const first = await setUp({ dir, cacheDir });
  const own = await read(dir, cacheDir);
  // Certified over the repository's own terms only.
  const certification = { by: "Grace", at: "2026-11-12T08:00:00.000Z", vocabulary: vocabularyDigest(termsOf(own)), corrections: correctionsDigest([]) };
  writeFileSync(first.file, JSON.stringify({ ...own, certification }));
  expect(docOf(await read(dir, cacheDir)).certification).toEqual({ kind: "certified", by: "Grace", at: certification.at });
  await setUp({ dir, cacheDir, propose: saying(dates) });
  const proposed = await read(dir, cacheDir);
  expect(proposed.certification).toEqual(certification);
  expect(docOf(proposed).certification).toEqual({ kind: "changed", by: "Grace", at: certification.at });
  expect(reportLines({ ...first, stored: proposed }).join("\n")).toContain("certified by Grace at 2026-11-12T08:00:00.000Z, vocabulary changed since");
  // With no certification at all it is drafted.
  const dir2 = repo(poor);
  const cache2 = temp("streets-cache-");
  await setUp({ dir: dir2, cacheDir: cache2, propose: saying(dates) });
  expect(docOf(await read(dir2, cache2)).certification).toEqual({ kind: "drafted" });
});

test("a proposed term merged with a term the repository wrote is not claimed, and a no on one part still holds after the merge", async () => {
  const dir = repo(poor);
  const cacheDir = temp("streets-cache-");
  const judge: JevClient = {
    model: "fake-1",
    async ask(): Promise<JevResponse> {
      return { answers: { belongs: { type: "yes-no", yes: 0.97 }, incidental: { type: "yes-no", yes: 0.02 } }, usage: { inputTokens: 1, outputTokens: 1, usd: jevCost(1) }, model: "fake-1" };
    },
  };
  await setUp({ dir, cacheDir, propose: saying(dates), judge });
  const stored = await read(dir, cacheDir);
  const csv = stored.vocabulary.terms.find((term) => term.key === keyOf("csv"))!;
  const unit = stored.memberships!.units.find((one) => one.name === "isoDay")!;
  const merged = docOf(withWord(stored, [{ ...stamp, kind: "member", unit: unit.key, term: dateKey, belongs: false, label: "isoDay, term Date arithmetic" }, { ...stamp, kind: "merge", term: dateKey, into: csv.key, label: "Date arithmetic into csv" }]));
  const into = merged.terms.find((term) => term.key === csv.key)!;
  expect(into.proposed).toBeUndefined();
  expect(into.mergedFrom).toEqual(["Date arithmetic"]);
  expect(into.members.map((member) => member.name)).not.toContain("isoDay");
  expect(merged.files.find((file) => file.path === "lib/k3.js")!.terms.map((term) => term.claimed)).not.toContain(true);
  expect(merged.proposed).toEqual({ count: 2, model: "claude-sonnet-x" });
});
