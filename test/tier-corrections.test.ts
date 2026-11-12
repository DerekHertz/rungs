import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { compare } from "../src/compare.ts";
import type { Correction } from "../src/corrections.ts";
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

/*
 * A person's corrections win over judged answers everywhere a function's terms are read, and the
 * tier is one of those places: a corrected membership changes which term's stakes a changed
 * function carries, a removed term is not a member, a merged term's stakes are the worst of its
 * parts, and a function a person added to a term is not covered by stakes judged before.
 */

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
  const dir = temp("streets-tier-corr-");
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
  "src/misc/util.ts": "export function helper(): void {}\n",
};

const every: KindChoice = { asked: HARM_CATALOGUE.filter((kind) => kind.answer === "judgement").map((kind) => kind.id), notJudged: [] };
const usage = { inputTokens: 100, outputTokens: 3, usd: jevCost(100) };

/** orders gets placeOrder and payments gets chargeCard; payments could cause harm in money, everything else is a confident no. */
function clientFor(): JevClient {
  return {
    model: "fake-1",
    async ask(request: JevRequest): Promise<JevResponse> {
      const term = /^Term: (.*)$/m.exec(request.state.term ?? "")?.[1] ?? "?";
      if (request.questions.belongs !== undefined) {
        const unit = /^(?:function|class|constant) (\S+) in /m.exec(request.state.code ?? "")?.[1] ?? "?";
        const belongs = (term === "orders" && unit === "placeOrder") || (term === "payments" && unit === "chargeCard") ? 0.97 : 0.03;
        return { answers: { belongs: { type: "yes-no", yes: belongs }, incidental: { type: "yes-no", yes: 0.02 } }, usage, model: "fake-1" };
      }
      const kind = /kind of harm: (.*)\?/.exec(request.questions.harm?.instructions ?? "")?.[1] ?? "?";
      return { answers: { harm: { type: "yes-no", yes: term === "payments" && kind === "money" ? 0.97 : 0.03 } }, usage, model: "fake-1" };
    },
  };
}

const baseTree: FileTree = new Map(Object.entries(files));
const stamp = { by: "Dana", at: "2026-11-12T10:00:00.000Z" };

interface Setup {
  readonly stored: StoredVocabulary;
  readonly termKey: (name: string) => string;
  readonly unitKey: (name: string) => string;
}
let made: Setup | undefined;
async function setup(): Promise<Setup> {
  if (made !== undefined) return made;
  const result = await setUp({ dir: repo(files), cacheDir: temp("streets-cache-"), judge: clientFor(), deps: { kindChoice: every } });
  const stored = result.stored as StoredVocabulary;
  const termKey = (name: string): string => stored.vocabulary.terms.find((term) => term.name === name)?.key ?? `no term ${name}`;
  const unitKey = (name: string): string => stored.memberships?.units.find((unit) => unit.name === name)?.key ?? `no unit ${name}`;
  return (made = { stored, termKey, unitKey });
}

async function tieringWith(corrections: (s: Setup) => Correction[]): Promise<Tiering> {
  const s = await setup();
  return { table: DEFAULT_TIERS, vocabulary: { status: "ok", stored: { ...s.stored, corrections: corrections(s) }, choice: every } };
}

function pick(tiering: Tiering, edits: Record<string, string>, path: string) {
  const head: FileTree = new Map([...baseTree, ...Object.entries(edits)]);
  const baseGraph = extract(baseTree);
  const graph = extract(head);
  const comparison = compare(baseGraph, graph, { base: baseTree, head });
  return tierPicker({ tiering, comparison, baseGraph, graph, baseTree, tree: head })({ ids: [`file:${path}` as NodeId] });
}

const editOrder = { "src/orders/place.ts": "export function placeOrder(): void {\n  void 1;\n}\n" };
const editPayment = { "src/payments/stripe.ts": "// Charges a card.\nexport function chargeCard(amount: number): void {\n  void amount;\n  void 2;\n}\n" };
const editHelper = { "src/misc/util.ts": "export function helper(): void {\n  void 1;\n}\n" };
const stakesWhy = (why: readonly string[]): string => why.find((reason) => reason.startsWith("stakes:")) ?? "";

test("with no corrections the judged stakes decide: orders is judged none, payments could cause harm", async () => {
  const none = await tieringWith(() => []);
  expect(pick(none, editOrder, "src/orders/place.ts")).toMatchObject({ percent: 95 });
  expect(stakesWhy(pick(none, editPayment, "src/payments/stripe.ts").why)).toMatch(/could cause harm in money in payments/);
});

test("a person's no takes a function out of a term: the term's judged none no longer covers it, so its stakes are unknown", async () => {
  const tiering = await tieringWith((s) => [{ ...stamp, kind: "member", unit: s.unitKey("placeOrder"), term: s.termKey("orders"), belongs: false, label: "placeOrder, term orders" }]);
  const found = pick(tiering, editOrder, "src/orders/place.ts");
  expect(found.percent).toBe(99.9);
  expect(stakesWhy(found.why)).toMatch(/placeOrder is mapped to no term/);
  expect(stakesWhy(found.why)).not.toMatch(/judged none/);
});

test("a person's no takes the harm of a term away from a function judged to be in it, and the function is unknown, not harmless", async () => {
  const tiering = await tieringWith((s) => [{ ...stamp, kind: "member", unit: s.unitKey("chargeCard"), term: s.termKey("payments"), belongs: false, label: "chargeCard, term payments" }]);
  const found = pick(tiering, editPayment, "src/payments/stripe.ts");
  expect(found.percent).toBe(99.9);
  expect(stakesWhy(found.why)).not.toMatch(/could cause harm/);
  expect(stakesWhy(found.why)).toMatch(/chargeCard is mapped to no term/);
});

test("a person's yes puts a function in a term judged to be none of its members: it carries that term's harm", async () => {
  const tiering = await tieringWith((s) => [{ ...stamp, kind: "member", unit: s.unitKey("helper"), term: s.termKey("payments"), belongs: true, label: "helper, term payments" }]);
  const found = pick(tiering, editHelper, "src/misc/util.ts");
  expect(found.percent).toBe(99.9);
  expect(stakesWhy(found.why)).toMatch(/could cause harm in money in payments/);
});

test("a person's yes into a term judged none is not covered by stakes judged before it was there: possible harm, never none", async () => {
  const tiering = await tieringWith((s) => [{ ...stamp, kind: "member", unit: s.unitKey("helper"), term: s.termKey("orders"), belongs: true, label: "helper, term orders" }]);
  const found = pick(tiering, editHelper, "src/misc/util.ts");
  expect(found.percent).toBe(99.9);
  expect(stakesWhy(found.why)).toMatch(/orders: helper was added to it by a person after its stakes were judged/);
  expect(stakesWhy(found.why)).not.toMatch(/judged none/);
});

test("the latest word wins: a no, then a yes, puts the function back", async () => {
  const tiering = await tieringWith((s) => {
    const pair = { unit: s.unitKey("placeOrder"), term: s.termKey("orders"), label: "placeOrder, term orders" };
    return [
      { ...stamp, kind: "member", ...pair, belongs: false },
      { ...stamp, at: "2026-11-12T11:00:00.000Z", kind: "member", ...pair, belongs: true },
    ];
  });
  const found = pick(tiering, editOrder, "src/orders/place.ts");
  // It is a member of orders again (a judged member too), so the judged none covers it.
  expect(found.percent).toBe(95);
});

test("a removed term is not a member: its functions are in no term, and its stakes do not apply", async () => {
  const tiering = await tieringWith((s) => [{ ...stamp, kind: "remove", term: s.termKey("payments"), label: "payments" }]);
  const found = pick(tiering, editPayment, "src/payments/stripe.ts");
  expect(found.percent).toBe(99.9);
  expect(stakesWhy(found.why)).toMatch(/chargeCard is mapped to no term/);
  expect(stakesWhy(found.why)).not.toMatch(/could cause harm/);
  // The other term is untouched.
  expect(pick(tiering, editOrder, "src/orders/place.ts").percent).toBe(95);
});

test("a merged term is the union of its parts and carries the worst of their stakes", async () => {
  const tiering = await tieringWith((s) => [{ ...stamp, kind: "merge", term: s.termKey("payments"), into: s.termKey("orders"), label: "payments into orders" }]);
  // placeOrder was judged none in orders, but orders now also holds payments, which could cause harm in money.
  const order = pick(tiering, editOrder, "src/orders/place.ts");
  expect(order.percent).toBe(99.9);
  expect(stakesWhy(order.why)).toMatch(/could cause harm in money in orders/);
  // chargeCard is in orders by the merge, under orders' name.
  expect(stakesWhy(pick(tiering, editPayment, "src/payments/stripe.ts").why)).toMatch(/could cause harm in money in orders/);
});

test("a renamed term is named as the person named it", async () => {
  const tiering = await tieringWith((s) => [{ ...stamp, kind: "rename", term: s.termKey("payments"), name: "billing", label: "payments" }]);
  expect(stakesWhy(pick(tiering, editPayment, "src/payments/stripe.ts").why)).toMatch(/could cause harm in money in billing/);
});

test("a confirmation changes no tier", async () => {
  const tiering = await tieringWith((s) => [{ ...stamp, kind: "confirm", term: s.termKey("orders"), label: "orders" }]);
  expect(pick(tiering, editOrder, "src/orders/place.ts").percent).toBe(95);
});

test("a correction that names a term or a function that is gone changes nothing and does not throw", async () => {
  const tiering = await tieringWith((s) => [
    { ...stamp, kind: "remove", term: "term:long-gone", label: "long gone" },
    { ...stamp, kind: "merge", term: s.termKey("orders"), into: "term:long-gone", label: "orders into long gone" },
    { ...stamp, kind: "member", unit: "function:src/nowhere.ts#nothing", term: s.termKey("orders"), belongs: true, label: "nothing, term orders" },
  ]);
  expect(pick(tiering, editOrder, "src/orders/place.ts").percent).toBe(95);
  expect(stakesWhy(pick(tiering, editPayment, "src/payments/stripe.ts").why)).toMatch(/could cause harm in money in payments/);
});
