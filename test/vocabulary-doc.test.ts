import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { extract } from "../src/extract/extract.ts";
import type { FileTree } from "../src/graph.ts";
import { jevCost } from "../src/jev/client.ts";
import type { JevClient, JevResponse } from "../src/jev/client.ts";
import { readVocabulary, setUp } from "../src/setup.ts";
import type { StoredRead, StoredVocabulary } from "../src/setup.ts";
import { vocabularyDocument } from "../src/vocabulary-doc.ts";

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
function repo(files: Record<string, string>): string {
  const dir = temp("streets-vdoc-");
  git(dir, "init", "--quiet", "--initial-branch=main");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  git(dir, "add", "--all");
  git(dir, "commit", "--quiet", "-m", "base");
  return dir;
}

const files: Record<string, string> = {
  "package.json": '{\n  "description": "Checkout service for the shop"\n}\n',
  "docs/guide.md": "# Order flow\n\ntext\n\n## Payment providers\n\ntext\n",
  "src/payments/stripe.ts": "// Charges a card.\nexport function chargeCard(amount: number): void {\n  void amount;\n}\n",
  "src/orders/place.ts": "export function placeOrder(): void {}\n",
  "src/misc/odd.ts": "export function oddJob(): void {}\n",
};
const table: Record<string, number> = { "orders | placeOrder": 0.97, "payments | chargeCard": 0.93 };
const client: JevClient = {
  model: "fake-1",
  async ask(request): Promise<JevResponse> {
    const term = /^Term: (.*)$/m.exec(request.state.term ?? "")?.[1] ?? "?";
    const unit = /^(?:function|class|constant) (\S+) in /m.exec(request.state.code ?? "")?.[1] ?? "?";
    const belongs = table[`${term} | ${unit}`] ?? 0.03;
    return { answers: { belongs: { type: "yes-no", yes: belongs }, incidental: { type: "yes-no", yes: 0.02 } }, usage: { inputTokens: 1, outputTokens: 1, usd: jevCost(1) }, model: "fake-1" };
  },
};
const treeOf = (record: Record<string, string>): FileTree => new Map(Object.entries(record));
const ok = (read: StoredRead): StoredVocabulary => {
  if (read.kind !== "ok") throw new Error(`stored vocabulary is ${read.kind}`);
  return read.stored;
};
const build = (read: StoredRead, head: Record<string, string>, base: Record<string, string> = files) => {
  const tree = treeOf(head);
  return vocabularyDocument(read, { graph: extract(tree), tree }, treeOf(base));
};
const entry = (doc: ReturnType<typeof build>, path: string) => doc.files.find((one) => one.path === path);

test("no stored vocabulary is 'none', with no terms and no file entries: the page says to run setup", async () => {
  const read = await readVocabulary(repo(files), temp("streets-cache-"));
  expect(read.kind).toBe("missing");
  const doc = build(read, files);
  expect(doc).toMatchObject({ tier: "derived", state: "none", terms: [], files: [], judged: false });
});

test("an unreadable stored file is 'unreadable' with why, never 'none'", () => {
  const doc = build({ kind: "unreadable", why: "it is not JSON" }, files);
  expect(doc).toMatchObject({ state: "unreadable", why: "it is not JSON", terms: [] });
});

test("a vocabulary stored without judging lists terms with their lines, and every file's functions as not judged", async () => {
  const dir = repo(files);
  const cacheDir = temp("streets-cache-");
  await setUp({ dir, cacheDir });
  const doc = build(await readVocabulary(dir, cacheDir), files);
  expect(doc).toMatchObject({ state: "stored", judged: false, termsStatus: "found" });
  const orders = doc.terms.find((term) => term.key === "order")!;
  expect(orders.pins.length).toBeGreaterThan(0);
  expect(orders.pins.every((pin) => typeof pin.written === "string")).toBe(true);
  expect(orders.members).toEqual([]);
  expect(entry(doc, "src/orders/place.ts")).toMatchObject({ terms: [], units: { total: 1, notJudged: 1, withTerm: 0, stale: 0, noTerm: 0 } });
});

test("with judging, a file's terms carry the probability and its functions are counted as with a term", async () => {
  const dir = repo(files);
  const cacheDir = temp("streets-cache-");
  await setUp({ dir, cacheDir, judge: client });
  const doc = build(await readVocabulary(dir, cacheDir), files);
  expect(doc).toMatchObject({ judged: true, model: "fake-1" });
  const stripe = entry(doc, "src/payments/stripe.ts")!;
  expect(stripe.terms.map((term) => [term.name, term.probability])).toEqual([["payments", 0.93]]);
  expect(stripe.units).toEqual({ total: 1, withTerm: 1, notJudged: 0, stale: 0, noTerm: 0 });
  expect(stripe.members).toEqual([{ id: "function:src/payments/stripe.ts#chargeCard", terms: [{ key: "payment", name: "payments", probability: 0.93 }] }]);
  // A function every candidate was judged not a member of is "no term", which is a judged answer.
  expect(entry(doc, "src/misc/odd.ts")!.units).toMatchObject({ total: 1, withTerm: 0, notJudged: 0, stale: 0 });
  const payments = doc.terms.find((term) => term.key === "payment")!;
  expect(payments.members).toEqual([{ path: "src/payments/stripe.ts", name: "chargeCard", level: "function", probability: 0.93, state: "member", id: "function:src/payments/stripe.ts#chargeCard" }]);
  expect(payments.summary.kind).toBe("has members");
});

test("a function this change edited is stale, not judged again and never 'no term'; a new function is not judged", async () => {
  const dir = repo(files);
  const cacheDir = temp("streets-cache-");
  await setUp({ dir, cacheDir, judge: client });
  const head = { ...files, "src/orders/place.ts": "export function placeOrder(): number {\n  return 2;\n}\n", "src/orders/cancel.ts": "export function cancelOrder(): void {}\n" };
  const doc = build(await readVocabulary(dir, cacheDir), head);
  expect(entry(doc, "src/orders/place.ts")).toMatchObject({ terms: [], units: { total: 1, stale: 1, withTerm: 0, notJudged: 0, noTerm: 0 } });
  expect(entry(doc, "src/orders/cancel.ts")).toMatchObject({ terms: [], units: { total: 1, notJudged: 1, stale: 0 } });
  // The term still lists the member it had, as stale: its probability is shown, labelled, and not counted.
  const orders = doc.terms.find((term) => term.key === "order")!;
  expect(orders.members).toEqual([expect.objectContaining({ name: "placeOrder", probability: 0.97, state: "stale" })]);
  // An unchanged file is untouched by the change.
  expect(entry(doc, "src/payments/stripe.ts")!.terms).toHaveLength(1);
});

test("a member the head no longer has is stale, with no node to open", async () => {
  const dir = repo(files);
  const cacheDir = temp("streets-cache-");
  await setUp({ dir, cacheDir, judge: client });
  const head = { ...files };
  delete head["src/orders/place.ts"];
  const doc = build(await readVocabulary(dir, cacheDir), head);
  const orders = doc.terms.find((term) => term.key === "order")!;
  expect(orders.members).toEqual([{ path: "src/orders/place.ts", name: "placeOrder", level: "function", probability: 0.97, state: "stale", why: "not in this tree" }]);
});

test("a pin opens its file only when the head has the same text the pin was read from", async () => {
  const dir = repo(files);
  const cacheDir = temp("streets-cache-");
  await setUp({ dir, cacheDir });
  const head = { ...files, "docs/guide.md": "# Order flow\n\nchanged\n\n## Payment providers\n\ntext\n" };
  const doc = build(await readVocabulary(dir, cacheDir), head);
  const flow = doc.terms.find((term) => term.key === "order flow")!;
  expect(flow.pins.find((pin) => pin.path === "docs/guide.md")?.id).toBeUndefined();
  const providers = doc.terms.find((term) => term.key === "payment provider")!;
  expect(providers.pins.find((pin) => pin.path === "docs/guide.md")?.id).toBeUndefined();
  const same = build(await readVocabulary(dir, cacheDir), files);
  expect(same.terms.find((term) => term.key === "order flow")!.pins.find((pin) => pin.path === "docs/guide.md")).toMatchObject({ id: "file:docs/guide.md" });
});

test("a stored path or name that was withheld reads as null, so the page shows 'withheld'", async () => {
  const dir = repo(files);
  const cacheDir = temp("streets-cache-");
  await setUp({ dir, cacheDir, judge: client });
  const stored = ok(await readVocabulary(dir, cacheDir));
  const terms = stored.vocabulary.terms.map((term, at) => (at === 0 ? { ...term, pins: term.pins.map((pin) => ({ ...pin, path: "/withheld:0123456789ab" })) } : term));
  const memberships = { ...stored.memberships!, units: stored.memberships!.units.map((unit) => (unit.name === "chargeCard" ? { ...unit, path: "/withheld:0123456789ab", name: "withheld" } : unit)) };
  const doc = build({ kind: "ok", stored: { ...stored, vocabulary: { ...stored.vocabulary, terms }, memberships } }, files);
  expect(doc.terms[0]!.pins.every((pin) => pin.path === null && pin.id === undefined)).toBe(true);
  const payments = doc.terms.find((term) => term.key === "payment")!;
  expect(payments.members[0]).toMatchObject({ path: null, name: null });
});

test("a vocabulary built with other rules is served with a note, and its terms are not hidden", async () => {
  const dir = repo(files);
  const cacheDir = temp("streets-cache-");
  await setUp({ dir, cacheDir, judge: client });
  const stored = ok(await readVocabulary(dir, cacheDir));
  const doc = build({ kind: "ok", stored: { ...stored, vocabulary: { ...stored.vocabulary, tableVersion: stored.vocabulary.tableVersion - 1 } } }, files);
  expect(doc.rules).toMatch(/^table \d+, this version uses \d+$/);
  expect(doc.terms.length).toBeGreaterThan(0);
});

test("a vocabulary of no terms or unknown terms keeps that status", async () => {
  const dir = repo({ "src/a.ts": "export const a = 1;\n" });
  const cacheDir = temp("streets-cache-");
  await setUp({ dir, cacheDir });
  const stored = ok(await readVocabulary(dir, cacheDir));
  const doc = build({ kind: "ok", stored: { ...stored, vocabulary: { ...stored.vocabulary, status: "unknown", reason: "a file could not be read: x.ts", terms: [] } } }, { "src/a.ts": "export const a = 1;\n" });
  expect(doc).toMatchObject({ termsStatus: "unknown", reason: "a file could not be read: x.ts" });
});
