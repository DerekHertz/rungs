import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { correctionsDigest, vocabularyDigest } from "../src/corrections.ts";
import type { Correction } from "../src/corrections.ts";
import { extract } from "../src/extract/extract.ts";
import type { FileTree } from "../src/graph.ts";
import { jevCost } from "../src/jev/client.ts";
import type { JevClient, JevResponse } from "../src/jev/client.ts";
import { readVocabulary } from "../src/setup.ts";
import type { StoredRead, StoredVocabulary } from "../src/setup.ts";
import { setUp } from "./setup-no-stakes.ts";
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
  const dir = temp("streets-vcorr-");
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
const asRead = (stored: StoredVocabulary): StoredRead => ({ kind: "ok", stored });
const build = (stored: StoredVocabulary, head: Record<string, string> = files) => {
  const tree = treeOf(head);
  return vocabularyDocument(asRead(stored), { graph: extract(tree), tree });
};
const entry = (doc: ReturnType<typeof build>, path: string) => doc.files.find((one) => one.path === path);

const answering: JevClient = {
  model: "fake-1",
  async ask(request): Promise<JevResponse> {
    const term = /^Term: (.*)$/m.exec(request.state.term ?? "")?.[1] ?? "?";
    const unit = /^(?:function|class|constant) (\S+) in /m.exec(request.state.code ?? "")?.[1] ?? "?";
    return { answers: { belongs: { type: "yes-no", yes: table[`${term} | ${unit}`] ?? 0.03 }, incidental: { type: "yes-no", yes: 0.02 } }, usage: { inputTokens: 1, outputTokens: 1, usd: jevCost(1) }, model: "fake-1" };
  },
};
async function store(judge: boolean): Promise<StoredVocabulary> {
  const dir = repo(files);
  const cacheDir = temp("streets-cache-");
  await setUp({ dir, cacheDir, ...(judge ? { judge: answering } : {}) });
  const read = await readVocabulary(dir, cacheDir);
  if (read.kind !== "ok") throw new Error(read.kind);
  return read.stored;
}

const stamp = { by: "Ada", at: "2026-11-11T10:00:00.000Z" };
const unit = (path: string, name: string): string => `function:${path}#${name}`;
const member = (path: string, name: string, term: string, belongs: boolean): Correction => ({ ...stamp, kind: "member", unit: unit(path, name), term, belongs, label: `${name} in ${path}` });
const withCorrections = (stored: StoredVocabulary, corrections: Correction[]): StoredVocabulary => ({ ...stored, corrections } as StoredVocabulary);

test("a corrected yes maps a function nobody judged: shown as corrected by the person, human tier, no probability", async () => {
  const doc = build(withCorrections(await store(false), [member("src/misc/odd.ts", "oddJob", "order", true)]));
  const odd = entry(doc, "src/misc/odd.ts")!;
  expect(odd.terms).toEqual([{ key: "order", name: "orders", probability: null, corrected: stamp }]);
  expect(odd.units).toMatchObject({ total: 1, withTerm: 1, notJudged: 0 });
  const orders = doc.terms.find((term) => term.key === "order")!;
  expect(orders.members).toEqual([expect.objectContaining({ name: "oddJob", probability: null, state: "member", corrected: stamp, id: unit("src/misc/odd.ts", "oddJob") })]);
  expect(orders.summary.kind).toBe("has members");
  expect(entry(doc, "src/orders/place.ts")!.units.withTerm).toBe(0);
});

test("a corrected no wins over a judged yes: the function is not a member, and the term says one was corrected away", async () => {
  const stored = await store(true);
  expect(build(stored).terms.find((term) => term.key === "order")!.members).toHaveLength(1);
  const doc = build(withCorrections(stored, [member("src/orders/place.ts", "placeOrder", "order", false)]));
  const orders = doc.terms.find((term) => term.key === "order")!;
  expect(orders.members).toEqual([]);
  expect(orders.correctedAway).toBe(1);
  expect(orders.summary).toMatchObject({ kind: "no members" });
  expect(orders.summary.why).toContain("corrected as not a member");
  expect(entry(doc, "src/orders/place.ts")).toMatchObject({ terms: [], units: { withTerm: 0, noTerm: 1 } });
});

test("a corrected yes wins over a judged no", async () => {
  const doc = build(withCorrections(await store(true), [member("src/orders/place.ts", "placeOrder", "order flow", true)]));
  expect(entry(doc, "src/orders/place.ts")!.terms.map((term) => [term.key, term.corrected?.by])).toEqual(
    expect.arrayContaining([["order flow", "Ada"]]),
  );
});

test("a correction counts although the function changed since it was judged: it is keyed on the function, not on its digest", async () => {
  const head = { ...files, "src/orders/place.ts": "export function placeOrder(): number {\n  return 2;\n}\n" };
  const stored = await store(true);
  expect(entry(build(stored, head), "src/orders/place.ts")!.units).toMatchObject({ stale: 1, withTerm: 0 });
  const doc = build(withCorrections(stored, [member("src/orders/place.ts", "placeOrder", "order", true)]), head);
  expect(entry(doc, "src/orders/place.ts")).toMatchObject({ terms: [expect.objectContaining({ key: "order", corrected: stamp })], units: { withTerm: 1, stale: 0 } });
});

test("a removed term does not appear and its records do not count", async () => {
  const doc = build(withCorrections(await store(true), [{ ...stamp, kind: "remove", term: "order", label: "orders" }]));
  expect(doc.terms.map((term) => term.key)).not.toContain("order");
  expect(entry(doc, "src/orders/place.ts")!.terms).toEqual([]);
  expect(doc.terms.map((term) => term.key)).toContain("payment");
  expect(entry(doc, "src/payments/stripe.ts")!.terms.map((term) => term.key)).toEqual(["payment"]);
});

test("a merged term takes the union of members, and shows once under the term it was merged into", async () => {
  const doc = build(withCorrections(await store(true), [{ ...stamp, kind: "merge", term: "payment", into: "order", label: "payments" }]));
  expect(doc.terms.map((term) => term.key)).not.toContain("payment");
  const orders = doc.terms.find((term) => term.key === "order")!;
  expect(orders.members.map((one) => one.name).sort()).toEqual(["chargeCard", "placeOrder"]);
  expect(orders.mergedFrom).toEqual(["payments"]);
  expect(entry(doc, "src/payments/stripe.ts")!.terms).toEqual([{ key: "order", name: "orders", probability: 0.93 }]);
  expect(orders.summary).toEqual({ kind: "has members", why: "2 members" });
});

test("a renamed term shows its new name on the file card's terms and on the term", async () => {
  const doc = build(withCorrections(await store(true), [{ ...stamp, kind: "rename", term: "payment", name: "billing", label: "payments" }]));
  const billing = doc.terms.find((term) => term.key === "payment")!;
  expect(billing).toMatchObject({ name: "billing", renamedFrom: "payments" });
  expect(entry(doc, "src/payments/stripe.ts")!.terms[0]).toMatchObject({ key: "payment", name: "billing" });
});

test("a confirmed term says by whom", async () => {
  const doc = build(withCorrections(await store(true), [{ ...stamp, kind: "confirm", term: "order", label: "orders" }]));
  expect(doc.terms.find((term) => term.key === "order")!.confirmed).toEqual(stamp);
});

test("a correction about a function the tree no longer has, or a term the vocabulary no longer has, is reported as no longer applying and counts for nothing", async () => {
  const gone: Correction[] = [member("src/gone.ts", "gone", "order", true), { ...stamp, kind: "rename", term: "vanished", name: "x", label: "vanished" }];
  const doc = build(withCorrections(await store(true), gone));
  expect(doc.corrections).toMatchObject({ count: 2 });
  expect(doc.corrections!.noLongerApply.map((one) => one.why)).toEqual(["the function is not in this tree", "the term is no longer in the vocabulary"]);
  expect(doc.terms.find((term) => term.key === "order")!.members.map((one) => one.name)).toEqual(["placeOrder"]);
});

test("a vocabulary nobody certified is drafted; a certified one says who and when; any later correction makes it drafted again", async () => {
  const stored = await store(true);
  expect(build(stored).certification).toEqual({ kind: "drafted" });
  const corrections: Correction[] = [{ ...stamp, kind: "confirm", term: "order", label: "orders" }];
  const certification = { by: "Grace", at: "2026-11-12T08:00:00.000Z", vocabulary: vocabularyDigest(stored.vocabulary.terms), corrections: correctionsDigest(corrections) };
  const certified = { ...withCorrections(stored, corrections), certification } as StoredVocabulary;
  expect(build(certified).certification).toEqual({ kind: "certified", by: "Grace", at: "2026-11-12T08:00:00.000Z" });
  const later = withCorrections(certified, [...corrections, { ...stamp, kind: "remove", term: "payment", label: "payments" }]);
  expect(build(later).certification).toMatchObject({ kind: "drafted", since: "corrections", was: { by: "Grace" } });
  const rebuilt = { ...certified, vocabulary: { ...certified.vocabulary, terms: certified.vocabulary.terms.slice(1) } } as StoredVocabulary;
  expect(build(rebuilt).certification).toEqual({ kind: "changed", by: "Grace", at: "2026-11-12T08:00:00.000Z" });
});

test("a name that is shaped like a secret is withheld on the document, whoever wrote it", async () => {
  const secret = `ghp_${"a1B2c3D4e5F6g7H8i9J0"}`;
  const stored = withCorrections(await store(true), [{ ...stamp, by: secret, kind: "rename", term: "payment", name: secret, label: "payments" }, { ...stamp, by: secret, kind: "confirm", term: "order", label: "orders" }]);
  const doc = build(stored);
  expect(JSON.stringify(doc)).not.toContain(secret);
  expect(doc.terms.find((term) => term.key === "order")!.confirmed).toEqual({ by: "withheld", at: stamp.at });
  expect(doc.terms.find((term) => term.key === "payment")!.name).toBe("withheld");
});

/* A person's no on one part of a merge: the detail, the summary, the file card and the count read it the same way. */
const noCharge = member("src/payments/stripe.ts", "chargeCard", "payment", false);
const mergePayment = (into: string): Correction => ({ ...stamp, kind: "merge", term: "payment", into, label: "payments" });

test("a no on a term, then a merge of it into another: the merged term does not list the function, and the card and the summary agree", async () => {
  const doc = build(withCorrections(await store(true), [noCharge, mergePayment("order")]));
  const orders = doc.terms.find((term) => term.key === "order")!;
  expect(orders.members.map((one) => one.name)).toEqual(["placeOrder"]);
  expect(orders.summary).toEqual({ kind: "has members", why: "1 member" });
  expect(orders.correctedAway).toBe(1);
  expect(entry(doc, "src/payments/stripe.ts")).toMatchObject({ terms: [], units: { withTerm: 0, noTerm: 1 } });
});

test("a merge, then the no: the same answer in the other order", async () => {
  const doc = build(withCorrections(await store(true), [mergePayment("order"), noCharge]));
  expect(doc.terms.find((term) => term.key === "order")!.members.map((one) => one.name)).toEqual(["placeOrder"]);
  expect(entry(doc, "src/payments/stripe.ts")!.terms).toEqual([]);
});

test("a no survives a chain of merges", async () => {
  const chain: Correction[] = [noCharge, { ...stamp, kind: "merge", term: "payment provider", into: "payment", label: "payment providers" }, mergePayment("order")];
  const doc = build(withCorrections(await store(true), chain));
  expect(doc.terms.find((term) => term.key === "order")!.members.map((one) => one.name)).toEqual(["placeOrder"]);
  expect(entry(doc, "src/payments/stripe.ts")!.terms).toEqual([]);
});

test("a merge undone by a confirm leaves the no where it was", async () => {
  const doc = build(withCorrections(await store(true), [noCharge, mergePayment("order"), { ...stamp, kind: "confirm", term: "payment", label: "payments" }]));
  expect(doc.terms.find((term) => term.key === "order")!.members.map((one) => one.name)).toEqual(["placeOrder"]);
  expect(doc.terms.find((term) => term.key === "payment")!.members).toEqual([]);
});

test("a rename of the merged-away term does not bring the function back into the merged one", async () => {
  const doc = build(withCorrections(await store(true), [noCharge, mergePayment("order"), { ...stamp, kind: "rename", term: "payment", name: "billing", label: "payments" }]));
  expect(doc.terms.find((term) => term.key === "order")!.members.map((one) => one.name)).toEqual(["placeOrder"]);
});

test("a merged term whose part is stale says so: the unknown is not dropped by the merge", async () => {
  const head = { ...files, "src/payments/stripe.ts": "// Charges a card.\nexport function chargeCard(amount: number, more: number): void {\n  void amount;\n  void more;\n}\n" };
  const doc = build(withCorrections(await store(true), [mergePayment("order")]), head);
  const orders = doc.terms.find((term) => term.key === "order")!;
  expect(orders.summary.why).toContain("1 stale");
  expect(entry(doc, "src/payments/stripe.ts")!.units).toMatchObject({ stale: 1, withTerm: 0 });
});

test("a no keyed on the function holds after the function changed and its term was merged", async () => {
  const head = { ...files, "src/payments/stripe.ts": "// Charges a card.\nexport function chargeCard(amount: number, more: number): void {\n  void amount;\n  void more;\n}\n" };
  const doc = build(withCorrections(await store(true), [noCharge, mergePayment("order")]), head);
  expect(doc.terms.find((term) => term.key === "order")!.members.map((one) => one.name)).toEqual(["placeOrder"]);
});
