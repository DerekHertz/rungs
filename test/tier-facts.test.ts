import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { compare } from "../src/compare.ts";
import { extract } from "../src/extract/extract.ts";
import type { FileTree, NodeId } from "../src/graph.ts";
import { HARM_CATALOGUE } from "../src/harm-catalogue.ts";
import { jevCost } from "../src/jev/client.ts";
import type { JevClient, JevRequest, JevResponse } from "../src/jev/client.ts";
import { setUp } from "../src/setup.ts";
import type { StoredVocabulary } from "../src/setup.ts";
import type { KindChoice } from "../src/stakes.ts";
import { tierPicker } from "../src/tier-facts.ts";
import type { Tiering } from "../src/tier-facts.ts";
import { DEFAULT_TIERS } from "../src/tier-table.ts";

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
  const dir = temp("streets-tier-");
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
  "docs/guide.md": "# Order flow\n\ntext\n\n## Payment providers\n\ntext\n\n## Zebra crossing\n\ntext\n",
  "src/payments/stripe.ts": "// Charges a card.\nexport function chargeCard(amount: number): void {\n  void amount;\n}\n",
  "src/orders/place.ts": "export function placeOrder(): void {}\n",
  "src/orders/report.ts": "import { placeOrder } from './place.ts';\nexport function report(): void {\n  placeOrder();\n}\n",
};

const every: KindChoice = { asked: HARM_CATALOGUE.filter((kind) => kind.answer === "judgement").map((kind) => kind.id), notJudged: [] };
const usage = { inputTokens: 100, outputTokens: 3, usd: jevCost(100) };

/** Answers both setup gates: orders gets placeOrder and payments gets chargeCard; a confident no for every kind of harm but those in `harm`, by "term | kind name". */
function clientFor(harm: Record<string, number> = {}): JevClient {
  return {
    model: "fake-1",
    async ask(request: JevRequest): Promise<JevResponse> {
      const term = /^Term: (.*)$/m.exec(request.state.term ?? "")?.[1] ?? "?";
      if (request.questions.belongs !== undefined) {
        const unit = /^(?:function|class|constant) (\S+) in /m.exec(request.state.code ?? "")?.[1] ?? "?";
        const belongs = (term === "orders" && (unit === "placeOrder" || unit === "report")) || (term === "payments" && unit === "chargeCard") ? 0.97 : 0.03;
        return { answers: { belongs: { type: "yes-no", yes: belongs }, incidental: { type: "yes-no", yes: 0.02 } }, usage, model: "fake-1" };
      }
      const kind = /kind of harm: (.*)\?/.exec(request.questions.harm?.instructions ?? "")?.[1] ?? "?";
      return { answers: { harm: { type: "yes-no", yes: harm[`${term} | ${kind}`] ?? 0.03 } }, usage, model: "fake-1" };
    },
  };
}

const baseTree: FileTree = new Map(Object.entries(files));

/** A tiering over the stored vocabulary of `files`, set up with a fake classifier. */
async function tieringFor(harm: Record<string, number>, table = DEFAULT_TIERS, extra: Record<string, string> = {}): Promise<Tiering> {
  const result = await setUp({ dir: repo({ ...files, ...extra }), cacheDir: temp("streets-cache-"), judge: clientFor(harm), deps: { kindChoice: every } });
  return { table, vocabulary: { status: "ok", stored: result.stored as StoredVocabulary, choice: every } };
}
const noVocabulary: Tiering = { table: DEFAULT_TIERS, vocabulary: { status: "missing", why: "no vocabulary was stored" } };

function pickerOf(tiering: Tiering, edits: Record<string, string>, base: FileTree = baseTree) {
  const head: FileTree = new Map([...base, ...Object.entries(edits)]);
  const baseGraph = extract(base);
  const graph = extract(head);
  const comparison = compare(baseGraph, graph, { base, head });
  return tierPicker({ tiering, comparison, baseGraph, graph, baseTree: base, tree: head });
}
const file = (path: string): NodeId => `file:${path}` as NodeId;

const smallOrder = { "src/orders/place.ts": "export function placeOrder(): void {\n  void 1;\n}\n" };
const smallPayment = { "src/payments/stripe.ts": "// Charges a card.\nexport function chargeCard(amount: number): void {\n  void amount;\n  void 2;\n}\n" };

test("two fixtures of different stakes get different tiers: judged none is the loosest, could cause harm the strictest", async () => {
  const tiering = await tieringFor({ "payments | money": 0.97 });
  const orders = pickerOf(tiering, { ...smallOrder, ...smallPayment })({ ids: [file("src/orders/place.ts")] });
  const payments = pickerOf(tiering, { ...smallOrder, ...smallPayment })({ ids: [file("src/payments/stripe.ts")] });
  // Both changes are as small as a change gets, so the stakes alone set the tiers.
  expect(orders).toMatchObject({ percent: 95, rank: 2 });
  expect(orders.why.join("; ")).toMatch(/stakes: judged none in order/);
  expect(payments).toMatchObject({ percent: 99.9, rank: 0 });
  expect(payments.why.join("; ")).toMatch(/stakes: could cause harm in money in payment/);
});

test("an unclear answer, an answer over some of the code and a function mapped to no term are possible harm, never none", async () => {
  const unclear = pickerOf(await tieringFor({ "orders | money": 0.5 }), smallOrder)({ ids: [file("src/orders/place.ts")] });
  expect(unclear.percent).toBe(99.9);
  expect(unclear.why.join("; ")).toMatch(/stakes: possible harm.*money.*unclear/);
  // placeOrder is judged none, but the item also changes a function no term holds: a possible harm.
  const tiering = await tieringFor({});
  const extra = { "src/orders/place.ts": "export function placeOrder(): void {}\nexport function helper(): void {\n  void 1;\n}\n" };
  const mixed = pickerOf(tiering, extra)({ ids: [file("src/orders/place.ts")] });
  expect(mixed.percent).toBe(99.9);
  expect(mixed.why.join("; ")).toMatch(/stakes: possible harm.*helper/);
});

test("callbacks inside one function that no term holds are one reason, named by the function, not one line per callback", async () => {
  const tiering = await tieringFor({});
  const extra = { "src/orders/place.ts": "export function placeOrder(): void {}\nexport function helper(items: number[]): number[] {\n  return items.map((a) => a + 1).filter((b) => b > 1).map((c) => c * 2);\n}\n" };
  const pick = pickerOf(tiering, extra)({ ids: [file("src/orders/place.ts")] });
  expect(pick.percent).toBe(99.9);
  const stakes = pick.why.find((reason) => reason.startsWith("stakes:")) ?? "";
  expect(stakes).toMatch(/helper is in no unit that setup mapped to a term/);
  expect(stakes.match(/no unit that setup mapped/g)).toHaveLength(1);
  expect(stakes).not.toMatch(/ and \d+ more/);
});

test("no stored vocabulary: the stakes are unknown and the strictest tier applies, never the loosest, and it says why", () => {
  const pick = pickerOf(noVocabulary, smallOrder)({ ids: [file("src/orders/place.ts")] });
  expect(pick.percent).toBe(99.9);
  expect(pick.why.join("; ")).toMatch(/stakes: possible harm, no vocabulary was stored/);
  const unreadable: Tiering = { table: DEFAULT_TIERS, vocabulary: { status: "unreadable", why: "it is not JSON" } };
  expect(pickerOf(unreadable, smallOrder)({ ids: [file("src/orders/place.ts")] }).percent).toBe(99.9);
});

test("vocabulary stored but no mapped code or no stakes: unknown, strictest", async () => {
  const tiering = await tieringFor({});
  if (tiering.vocabulary.status !== "ok") throw new Error("expected a stored vocabulary");
  const { stakes, ...noStakes } = tiering.vocabulary.stored;
  void stakes;
  const without: Tiering = { ...tiering, vocabulary: { ...tiering.vocabulary, stored: noStakes as StoredVocabulary } };
  const pick = pickerOf(without, smallOrder)({ ids: [file("src/orders/place.ts")] });
  expect(pick.percent).toBe(99.9);
  expect(pick.why.join("; ")).toMatch(/stakes are not recorded/);
  const { memberships, ...noMembers } = noStakes;
  void memberships;
  const bare: Tiering = { ...tiering, vocabulary: { ...tiering.vocabulary, stored: noMembers as StoredVocabulary } };
  expect(pickerOf(bare, smallOrder)({ ids: [file("src/orders/place.ts")] }).why.join("; ")).toMatch(/no code is mapped to a term/);
});

test("a changed function the mapping has not seen (changed since setup) is not a current member: possible harm", async () => {
  const tiering = await tieringFor({});
  const moved: FileTree = new Map([...baseTree, ["src/orders/place.ts", "export function placeOrder(): void {\n  void 0;\n}\n"]]);
  // The comparison's base is not the base setup judged: placeOrder's digest differs, so its mapping is stale.
  const pick = pickerOf(tiering, { "src/orders/place.ts": "export function placeOrder(): void {\n  void 9;\n}\n" }, moved)({ ids: [file("src/orders/place.ts")] });
  expect(pick.percent).toBe(99.9);
  expect(pick.why.join("; ")).toMatch(/stakes: possible harm/);
});

test("complexity: an effect reached picks the strictest tier even when the stakes are none", async () => {
  const tiering = await tieringFor({});
  const pick = pickerOf(tiering, { "src/orders/place.ts": "export function placeOrder(): void {\n  void fetch('https://example.com/orders');\n}\n" })({ ids: [file("src/orders/place.ts")] });
  expect(pick.percent).toBe(99.9);
  expect(pick.why.join("; ")).toMatch(/effects reached/);
  expect(pick.why.join("; ")).not.toMatch(/stakes/);
});

test("complexity: the files that rest on the changed file, and the lines changed, pick the middle tier; the fixed cutoffs are in the table", async () => {
  const importers = Object.fromEntries(Array.from({ length: 2 }, (_, index) => [`src/orders/user${index}.ts`, "import { placeOrder } from './place.ts';\nexport const u = placeOrder;\n"]));
  const withImporters = new Map([...baseTree, ...Object.entries(importers)]);
  // report.ts imports place.ts: one file rests on it, so the blast radius is small.
  const small = await tieringFor({});
  expect(pickerOf(small, smallOrder)({ ids: [file("src/orders/place.ts")] })).toMatchObject({ percent: 95, rank: 2 });
  // Two more importers make three files that rest on it: the middle tier, whatever the stakes.
  const wide = await tieringFor({}, DEFAULT_TIERS, importers);
  const picked = pickerOf(wide, smallOrder, withImporters)({ ids: [file("src/orders/place.ts")] });
  expect(picked).toMatchObject({ percent: 99, rank: 1 });
  expect(picked.why.join("; ")).toMatch(/blast radius: 3 files rest on it/);
  const lines = Array.from({ length: 45 }, (_, index) => `  void ${index};`).join("\n");
  const long = pickerOf(small, { "src/orders/place.ts": `export function placeOrder(): void {\n${lines}\n}\n` })({ ids: [file("src/orders/place.ts")] });
  expect(long).toMatchObject({ percent: 99, rank: 1 });
  expect(long.why.join("; ")).toMatch(/lines changed/);
  // Ten files, or two hundred lines, is the strictest tier on its own.
  const many = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`src/orders/more${index}.ts`, "import { placeOrder } from './place.ts';\nexport const m = placeOrder;\n"]));
  const crowded = await tieringFor({}, DEFAULT_TIERS, many);
  const strict = pickerOf(crowded, smallOrder, new Map([...baseTree, ...Object.entries(many)]))({ ids: [file("src/orders/place.ts")] });
  expect(strict).toMatchObject({ percent: 99.9, rank: 0 });
  expect(strict.why.join("; ")).toMatch(/large blast radius: 10 files rest on it/);
  const huge = Array.from({ length: 205 }, (_, index) => `  void ${index};`).join("\n");
  expect(pickerOf(small, { "src/orders/place.ts": `export function placeOrder(): void {\n${huge}\n}\n` })({ ids: [file("src/orders/place.ts")] }).why.join("; ")).toMatch(/large change: 208 lines changed/);
});

test("the strictest of complexity and stakes decides; a reviewer's table changes the percents and nothing else", async () => {
  const tiering = await tieringFor({ "payments | money": 0.97 }, [99.99, 99.5, 90]);
  const edits = { ...smallOrder, ...smallPayment };
  expect(pickerOf(tiering, edits)({ ids: [file("src/orders/place.ts")] }).percent).toBe(90);
  expect(pickerOf(tiering, edits)({ ids: [file("src/payments/stripe.ts")] }).percent).toBe(99.99);
});

test("an item with no known change is unknown, and unknown is never small: the strictest tier", async () => {
  const tiering = await tieringFor({});
  const pick = pickerOf(tiering, smallOrder)({ ids: [file("src/orders/nowhere.ts")] });
  expect(pick.percent).toBe(99.9);
});

test("a hunk is tied to the functions its lines are in", async () => {
  const tiering = await tieringFor({ "payments | money": 0.97 });
  const edits = { ...smallOrder, ...smallPayment };
  const picker = pickerOf(tiering, edits);
  // The order file's hunk is in placeOrder; judged none.
  expect(picker({ ids: [file("src/orders/place.ts")], hunk: { head: { start: 1, end: 3 }, base: { start: 1, end: 1 } } }).percent).toBe(95);
  // A hunk in no function (module top level) belongs to no term: unknown.
  const top = pickerOf(tiering, { "src/orders/place.ts": "import 'node:path';\nexport function placeOrder(): void {}\n" });
  expect(top({ ids: [file("src/orders/place.ts")], hunk: { head: { start: 1, end: 1 }, base: null } }).percent).toBe(99.9);
});

test("a claim linked to a judged-none function and to a changed file with no code in it (unparseable, markdown, binary) has unknown stakes: the strictest tier", async () => {
  const tiering = await tieringFor({});
  const edits = { ...smallOrder, "src/orders/policy.ts": "export function broken( {\n" };
  const pick = pickerOf(tiering, edits)({ ids: [file("src/orders/place.ts"), file("src/orders/policy.ts")] });
  expect(pick.percent).toBe(99.9);
  expect(pick.why.join("; ")).toMatch(/stakes: possible harm.*policy\.ts/);
  expect(pick.why.join("; ")).not.toMatch(/judged none/);
  // A docs file linked beside the function is no code to judge either.
  const docs = pickerOf(tiering, { ...smallOrder, "docs/guide.md": "# Order flow\n\nchanged\n" })({ ids: [file("src/orders/place.ts"), file("docs/guide.md")] });
  expect(docs.percent).toBe(99.9);
  // Alone, the same function stays judged none.
  expect(pickerOf(tiering, edits)({ ids: [file("src/orders/place.ts")] }).percent).toBe(95);
});

test("a changed file that could not be read in full, or a named place that is no known change, is unknown: complexity is the strictest tier too", async () => {
  const tiering = await tieringFor({});
  const broken = pickerOf(tiering, { "src/orders/policy.ts": "export function broken( {\n" })({ ids: [file("src/orders/policy.ts")] });
  expect(broken.why.join("; ")).toMatch(/1 changed file could not be read in full/);
  const stranger = pickerOf(tiering, smallOrder)({ ids: [file("src/orders/place.ts"), file("src/orders/nowhere.ts")] });
  expect(stranger.percent).toBe(99.9);
  expect(stranger.why.join("; ")).toMatch(/a named place is no change this comparison knows/);
  expect(stranger.why.join("; ")).not.toMatch(/judged none/);
});

test("a kind adopted after setup was never asked of any term: possible harm, never judged none", async () => {
  const withoutMoney: KindChoice = { asked: every.asked.filter((id) => id !== "money"), notJudged: [{ id: "money", reason: "missed the bench bar" }] };
  const result = await setUp({ dir: repo(files), cacheDir: temp("streets-cache-"), judge: clientFor({}), deps: { kindChoice: withoutMoney } });
  const stored = result.stored as StoredVocabulary;
  const before: Tiering = { table: DEFAULT_TIERS, vocabulary: { status: "ok", stored, choice: withoutMoney } };
  expect(pickerOf(before, smallOrder)({ ids: [file("src/orders/place.ts")] }).why.join("; ")).toMatch(/money not judged/);
  // Money is adopted, and setup is not run again: the stored stakes say nothing about it.
  const after: Tiering = { table: DEFAULT_TIERS, vocabulary: { status: "ok", stored, choice: every } };
  const pick = pickerOf(after, smallOrder)({ ids: [file("src/orders/place.ts")] });
  expect(pick.percent).toBe(99.9);
  expect(pick.why.join("; ")).toMatch(/stakes: possible harm.*money not judged/);
  expect(pick.why.join("; ")).not.toMatch(/judged none/);
});

test("one added call out is one kind of call out, not two", async () => {
  const tiering = await tieringFor({});
  const pick = pickerOf(tiering, { "src/orders/place.ts": "export function placeOrder(): void {\n  void fetch('https://example.com/orders');\n}\n" })({ ids: [file("src/orders/place.ts")] });
  expect(pick.why.join("; ")).toMatch(/effects reached: 1 kind of call out/);
  // A call out in a changed file whose function did not change counts once too.
  const aside = pickerOf(tiering, { "src/orders/place.ts": "export function placeOrder(): void {}\nconst later = fetch('https://example.com/a');\nvoid later;\n" })({ ids: [file("src/orders/place.ts")] });
  expect(aside.why.join("; ")).toMatch(/effects reached: 1 kind of call out/);
});
