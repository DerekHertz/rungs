import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { HARM_CATALOGUE, HARM_CATALOGUE_VERSION } from "../src/harm-catalogue.ts";
import { JevError, jevCost } from "../src/jev/client.ts";
import type { JevClient, JevRequest, JevResponse } from "../src/jev/client.ts";
import { reportLines, setUp } from "../src/setup.ts";
import type { SetupDeps, StoredVocabulary } from "../src/setup.ts";
import type { KindChoice } from "../src/stakes.ts";

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
function commit(dir: string, files: Record<string, string>, message = "change"): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  git(dir, "add", "--all");
  git(dir, "commit", "--quiet", "-m", message);
}
function repo(files: Record<string, string>): string {
  const dir = temp("streets-stakes-");
  git(dir, "init", "--quiet", "--initial-branch=main");
  commit(dir, files, "base");
  return dir;
}

const secret = "ghp_1234567890abcdefABCDEF1234567890abcd";
const files = {
  "package.json": '{\n  "description": "Checkout service for the shop"\n}\n',
  "docs/guide.md": "# Order flow\n\ntext\n\n## Payment providers\n\ntext\n\n## Zebra crossing\n\ntext\n",
  "src/payments/stripe.ts": `// Charges a card.\nexport function chargeCard(amount: number): void {\n  const key = "${secret}";\n  void [amount, key];\n}\n`,
  "src/orders/place.ts": "export function placeOrder(): void {}\n",
};

/** Every kind asked: the choice a run has once the gate has met its bar. */
const everyKind: KindChoice = { asked: HARM_CATALOGUE.filter((kind) => kind.answer === "judgement").map((kind) => kind.id), notJudged: [] };
const deps = (over: Partial<SetupDeps> = {}): SetupDeps => ({ kindChoice: everyKind, ...over });

const usage = { inputTokens: 100, outputTokens: 3, usd: jevCost(100) };
/**
 * Answers both gates. Membership: "orders" gets placeOrder and "payments" gets chargeCard. Stakes:
 * `harm` by "term | kind name", a confident no for anything not listed.
 */
function clientFor(harm: Record<string, number> = {}, fail: (request: JevRequest) => boolean = () => false): JevClient & { requests: JevRequest[] } {
  const requests: JevRequest[] = [];
  return {
    model: "fake-1",
    requests,
    async ask(request): Promise<JevResponse> {
      requests.push(request);
      if (fail(request)) throw new JevError("network", "Jev could not be reached");
      const term = /^Term: (.*)$/m.exec(request.state.term ?? "")?.[1] ?? "?";
      if (request.questions.belongs !== undefined) {
        const unit = /^(?:function|class|constant) (\S+) in /m.exec(request.state.code ?? "")?.[1] ?? "?";
        const belongs = (term === "orders" && unit === "placeOrder") || (term === "payments" && (unit === "chargeCard" || unit === "refundCard")) ? 0.97 : 0.03;
        return { answers: { belongs: { type: "yes-no", yes: belongs }, incidental: { type: "yes-no", yes: 0.02 } }, usage, model: "fake-1" };
      }
      const kind = /kind of harm: (.*)\?/.exec(request.questions.harm?.instructions ?? "")?.[1] ?? "?";
      return { answers: { harm: { type: "yes-no", yes: harm[`${term} | ${kind}`] ?? 0.03 } }, usage, model: "fake-1" };
    },
  };
}
type Loose = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const stored = (file: string): StoredVocabulary => JSON.parse(readFileSync(file, "utf8")) as StoredVocabulary;
const editable = (file: string): Loose => JSON.parse(readFileSync(file, "utf8")) as Loose;
const isStakeCall = (request: JevRequest): boolean => request.questions.harm !== undefined;

test("setup with judging records stakes after the memberships, for each term that has a mapped member and each kind asked", async () => {
  const client = clientFor({ "payments | cryptography and secrets": 0.97, "payments | money": 0.55 });
  const result = await setUp({ dir: repo(files), cacheDir: temp("streets-cache-"), judge: client, deps: deps() });
  const file = stored(result.file);
  expect(file.stakes?.tier).toBe("judged");
  expect(file.stakes?.gate).toEqual({ id: "stakes", version: "stakes-v1" });
  expect(file.stakes?.catalogueVersion).toBe(HARM_CATALOGUE_VERSION);
  const withMembers = file.stakes!.terms.filter((term) => term.members > 0);
  expect(withMembers.map((term) => term.key).sort()).toEqual(["order", "payment"]);
  expect(file.stakes!.records).toHaveLength(withMembers.length * everyKind.asked.length);
  expect(client.requests.filter(isStakeCall)).toHaveLength(withMembers.length * everyKind.asked.length);
  // Memberships were judged first: every stakes call comes after every membership call.
  const firstStake = client.requests.findIndex(isStakeCall);
  expect(client.requests.slice(firstStake).every(isStakeCall)).toBe(true);
  const crypto = file.stakes!.records.find((one) => one.term === "payment" && one.kind === "cryptography-and-secrets")!;
  expect(crypto).toMatchObject({ verdict: "flagged", catalogueVersion: HARM_CATALOGUE_VERSION, model: "fake-1", thresholds: { harm: 0.9, none: 0.1 } });
  expect(file.stakes!.records.find((one) => one.term === "payment" && one.kind === "money")).toMatchObject({ verdict: "undecided" });
  expect(file.stakes!.records.find((one) => one.term === "payment" && one.kind === "privacy")).toMatchObject({ verdict: "settled" });
  expect(result.judgingStakes).toMatchObject({ asked: client.requests.filter(isStakeCall).length, reused: 0 });
});

test("a term with no mapped member has no stakes: the report says unknown, never none and never a judged no", async () => {
  const result = await setUp({ dir: repo(files), cacheDir: temp("streets-cache-"), judge: clientFor(), deps: deps() });
  const zebra = result.stored.stakes!.terms.find((term) => term.key === "zebra crossing")!;
  expect(zebra).toMatchObject({ members: 0, asked: [] });
  expect(result.stored.stakes!.records.some((record) => record.term === "zebra crossing")).toBe(false);
  const text = reportLines(result).join("\n");
  expect(text).toMatch(/stakes unknown: \d+ \(a term with no mapped member has no stakes: unknown, never none\)/);
  expect(text).not.toMatch(/stakes: 0 could cause, 0 judged no/);
});

test("an unclear answer is reported as unclear, never as none; a confident yes as could cause; a confident no as judged no", async () => {
  const result = await setUp({ dir: repo(files), cacheDir: temp("streets-cache-"), judge: clientFor({ "payments | money": 0.5, "payments | privacy": 0.97 }), deps: deps() });
  const text = reportLines(result).join("\n");
  expect(text).toMatch(/pairs: 1 could cause, \d+ judged no, 1 unclear, 0 stale, 0 not judged, 0 left out by the cap/);
  expect(text).toMatch(/\n {4}money: 0 could cause, \d+ judged no, 1 unclear/);
  expect(text).toMatch(/\n {4}privacy: 1 could cause/);
});

test("a kind that missed the bench bar is not asked and is reported as not judged, per kind and not per term", async () => {
  const some: KindChoice = { asked: ["privacy", "availability"], notJudged: HARM_CATALOGUE.filter((kind) => !["privacy", "availability"].includes(kind.id)).map((kind) => ({ id: kind.id, reason: "missed the bench bar" })) };
  const client = clientFor();
  const result = await setUp({ dir: repo(files), cacheDir: temp("streets-cache-"), judge: client, deps: { kindChoice: some } });
  expect(new Set(result.stored.stakes!.records.map((record) => record.kind))).toEqual(new Set(["privacy", "availability"]));
  const text = reportLines(result).join("\n");
  expect(text).toMatch(/kinds judged: 2 of 16/);
  expect(text).toMatch(/kind not judged: money \(missed the bench bar\)/);
  expect(text).not.toMatch(/\n {4}money: \d+ could cause/);
});

test("with no kind that passed the bench, no stake is asked, and every kind is listed as not judged", async () => {
  const none: KindChoice = { asked: [], notJudged: HARM_CATALOGUE.map((kind) => ({ id: kind.id, reason: "the stakes gate has not met its bar" })) };
  const client = clientFor();
  const result = await setUp({ dir: repo(files), cacheDir: temp("streets-cache-"), judge: client, deps: { kindChoice: none } });
  expect(client.requests.filter(isStakeCall)).toHaveLength(0);
  expect(result.stored.stakes!.records).toEqual([]);
  expect(reportLines(result).join("\n")).toMatch(/kinds judged: 0 of 16/);
});

test("a call that fails leaves the pair not judged with why, never a no", async () => {
  const result = await setUp({ dir: repo(files), cacheDir: temp("streets-cache-"), judge: clientFor({}, isStakeCall), deps: deps() });
  expect(result.stored.stakes!.records).toEqual([]);
  expect(result.judgingStakes?.notJudged).toBeGreaterThan(0);
  const text = reportLines(result).join("\n");
  expect(text).toMatch(/pairs: 0 could cause, 0 judged no, 0 unclear, 0 stale, \d+ not judged/);
  expect(text).toMatch(/Jev could not be reached/);
});

test("a member that changes marks the term's stakes stale without asking Jev, and they are asked again with --judge; the other term's are reused", async () => {
  const dir = repo(files);
  const cacheDir = temp("streets-cache-");
  const first = await setUp({ dir, cacheDir, judge: clientFor(), deps: deps() });
  const total = first.stored.stakes!.records.length;
  commit(dir, { "src/orders/place.ts": "export function placeOrder(): void { return; }\n" });
  const noModel = await setUp({ dir, cacheDir, deps: deps() });
  const stale = noModel.stored.stakes!.records.filter((record) => record.stale !== undefined);
  expect(stale.length).toBe(everyKind.asked.length);
  expect(new Set(stale.map((record) => record.term))).toEqual(new Set(["order"]));
  expect(reportLines(noModel).join("\n")).toMatch(new RegExp(`${everyKind.asked.length} stale`));
  const again = clientFor();
  const third = await setUp({ dir, cacheDir, judge: again, deps: deps() });
  expect(third.judgingStakes).toMatchObject({ asked: everyKind.asked.length, reused: total - everyKind.asked.length });
  expect(third.stored.stakes!.records.some((record) => record.stale !== undefined)).toBe(false);
});

test("a member that is no longer mapped changes the term's membership: the stakes go stale, and with no member left the term's stakes are unknown", async () => {
  const dir = repo(files);
  const cacheDir = temp("streets-cache-");
  await setUp({ dir, cacheDir, judge: clientFor(), deps: deps() });
  commit(dir, { "src/orders/place.ts": "export function placeOrder(): void { return; }\n", "src/payments/stripe.ts": "export function chargeCard(amount: number): void {\n  void amount;\n}\n" });
  const result = await setUp({ dir, cacheDir, deps: deps() });
  const stakes = result.stored.stakes!;
  // Both mappings are stale (their functions changed), so neither term has a current member: unknown, with the old answers kept as stale.
  expect(stakes.terms.every((term) => term.members === 0)).toBe(true);
  expect(stakes.records.every((record) => record.stale !== undefined)).toBe(true);
  expect(reportLines(result).join("\n")).toMatch(/pairs: 0 could cause, 0 judged no, 0 unclear, \d+ stale/);
});

test("a catalogue version bump marks every stake stale, even when nothing else changed and no model is asked", async () => {
  const dir = repo(files);
  const cacheDir = temp("streets-cache-");
  const first = await setUp({ dir, cacheDir, judge: clientFor(), deps: deps() });
  const edited = editable(first.file);
  edited.stakes = { ...edited.stakes, catalogueVersion: HARM_CATALOGUE_VERSION - 1, records: edited.stakes.records.map((record: Loose) => ({ ...record, catalogueVersion: HARM_CATALOGUE_VERSION - 1 })) };
  writeFileSync(first.file, JSON.stringify(edited));
  const result = await setUp({ dir, cacheDir, deps: deps() });
  expect(result.stored.stakes!.catalogueVersion).toBe(HARM_CATALOGUE_VERSION - 1);
  expect(stored(result.file).stakes!.records.every((record) => record.stale === "the catalogue changed")).toBe(true);
  expect(result.stored.stakes!.records.every((record) => record.stale === "the catalogue changed")).toBe(true);
  const again = clientFor();
  const rejudged = await setUp({ dir, cacheDir, judge: again, deps: deps() });
  expect(again.requests.filter(isStakeCall)).toHaveLength(first.stored.stakes!.records.length);
  expect(rejudged.stored.stakes!.catalogueVersion).toBe(HARM_CATALOGUE_VERSION);
  expect(rejudged.stored.stakes!.records.some((record) => record.stale !== undefined)).toBe(false);
});

test("a judged run over a repository nothing changed in reuses every stake and asks nothing", async () => {
  const dir = repo(files);
  const cacheDir = temp("streets-cache-");
  const first = await setUp({ dir, cacheDir, judge: clientFor(), deps: deps() });
  const again = clientFor();
  const second = await setUp({ dir, cacheDir, judge: again, deps: deps() });
  expect(again.requests).toHaveLength(0);
  expect(second.judgingStakes).toMatchObject({ asked: 0, reused: first.stored.stakes!.records.length });
  expect(second.work).toBe("unchanged");
});

test("pairs over the cap are not asked, are counted and are listed on the term as left out", async () => {
  const result = await setUp({ dir: repo(files), cacheDir: temp("streets-cache-"), judge: clientFor(), deps: deps({ maxStakePairs: 5 }) });
  expect(result.stored.stakes!.records).toHaveLength(5);
  expect(result.judgingStakes?.overLimit).toBeGreaterThan(0);
  const cut = result.stored.stakes!.terms.flatMap((term) => term.cut);
  expect(cut.length).toBe(result.judgingStakes!.overLimit);
  const text = reportLines(result).join("\n");
  expect(text).toMatch(new RegExp(`${cut.length} left out by the cap of 5 per run`));
  expect(text).toMatch(new RegExp(`${cut.length} not asked: over the limit of 5 pairs`));
});

test("a term whose mapping is not fully known is reported as judged over some of its members", async () => {
  const noPaymentsAnswer = clientFor({}, (request) => request.questions.belongs !== undefined && /^Term: payments$/m.test(request.state.term ?? "") && /chargeCard/.test(request.state.code ?? ""));
  const result = await setUp({ dir: repo({ ...files, "src/payments/refund.ts": "export function refundCard(): void {}\n" }), cacheDir: temp("streets-cache-"), judge: noPaymentsAnswer, deps: deps() });
  const payments = result.stored.stakes!.terms.find((term) => term.key === "payment")!;
  expect(payments.unknown).toBeGreaterThan(0);
  expect(reportLines(result).join("\n")).toMatch(/judged over some of their members: \d+ \(a pair of the term is stale, not judged or left out by the cap, so a no covers the members known\)/);
});

test("nothing secret is sent to Jev or kept in the stored file: the stakes question carries the code with secrets withheld", async () => {
  const client = clientFor();
  const result = await setUp({ dir: repo(files), cacheDir: temp("streets-cache-"), judge: client, deps: deps() });
  const sent = JSON.stringify(client.requests.filter(isStakeCall));
  expect(sent).toContain("chargeCard");
  expect(sent).not.toContain("1234567890abcdef");
  expect(readFileSync(result.file, "utf8")).not.toContain("1234567890abcdef");
});

test("without judging and without stored stakes, setup records no stakes and says so", async () => {
  const result = await setUp({ dir: repo(files), cacheDir: temp("streets-cache-"), deps: deps() });
  expect(result.stored.stakes).toBeUndefined();
  expect(reportLines(result).join("\n")).toMatch(/stakes: not recorded/);
});

test("a stored stakes record whose verdict does not follow from its answers is damage: the stored file is replaced", async () => {
  const dir = repo(files);
  const cacheDir = temp("streets-cache-");
  const first = await setUp({ dir, cacheDir, judge: clientFor(), deps: deps() });
  const edited = editable(first.file);
  edited.stakes = { ...edited.stakes, records: edited.stakes.records.map((record: Loose, at: number) => (at === 0 ? { ...record, verdict: record.verdict === "settled" ? "flagged" : "settled" } : record)) };
  writeFileSync(first.file, JSON.stringify(edited));
  const result = await setUp({ dir, cacheDir, deps: deps() });
  expect(result.work).toBe("replaced unreadable");
  expect(result.why).toMatch(/stakes/);
});
