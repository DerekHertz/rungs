import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { certificationOf, correctionsDigest, vocabularyDigest } from "../src/corrections.ts";
import type { Correction } from "../src/corrections.ts";
import { jevCost } from "../src/jev/client.ts";
import type { JevClient, JevResponse } from "../src/jev/client.ts";
import { readVocabulary, reportLines } from "../src/setup.ts";
import type { StoredVocabulary } from "../src/setup.ts";
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
  const dir = temp("streets-csetup-");
  git(dir, "init", "--quiet", "--initial-branch=main");
  commit(dir, files);
  return dir;
}
const files = {
  "package.json": '{\n  "description": "Checkout service for the shop"\n}\n',
  "docs/guide.md": "# Order flow\n\ntext\n\n## Payment providers\n\ntext\n",
  "src/payments/stripe.ts": "export function chargeCard(amount: number): void {}\n",
  "src/orders/place.ts": "export function placeOrder(): void {}\n",
};
const answering: JevClient = {
  model: "fake-1",
  async ask(): Promise<JevResponse> {
    return { answers: { belongs: { type: "yes-no", yes: 0.03 }, incidental: { type: "yes-no", yes: 0.02 } }, usage: { inputTokens: 1, outputTokens: 1, usd: jevCost(1) }, model: "fake-1" };
  },
};

const stamp = { by: "Ada", at: "2026-11-11T10:00:00.000Z" };
const corrections: Correction[] = [
  { ...stamp, kind: "rename", term: "order flow", name: "ordering", label: "Order flow" },
  { ...stamp, kind: "member", unit: "function:src/orders/place.ts#placeOrder", term: "order", belongs: true, label: "placeOrder in src/orders/place.ts, term orders" },
  { ...stamp, kind: "member", unit: "function:src/gone.ts#gone", term: "order", belongs: true, label: "gone in src/gone.ts, term orders" },
];

/** A first setup, then corrections and a certification written into the store the way the command does. */
async function certifiedStore(judge = false) {
  const dir = repo(files);
  const cacheDir = temp("streets-cache-");
  const first = await setUp({ dir, cacheDir, ...(judge ? { judge: answering } : {}) });
  const whole = JSON.parse(readFileSync(first.file, "utf8")) as StoredVocabulary & Record<string, unknown>;
  const certification = { by: "Grace", at: "2026-11-12T08:00:00.000Z", vocabulary: vocabularyDigest(whole.vocabulary.terms), corrections: correctionsDigest(corrections) };
  writeFileSync(first.file, JSON.stringify({ ...whole, corrections, certification }));
  return { dir, cacheDir, file: first.file };
}
const read = (file: string): StoredVocabulary & Record<string, unknown> => JSON.parse(readFileSync(file, "utf8"));

test("corrections and the certification survive a re-run of setup that changes nothing", async () => {
  const { dir, cacheDir, file } = await certifiedStore();
  const second = await setUp({ dir, cacheDir });
  expect(second.work).toBe("unchanged");
  expect(read(file)).toMatchObject({ corrections, certification: { by: "Grace" } });
});

test("they survive a judged re-run", async () => {
  const { dir, cacheDir, file } = await certifiedStore();
  await setUp({ dir, cacheDir, judge: answering });
  expect(read(file)).toMatchObject({ corrections, certification: { by: "Grace" } });
  await setUp({ dir, cacheDir, judge: answering });
  expect(read(file).corrections).toEqual(corrections);
});

test("they survive a rebuild after a file changed, and the certification stays certified when the terms did not change", async () => {
  const { dir, cacheDir, file } = await certifiedStore();
  commit(dir, { "src/orders/place.ts": "export function placeOrder(): number {\n  return 1;\n}\n" });
  const second = await setUp({ dir, cacheDir });
  expect(second.work).toBe("rebuilt");
  const after = read(file);
  expect(after.corrections).toEqual(corrections);
  expect(certificationOf(after.vocabulary.terms, after.corrections!, after.certification)).toMatchObject({ kind: "certified", by: "Grace" });
});

test("a rebuild that changes the term list says the certification is for terms that changed", async () => {
  const { dir, cacheDir, file } = await certifiedStore();
  commit(dir, { "docs/more.md": "# Refund policy\n\ntext\n" });
  await setUp({ dir, cacheDir });
  const after = read(file);
  expect(after.corrections).toEqual(corrections);
  expect(certificationOf(after.vocabulary.terms, after.corrections!, after.certification)).toMatchObject({ kind: "changed", by: "Grace" });
});

test("they survive a change of the vocabulary table or the extractor, which rebuilds everything", async () => {
  const { dir, cacheDir, file } = await certifiedStore();
  const stored = read(file);
  writeFileSync(file, JSON.stringify({ ...stored, vocabulary: { ...stored.vocabulary, tableVersion: stored.vocabulary.tableVersion - 1 } }));
  expect((await setUp({ dir, cacheDir })).work).toBe("rules changed");
  expect(read(file).corrections).toEqual(corrections);
  writeFileSync(file, JSON.stringify({ ...read(file), extractorVersion: "0" }));
  expect((await setUp({ dir, cacheDir })).work).toBe("rules changed");
  expect(read(file)).toMatchObject({ corrections, certification: { by: "Grace" } });
});

test("a correction about a function that no longer exists is kept and the report says it no longer applies", async () => {
  const { dir, cacheDir, file } = await certifiedStore();
  commit(dir, { "docs/more.md": "# Refund policy\n\ntext\n" });
  const second = await setUp({ dir, cacheDir });
  expect(read(file).corrections).toHaveLength(3);
  expect(second.corrections).toMatchObject({ kept: 3 });
  expect(second.corrections!.noLongerApply.map((one) => one.why)).toEqual(["the function is not in this tree"]);
  const text = reportLines(second).join("\n");
  expect(text).toContain("corrections: 3 corrections kept, 1 no longer apply");
  expect(text).toContain("no longer applies: yes: gone in src/gone.ts, term orders (the function is not in this tree)");
  expect(text).toContain("vocabulary: certified by Grace at 2026-11-12T08:00:00.000Z, vocabulary changed since");
});

test("the report says a vocabulary is drafted until it is certified", async () => {
  const dir = repo(files);
  const result = await setUp({ dir, cacheDir: temp("streets-cache-") });
  expect(reportLines(result).join("\n")).toContain("vocabulary: drafted: nobody has certified it");
});

test("a stored file that cannot be read is copied aside before it is replaced, and the report says where the corrections are", async () => {
  const { dir, cacheDir, file } = await certifiedStore();
  const damaged = `${readFileSync(file, "utf8").slice(0, 200)}`;
  writeFileSync(file, damaged);
  const second = await setUp({ dir, cacheDir });
  expect(second.work).toBe("replaced unreadable");
  expect(second.backup).toBeDefined();
  expect(readFileSync(second.backup!, "utf8")).toBe(damaged);
  expect(readdirSync(dirname(file)).filter((name) => name.includes(".unreadable-"))).toHaveLength(1);
  expect(reportLines(second).join("\n")).toContain(`copied to ${second.backup}`);
  expect(read(file).corrections).toBeUndefined();
});

test("a stored file whose corrections are malformed is unreadable, not half trusted: it is copied aside too", async () => {
  const { dir, cacheDir, file } = await certifiedStore();
  writeFileSync(file, JSON.stringify({ ...read(file), corrections: [{ kind: "teleport" }] }));
  expect((await readVocabulary(dir, cacheDir)).kind).toBe("unreadable");
  const second = await setUp({ dir, cacheDir });
  expect(second.work).toBe("replaced unreadable");
  expect(existsSync(second.backup!)).toBe(true);
});

test("a stored file that is not there is built, with no backup", async () => {
  const dir = repo(files);
  const first = await setUp({ dir, cacheDir: temp("streets-cache-") });
  expect(first.backup).toBeUndefined();
});
