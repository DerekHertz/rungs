import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, expect, test, vi } from "vitest";
import { extract } from "../src/extract/extract.ts";
import { JevError, jevCost } from "../src/jev/client.ts";
import type { JevClient, JevRequest, JevResponse } from "../src/jev/client.ts";
import { reportLines, setUp } from "../src/setup.ts";
import type { StoredVocabulary } from "../src/setup.ts";

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
  const dir = temp("streets-members-");
  git(dir, "init", "--quiet", "--initial-branch=main");
  commit(dir, files, "base");
  return dir;
}

const files = {
  "package.json": '{\n  "description": "Checkout service for the shop"\n}\n',
  "docs/guide.md": "# Order flow\n\ntext\n\n## Payment providers\n\ntext\n\n## Zebra crossing\n\ntext\n",
  "src/payments/stripe.ts": "// Charges a card.\nexport function chargeCard(amount: number): void {\n  void amount;\n}\n",
  "src/orders/place.ts": "export function placeOrder(): void {}\n",
};

/** [belongs, incidental] by "term name | function name"; anything not listed is a confident no. */
type Table = Record<string, [number, number?]>;
const table: Table = {
  "orders | placeOrder": [0.97],
  "Order flow | placeOrder": [0.6],

  "payments | chargeCard": [0.97],
};

function clientFor(rows: Table = table, model = "fake-1"): JevClient & { requests: JevRequest[] } {
  const requests: JevRequest[] = [];
  return {
    model,
    requests,
    async ask(request): Promise<JevResponse> {
      requests.push(request);
      const term = /^Term: (.*)$/m.exec(request.state.term ?? "")?.[1] ?? "?";
      const unit = /^(?:function|class|constant) (\S+) in /m.exec(request.state.code ?? "")?.[1] ?? "?";
      const [belongs, incidental = 0.02] = rows[`${term} | ${unit}`] ?? [0.03];
      return { answers: { belongs: { type: "yes-no", yes: belongs }, incidental: { type: "yes-no", yes: incidental } }, usage: { inputTokens: 100, outputTokens: 3, usd: jevCost(100) }, model };
    },
  };
}
const stored = (file: string): StoredVocabulary & Record<string, unknown> => JSON.parse(readFileSync(file, "utf8"));
const analysedFiles = (dir: Record<string, string>): number => extract(new Map(Object.entries(dir))).nodes.filter((node) => node.level === "file" && node.analysis === "analysed").length;

test("setup with judging records memberships next to the vocabulary and reports real coverage: mapped over analysed files, measured", async () => {
  const dir = repo(files);
  const client = clientFor();
  const result = await setUp({ dir, cacheDir: temp("streets-cache-"), judge: client });
  const file = stored(result.file);
  expect(file.vocabulary.terms.length).toBeGreaterThan(3);
  expect(file.memberships?.tier).toBe("judged");
  expect(file.memberships?.gate).toEqual({ id: "membership", version: "membership-v1" });
  expect(file.memberships!.records.length).toBe(client.requests.length);
  // Both files hold a function that belongs to a term; the middle band and the nos do not count.
  expect(file.coverage).toMatchObject({ of: analysedFiles(files), mapped: 2, measured: true });
  expect(result.stored.coverage).toEqual(file.coverage);
  expect(result.judging).toMatchObject({ status: "judged", reused: 0 });
  const text = reportLines(result).join("\n");
  expect(text).toMatch(/coverage: 2 of 2 analysed files map to a term \(measured/);
  expect(text).not.toMatch(/not measured/);
});

test("a record keeps what Jev was shown, its answers, the thresholds, the model and the function's digest", async () => {
  const result = await setUp({ dir: repo(files), cacheDir: temp("streets-cache-"), judge: clientFor() });
  const memberships = stored(result.file).memberships!;
  const record = memberships.records.find((one) => one.verdict === "settled")!;
  expect(record).toMatchObject({ tier: "judged", model: "fake-1", thresholds: { belongs: 0.9, incidental: 0.3, not: 0.1 } });
  expect(record.shown.state.code).toContain("function ");
  expect(record.answers.belongs).toEqual({ type: "yes-no", yes: 0.97 });
  const unit = memberships.units.find((one) => one.key === record.unit)!;
  expect(unit.digest).toBe(record.digest);
  expect(unit.candidates).toContain(record.term);
});

test("a middle probability stays unmapped and is reported as the middle band, never as a member", async () => {
  const result = await setUp({ dir: repo(files), cacheDir: temp("streets-cache-"), judge: clientFor({ "Order flow | placeOrder": [0.6] }) });
  expect(result.stored.coverage).toMatchObject({ mapped: 0, measured: true });
  const text = reportLines(result).join("\n");
  expect(text).toMatch(/coverage: 0 of 2 analysed files map to a term \(measured/);
  expect(text).toMatch(/middle band/);
});

test("a function no term is a candidate for is shown as having no term, and a docs term with no members as a term with no members", async () => {
  const dir = repo({ ...files, "src/zz/quux.ts": "export function quux(): void {}\n" });
  const result = await setUp({ dir, cacheDir: temp("streets-cache-"), judge: clientFor() });
  const text = reportLines(result).join("\n");
  expect(text).toMatch(/with no term: 1 \(1 with no candidate term, no term shares a word with it/);
  expect(text).toMatch(/term with no members: Zebra crossing \(no code shares a word with it\)/);
  expect(text).toMatch(/term with no members: Payment providers \(all 1 candidate judged not a member\)/);
  expect(text).not.toMatch(/term with no members: placeOrder/);
});

test("a term whose pairs were not all judged is unknown, never a term with no members", async () => {
  const failing: JevClient = {
    model: "fake-1",
    ask: () => Promise.reject(new JevError("network", "Jev could not be reached")),
  };
  const result = await setUp({ dir: repo(files), cacheDir: temp("streets-cache-"), judge: failing });
  expect(result.stored.coverage).toMatchObject({ mapped: 0, measured: false });
  expect(result.stored.coverage.unjudged).toBeGreaterThan(0);
  const text = reportLines(result).join("\n");
  expect(text).toMatch(/coverage: at least 0 of 2 analysed files map to a term: not fully measured/);
  expect(text).toMatch(/not judged/);
  expect(text).not.toMatch(/term with no members: placeOrder/);
  expect(text).toMatch(/term not known to have members: Payment providers \(1 pair not judged\)/);
  expect(text).not.toMatch(/term with no members: Payment providers/);
  expect(text).not.toMatch(/\(measured/);
});

test("a function that changes marks its mapping stale, keyed on the function's digest, and stale mappings do not count as mapped", async () => {
  const dir = repo(files);
  const cacheDir = temp("streets-cache-");
  const first = await setUp({ dir, cacheDir, judge: clientFor() });
  expect(first.stored.coverage).toMatchObject({ mapped: 2, measured: true });
  commit(dir, { "src/payments/stripe.ts": "// Charges a card.\nexport function chargeCard(amount: number): void {\n  void amount;\n  void 1;\n}\n" });
  const second = await setUp({ dir, cacheDir });
  const memberships = stored(second.file).memberships!;
  const charge = memberships.records.filter((one) => memberships.units.find((unit) => unit.key === one.unit)?.name === "chargeCard");
  expect(charge.length).toBeGreaterThan(0);
  expect(charge.every((one) => one.stale === "the function changed")).toBe(true);
  const place = memberships.records.filter((one) => memberships.units.find((unit) => unit.key === one.unit)?.name === "placeOrder");
  expect(place.every((one) => one.stale === undefined)).toBe(true);
  expect(second.stored.coverage).toMatchObject({ mapped: 1, measured: false });
  expect(second.stored.coverage.stale).toBe(charge.length);
  expect(reportLines(second).join("\n")).toMatch(/coverage: at least 1 of 2 analysed files map to a term: not fully measured .*\d+ stale/);
});

test("a judged re-run asks only what changed: the stale function's pairs, not the rest", async () => {
  const dir = repo(files);
  const cacheDir = temp("streets-cache-");
  const first = clientFor();
  await setUp({ dir, cacheDir, judge: first });
  commit(dir, { "src/payments/stripe.ts": "// Charges a card.\nexport function chargeCard(amount: number): void {\n  void amount;\n  void 1;\n}\n" });
  const again = clientFor();
  const second = await setUp({ dir, cacheDir, judge: again });
  expect(again.requests.length).toBeGreaterThan(0);
  expect(again.requests.length).toBeLessThan(first.requests.length);
  expect(again.requests.every((request) => /function chargeCard/.test(request.state.code ?? ""))).toBe(true);
  expect(second.stored.coverage).toMatchObject({ mapped: 2, measured: true });
  expect(second.judging).toMatchObject({ status: "judged" });
  expect(second.judging?.status === "judged" && second.judging.reused).toBeGreaterThan(0);
});

test("a function that is removed drops its mapping and a term that is gone drops its mappings, counted", async () => {
  const dir = repo(files);
  const cacheDir = temp("streets-cache-");
  await setUp({ dir, cacheDir, judge: clientFor() });
  git(dir, "rm", "--quiet", "src/orders/place.ts");
  git(dir, "commit", "--quiet", "-m", "remove");
  const second = await setUp({ dir, cacheDir });
  const memberships = stored(second.file).memberships!;
  expect(memberships.units.some((unit) => unit.name === "placeOrder")).toBe(false);
  expect(memberships.records.some((one) => one.unit.includes("placeOrder"))).toBe(false);
  expect(second.stored.coverage).toMatchObject({ mapped: 1 });
});

test("nothing changed and everything judged: a judged run asks nothing and writes nothing", async () => {
  const dir = repo(files);
  const cacheDir = temp("streets-cache-");
  const first = await setUp({ dir, cacheDir, judge: clientFor() });
  const before = statSync(first.file).mtimeMs;
  const bytes = readFileSync(first.file, "utf8");
  const again = clientFor();
  const second = await setUp({ dir, cacheDir, judge: again });
  expect(again.requests).toHaveLength(0);
  expect(second.work).toBe("unchanged");
  expect(readFileSync(first.file, "utf8")).toBe(bytes);
  expect(statSync(first.file).mtimeMs).toBe(before);
});

test("setup without judging stores no memberships and reports coverage as not measured, as before", async () => {
  const result = await setUp({ dir: repo(files), cacheDir: temp("streets-cache-") });
  expect(stored(result.file).memberships).toBeUndefined();
  expect(result.stored.coverage).toEqual({ of: analysedFiles(files), mapped: 0, measured: false });
  const text = reportLines(result).join("\n");
  expect(text).toMatch(/coverage: 0 of 2 analysed files map to a term: not measured/);
  expect(text).toContain("streets setup --judge");
});

test("fields another step added survive a judged run, and so do memberships when the vocabulary is rebuilt", async () => {
  const dir = repo(files);
  const cacheDir = temp("streets-cache-");
  const first = await setUp({ dir, cacheDir, judge: clientFor() });
  const withExtra = stored(first.file);
  withExtra.corrections = [{ term: "order flow", rename: "ordering" }];
  writeFileSync(first.file, JSON.stringify(withExtra));
  commit(dir, { "src/orders/cancel.ts": "export function cancelOrder(): void {}\n" });
  const second = await setUp({ dir, cacheDir, judge: clientFor() });
  expect(second.work).toBe("rebuilt");
  const after = stored(second.file);
  expect(after.corrections).toEqual([{ term: "order flow", rename: "ordering" }]);
  expect(after.memberships?.units.some((unit) => unit.name === "cancelOrder")).toBe(true);
});

test("a damaged memberships record is replaced like any damaged stored file, never half trusted", async () => {
  const dir = repo(files);
  const cacheDir = temp("streets-cache-");
  const first = await setUp({ dir, cacheDir, judge: clientFor() });
  const damaged = stored(first.file);
  delete (damaged.memberships!.records[0] as unknown as Record<string, unknown>).answers;
  writeFileSync(first.file, JSON.stringify(damaged));
  const second = await setUp({ dir, cacheDir });
  expect(second.work).toBe("replaced unreadable");
  expect(stored(second.file).memberships).toBeUndefined();
  expect(second.stored.coverage).toMatchObject({ mapped: 0, measured: false });
});

test("nothing secret reaches the store: not a literal in a function, not a secret-shaped path, not the TypeSafe key", async () => {
  vi.stubEnv("TYPESAFE_API_KEY", "ts_live_0123456789abcdef0123456789abcdef");
  const secret = "ghp_1234567890abcdefABCDEF1234567890abcd";
  try {
    const dir = repo({ ...files, "src/orders/token.ts": `export function placeToken(): string {\n  return "${secret}";\n}\n`, [`src/orders/${secret}.ts`]: "export function placeSecret(): void {}\n" });
    const result = await setUp({ dir, cacheDir: temp("streets-cache-"), judge: clientFor() });
    const raw = readFileSync(result.file, "utf8");
    expect(raw).not.toContain("1234567890abcdef");
    expect(raw).not.toContain("0123456789abcdef");
    expect(reportLines(result).join("\n")).not.toContain("1234567890abcdef");
    expect(JSON.stringify(result.stored.coverage)).toContain("measured");
  } finally {
    vi.unstubAllEnvs();
  }
});

test("pairs over the limit are counted as not judged and keep coverage not fully measured", async () => {
  const result = await setUp({ dir: repo(files), cacheDir: temp("streets-cache-"), judge: clientFor(), deps: { maxPairs: 1 } });
  expect(result.stored.coverage.measured).toBe(false);
  expect(result.stored.coverage.unjudged).toBeGreaterThan(0);
  expect(result.judging).toMatchObject({ status: "judged", overLimit: expect.any(Number) });
  expect(reportLines(result).join("\n")).toMatch(/over the limit of 1/);
});
