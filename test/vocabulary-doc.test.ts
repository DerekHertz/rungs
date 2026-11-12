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
const treeOf = (record: Record<string, string>): FileTree => new Map(Object.entries(record));
const ok = (read: StoredRead): StoredVocabulary => {
  if (read.kind !== "ok") throw new Error(`stored vocabulary is ${read.kind}`);
  return read.stored;
};
const asRead = (stored: StoredVocabulary): StoredRead => ({ kind: "ok", stored });
const build = (read: StoredRead, head: Record<string, string>) => {
  const tree = treeOf(head);
  return vocabularyDocument(read, { graph: extract(tree), tree });
};
const entry = (doc: ReturnType<typeof build>, path: string) => doc.files.find((one) => one.path === path);

/** A stored vocabulary, judged by a fake classifier that answers `table` with `extra` laid over it and a confident no for the rest. */
async function judgedStoreWith(tree: Record<string, string>, extra: Record<string, number>): Promise<StoredVocabulary> {
  const dir = repo(tree);
  const cacheDir = temp("streets-cache-");
  const answering: JevClient = {
    model: "fake-1",
    async ask(request): Promise<JevResponse> {
      const term = /^Term: (.*)$/m.exec(request.state.term ?? "")?.[1] ?? "?";
      const unit = /^(?:function|class|constant) (\S+) in /m.exec(request.state.code ?? "")?.[1] ?? "?";
      const belongs = { ...table, ...extra }[`${term} | ${unit}`] ?? 0.03;
      return { answers: { belongs: { type: "yes-no", yes: belongs }, incidental: { type: "yes-no", yes: 0.02 } }, usage: { inputTokens: 1, outputTokens: 1, usd: jevCost(1) }, model: "fake-1" };
    },
  };
  await setUp({ dir, cacheDir, judge: answering });
  return ok(await readVocabulary(dir, cacheDir));
}
const judgedStore = (): Promise<StoredVocabulary> => judgedStoreWith(files, {});

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
  const doc = build(asRead(await judgedStore()), files);
  expect(doc).toMatchObject({ judged: true, model: "fake-1" });
  const stripe = entry(doc, "src/payments/stripe.ts")!;
  expect(stripe.terms.map((term) => [term.name, term.probability])).toEqual([["payments", 0.93]]);
  expect(stripe.units).toEqual({ total: 1, withTerm: 1, notJudged: 0, stale: 0, noTerm: 0, noCandidate: 0 });
  expect(stripe.members).toEqual([{ id: "function:src/payments/stripe.ts#chargeCard", terms: [{ key: "payment", name: "payments", probability: 0.93 }] }]);
  const payments = doc.terms.find((term) => term.key === "payment")!;
  expect(payments.members).toEqual([{ path: "src/payments/stripe.ts", name: "chargeCard", level: "function", probability: 0.93, state: "member", id: "function:src/payments/stripe.ts#chargeCard" }]);
  expect(payments.summary).toEqual({ kind: "has members", why: "1 member" });
});

test("a function this change edited is stale, not judged again and never 'no term'; a new function is not judged", async () => {
  const head = { ...files, "src/orders/place.ts": "export function placeOrder(): number {\n  return 2;\n}\n", "src/orders/cancel.ts": "export function cancelOrder(): void {}\n" };
  const doc = build(asRead(await judgedStore()), head);
  expect(entry(doc, "src/orders/place.ts")).toMatchObject({ terms: [], units: { total: 1, stale: 1, withTerm: 0, notJudged: 0, noTerm: 0 } });
  expect(entry(doc, "src/orders/cancel.ts")).toMatchObject({ terms: [], units: { total: 1, notJudged: 1, stale: 0 } });
  // The term still lists the member it had, as stale: its probability is shown, labelled, and not counted.
  const orders = doc.terms.find((term) => term.key === "order")!;
  expect(orders.members).toEqual([expect.objectContaining({ name: "placeOrder", probability: 0.97, state: "stale" })]);
  expect(entry(doc, "src/payments/stripe.ts")!.terms).toHaveLength(1);
});

test("a member the head no longer has is stale, with no node to open", async () => {
  const head = { ...files };
  delete head["src/orders/place.ts"];
  const doc = build(asRead(await judgedStore()), head);
  const orders = doc.terms.find((term) => term.key === "order")!;
  expect(orders.members).toEqual([{ path: "src/orders/place.ts", name: "placeOrder", level: "function", probability: 0.97, state: "stale", why: "not in this tree" }]);
});

test("a pin opens its file only when the head's file is the file the pin was read from (the stored digest), else it is text saying the file changed since setup", async () => {
  const dir = repo(files);
  const cacheDir = temp("streets-cache-");
  await setUp({ dir, cacheDir });
  const read = await readVocabulary(dir, cacheDir);
  // The heading changed since setup: the old pin's lines now hold something unrelated.
  const head = { ...files, "docs/guide.md": "# Something else\n\ntext\n\n## Payment providers\n\ntext\n" };
  const flow = build(read, head).terms.find((term) => term.key === "order flow")!;
  const pin = flow.pins.find((one) => one.path === "docs/guide.md")!;
  expect(pin.id).toBeUndefined();
  expect(pin.why).toBe("the file changed since setup");
  const same = build(read, files);
  expect(same.terms.find((term) => term.key === "order flow")!.pins.find((one) => one.path === "docs/guide.md")).toMatchObject({ id: "file:docs/guide.md" });
  const gone = { ...files };
  delete gone["docs/guide.md"];
  expect(build(read, gone).terms.find((term) => term.key === "order flow")!.pins.find((one) => one.path === "docs/guide.md")).toMatchObject({ why: "the file is not in this tree" });
});

test("a stored path or name that was withheld reads as null, so the page shows 'withheld'", async () => {
  const stored = await judgedStore();
  const terms = stored.vocabulary.terms.map((term, at) => (at === 0 ? { ...term, pins: term.pins.map((pin) => ({ ...pin, path: "/withheld:0123456789ab" })) } : term));
  const memberships = { ...stored.memberships!, units: stored.memberships!.units.map((unit) => (unit.name === "chargeCard" ? { ...unit, path: "/withheld:0123456789ab", name: "withheld" } : unit)) };
  const doc = build(asRead({ ...stored, vocabulary: { ...stored.vocabulary, terms }, memberships }), files);
  expect(doc.terms[0]!.pins.every((pin) => pin.path === null && pin.id === undefined)).toBe(true);
  const payments = doc.terms.find((term) => term.key === "payment")!;
  expect(payments.members[0]).toMatchObject({ path: null, name: null });
});

test("a store built with other rules makes every stored answer stale: never a member and never 'no term'", async () => {
  const stored = await judgedStore();
  const memberships = stored.memberships!;
  const changes: Record<string, StoredVocabulary> = {
    table: { ...stored, vocabulary: { ...stored.vocabulary, tableVersion: stored.vocabulary.tableVersion - 1 } },
    extractor: { ...stored, extractorVersion: "0" },
    narrowing: { ...stored, memberships: { ...memberships, narrowing: { ...memberships.narrowing, version: 0 } } },
    candidates: { ...stored, memberships: { ...memberships, narrowing: { ...memberships.narrowing, maxCandidates: 1 } } },
    gate: { ...stored, memberships: { ...memberships, gate: { ...memberships.gate, version: "membership-v0" } } },
    thresholds: { ...stored, memberships: { ...memberships, thresholds: { ...memberships.thresholds, belongs: 0.5 } } },
  };
  for (const [name, changed] of Object.entries(changes)) {
    const doc = build(asRead(changed), files);
    expect(doc.rules, name).toBeDefined();
    expect(doc.terms.length).toBeGreaterThan(0);
    for (const file of doc.files) {
      expect(file.terms, name).toEqual([]);
      expect(file.members, name).toEqual([]);
      expect(file.units, name).toMatchObject({ withTerm: 0, notJudged: 0, noTerm: 0, noCandidate: 0, stale: file.units.total });
    }
    for (const term of doc.terms) {
      expect(term.members.every((member) => member.state === "stale"), name).toBe(true);
      expect(term.summary.kind, name).toBe("not known");
    }
  }
  expect(build(asRead(changes.table!), files).rules).toMatch(/^table \d+, this version uses \d+$/);
});

test("a record whose own question or thresholds are not the current ones is stale", async () => {
  const stored = await judgedStore();
  const memberships = stored.memberships!;
  const records = memberships.records.map((record) => (record.unit.endsWith("#placeOrder") ? { ...record, thresholds: { ...record.thresholds, belongs: 0.5 } } : record.unit.endsWith("#chargeCard") ? { ...record, question: { ...record.question, version: "membership-v0" } } : record));
  const doc = build(asRead({ ...stored, memberships: { ...memberships, records } }), files);
  expect(entry(doc, "src/orders/place.ts")).toMatchObject({ terms: [], units: { stale: 1, withTerm: 0, noTerm: 0 } });
  expect(entry(doc, "src/payments/stripe.ts")).toMatchObject({ terms: [], units: { stale: 1, withTerm: 0, noTerm: 0 } });
});

test("a record whose digest changed while its function did not is stale on the card and in the term detail alike", async () => {
  const stored = await judgedStore();
  const records = stored.memberships!.records.map((record) => (record.unit.endsWith("#chargeCard") ? { ...record, digest: "0".repeat(32) } : record));
  const doc = build(asRead({ ...stored, memberships: { ...stored.memberships!, records } }), files);
  expect(entry(doc, "src/payments/stripe.ts")).toMatchObject({ terms: [], members: [], units: { stale: 1, withTerm: 0, noTerm: 0 } });
  const payments = doc.terms.find((term) => term.key === "payment")!;
  expect(payments.members).toEqual([expect.objectContaining({ name: "chargeCard", state: "stale" })]);
  expect(payments.summary.kind).not.toBe("has members");
});

test("a record whose term's definition changed in the head is stale", async () => {
  const stored = await judgedStoreWith(files, { "Order flow | placeOrder": 0.96 });
  const fresh = build(asRead(stored), files);
  expect(entry(fresh, "src/orders/place.ts")!.terms.map((term) => term.name).sort()).toEqual(["Order flow", "orders"]);
  // The words under the heading are what the classifier was shown of the term: change them.
  const head = { ...files, "docs/guide.md": "# Order flow\n\nsomething else entirely\n\n## Payment providers\n\ntext\n" };
  const doc = build(asRead(stored), head);
  expect(entry(doc, "src/orders/place.ts")!.terms.map((term) => term.name)).toEqual(["orders"]);
  const flow = doc.terms.find((term) => term.key === "order flow")!;
  expect(flow.members).toEqual([expect.objectContaining({ name: "placeOrder", state: "stale", why: "the term's definition changed" })]);
});

test("a stored unit whose path, name or level disagrees with the function it is matched to is stale, not a member", async () => {
  const stored = await judgedStore();
  const memberships = stored.memberships!;
  for (const change of [{ name: "someoneElse" }, { path: "src/elsewhere.ts" }, { level: "class" as const }]) {
    const units = memberships.units.map((unit) => (unit.name === "chargeCard" ? { ...unit, ...change } : unit));
    const doc = build(asRead({ ...stored, memberships: { ...memberships, units } }), files);
    expect(entry(doc, "src/payments/stripe.ts"), JSON.stringify(change)).toMatchObject({ terms: [], members: [], units: { stale: 1, withTerm: 0 } });
    expect(doc.terms.find((term) => term.key === "payment")!.members.every((member) => member.state === "stale"), JSON.stringify(change)).toBe(true);
  }
});

test("a term's members and count are only the records valid against the head: editing one of two members leaves one", async () => {
  const two = { ...files, "src/orders/cancel.ts": "export function cancelOrder(): void {}\n" };
  const stored = await judgedStoreWith(two, { "orders | cancelOrder": 0.96 });
  const head = { ...two, "src/orders/place.ts": "export function placeOrder(): number {\n  return 1;\n}\n" };
  const orders = build(asRead(stored), head).terms.find((term) => term.key === "order")!;
  expect(orders.members.map((member) => [member.name, member.state])).toEqual([["cancelOrder", "member"], ["placeOrder", "stale"]]);
  expect(orders.summary).toMatchObject({ kind: "has members", why: "1 member, 1 stale" });
  expect(build(asRead(stored), two).terms.find((term) => term.key === "order")!.summary).toMatchObject({ kind: "has members", why: "2 members" });
});

test("a function no term is a candidate for is 'no candidate term', never judged; one judged against its candidates is 'no term'", async () => {
  const stored = await judgedStore();
  expect(stored.memberships!.units.find((unit) => unit.name === "oddJob")!.candidates).toEqual([]);
  expect(entry(build(asRead(stored), files), "src/misc/odd.ts")).toMatchObject({ units: { total: 1, noCandidate: 1, noTerm: 0, notJudged: 0, stale: 0 } });
  const withCandidate = { ...files, "src/orders/misc.ts": "export function orderTrivia(): void {}\n" };
  const judged = build(asRead(await judgedStoreWith(withCandidate, {})), withCandidate);
  expect(entry(judged, "src/orders/misc.ts")!.units).toMatchObject({ total: 1, noTerm: 1, noCandidate: 0 });
});

test("a candidate pair that has no stored record is not judged, never 'no term'", async () => {
  const stored = await judgedStore();
  const records = stored.memberships!.records.filter((record) => !record.unit.endsWith("#chargeCard"));
  const doc = build(asRead({ ...stored, memberships: { ...stored.memberships!, records } }), files);
  expect(entry(doc, "src/payments/stripe.ts")!.units).toMatchObject({ notJudged: 1, noTerm: 0, withTerm: 0 });
});

test("a vocabulary of no terms or unknown terms keeps that status", async () => {
  const dir = repo({ "src/a.ts": "export const a = 1;\n" });
  const cacheDir = temp("streets-cache-");
  await setUp({ dir, cacheDir });
  const stored = ok(await readVocabulary(dir, cacheDir));
  const doc = build(asRead({ ...stored, vocabulary: { ...stored.vocabulary, status: "unknown", reason: "a file could not be read: x.ts", terms: [] } }), { "src/a.ts": "export const a = 1;\n" });
  expect(doc).toMatchObject({ termsStatus: "unknown", reason: "a file could not be read: x.ts" });
});

test("a file no adapter reads, or one that could not be read, is marked unread: its terms are not known, not 'no function'", async () => {
  const head = { ...files, "src/worker.py": "def run():\n  pass\n", "src/broken.ts": "export function broken( {\n" };
  const doc = build(asRead(await judgedStore()), head);
  expect(entry(doc, "src/worker.py")).toMatchObject({ unread: "no adapter", terms: [], units: { total: 0 } });
  expect(entry(doc, "src/broken.ts")).toMatchObject({ unread: "could not be read", terms: [], units: { total: 0 } });
  expect(entry(doc, "src/orders/place.ts")!.unread).toBeUndefined();
});

test("a term with no members reads 'not known' while the head has a code file that could not be read, never 'no members'", async () => {
  const stored = await judgedStore();
  const providers = (doc: ReturnType<typeof build>) => doc.terms.find((term) => term.key === "payment provider")!;
  expect(providers(build(asRead(stored), files)).summary.kind).toBe("no members");
  const doc = build(asRead(stored), { ...files, "src/worker.py": "def run():\n  pass\n" });
  expect(providers(doc).summary).toEqual({ kind: "not known", why: "1 code file in this tree could not be read" });
  const broken = build(asRead(stored), { ...files, "src/broken.ts": "export function broken( {\n" });
  expect(providers(broken).summary.why).toBe("1 code file in this tree could not be read");
});

test("a term whose judged member the head lost is 'not known', and says the member's file could not be read when it is unreadable", async () => {
  const stored = await judgedStore();
  const orders = (doc: ReturnType<typeof build>) => doc.terms.find((term) => term.key === "order")!;
  const removed = { ...files };
  delete removed["src/orders/place.ts"];
  expect(orders(build(asRead(stored), removed)).summary).toEqual({ kind: "not known", why: "1 stored member not in this tree" });
  const broken = build(asRead(stored), { ...files, "src/orders/place.ts": "export function placeOrder( {\n" });
  expect(orders(broken).summary).toEqual({ kind: "not known", why: "1 stored member whose file could not be read, 1 code file in this tree could not be read" });
});

test("a stale file says why: the function changed, the term's definition changed, or the rules changed", async () => {
  const stored = await judgedStore();
  const edited = { ...files, "src/orders/place.ts": "export function placeOrder(): number {\n  return 2;\n}\n" };
  expect(entry(build(asRead(stored), edited), "src/orders/place.ts")!.staleWhy).toEqual(["the function changed"]);
  // A function whose only candidate is a term the head redefined: the function is unchanged, the term is what changed.
  const withFlow = { ...files, "src/flow.ts": "export function flowStep(): void {}\n" };
  const flowStored = await judgedStoreWith(withFlow, {});
  const termChanged = { ...withFlow, "docs/guide.md": "# Order flow\n\nsomething else entirely\n\n## Payment providers\n\ntext\n" };
  expect(entry(build(asRead(flowStored), termChanged), "src/flow.ts")).toMatchObject({ staleWhy: ["the term's definition changed"], units: { stale: 1 } });
  const rules = build(asRead({ ...stored, extractorVersion: "0" }), files);
  expect(entry(rules, "src/orders/place.ts")!.staleWhy).toEqual(["rules changed: run streets setup"]);
});

test("a capped member list counts what it leaves out by validity: stale ones listed last, and omitted current and stale counted apart", async () => {
  const many: Record<string, string> = { ...files };
  const extra: Record<string, number> = {};
  for (let i = 0; i < 101; i++) {
    many[`src/orders/o${i}.ts`] = `export function order${i}(): void {}\n`;
    extra[`orders | order${i}`] = 0.95;
  }
  const stored = await judgedStoreWith(many, extra);
  const orders = (doc: ReturnType<typeof build>) => doc.terms.find((term) => term.key === "order")!;
  // 102 members, 100 of them changed in the head: the two current ones are listed first, and the two left out are stale.
  const head = { ...many };
  for (let i = 0; i < 100; i++) head[`src/orders/o${i}.ts`] = `export function order${i}(): number {\n  return ${i};\n}\n`;
  const changed = orders(build(asRead(stored), head));
  expect(changed.members).toHaveLength(100);
  expect(changed.members.filter((member) => member.state === "member")).toHaveLength(2);
  expect(changed.membersOmitted).toEqual({ current: 0, stale: 2 });
  expect(changed.summary.why).toBe("2 members, 100 stale");
  // None changed: all 102 are current, so what is left out is current.
  const same = orders(build(asRead(stored), many));
  expect(same.membersOmitted).toEqual({ current: 2, stale: 0 });
});
