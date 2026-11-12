import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { JevError, jevCost } from "../src/jev/client.ts";
import type { JevClient, JevRequest, JevResponse } from "../src/jev/client.ts";
import { reportLines, setUp } from "../src/setup.ts";

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
  const dir = temp("streets-round2-");
  git(dir, "init", "--quiet", "--initial-branch=main");
  commit(dir, files);
  return dir;
}
type Loose = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const stored = (file: string): Loose => JSON.parse(readFileSync(file, "utf8"));

/** Answers by the term's name: a number is belongs, "fail" is a call that cannot be made. Anything else is a confident no. */
function clientFor(rows: Record<string, number | "fail"> = {}): JevClient & { requests: JevRequest[] } {
  const requests: JevRequest[] = [];
  return {
    model: "fake-1",
    requests,
    async ask(request): Promise<JevResponse> {
      requests.push(request);
      const term = /^Term: (.*)$/m.exec(request.state.term ?? "")?.[1] ?? "?";
      const row = rows[term] ?? 0.03;
      if (row === "fail") throw new JevError("network", "Jev could not be reached");
      return { answers: { belongs: { type: "yes-no", yes: row }, incidental: { type: "yes-no", yes: 0.02 } }, usage: { inputTokens: 100, outputTokens: 3, usd: jevCost(100) }, model: "fake-1" };
    },
  };
}

test("a term whose definition changed makes its mapping stale: only the function's digest was not enough", async () => {
  const dir = repo({ "docs/guide.md": "# Invoice\n\nA bill sent to a customer after an order.\n", "src/billing/invoice.ts": "export function invoice(): void {}\n" });
  const cacheDir = temp("streets-cache-");
  const first = await setUp({ dir, cacheDir, judge: clientFor({ Invoice: 0.97 }) });
  expect(first.stored.coverage).toMatchObject({ mapped: 1, measured: true });
  commit(dir, { "docs/guide.md": "# Invoice\n\nA request for payment that a supplier gives a company.\n" });
  const second = await setUp({ dir, cacheDir });
  const all = stored(second.file).memberships.records;
  const records = all.filter((one: Loose) => one.term === "invoic");
  expect(records).toHaveLength(1);
  expect(records[0].stale).toBe("the term's definition changed");
  // Another term's record (the folder "billing") was shown the same text as before: still current.
  expect(all.filter((one: Loose) => one.term !== "invoic").every((one: Loose) => one.stale === undefined)).toBe(true);
  expect(second.stored.coverage).toMatchObject({ mapped: 0, measured: false, stale: 1 });
  // Judged again, it is asked about the new definition.
  const again = clientFor({ Invoice: 0.97 });
  const third = await setUp({ dir, cacheDir, judge: again });
  expect(again.requests.length).toBeGreaterThan(0);
  expect(third.stored.coverage).toMatchObject({ mapped: 1, measured: true });
});

const sixTerms = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"].map((word) => `# Invoice ${word}\n\ntext\n`).join("\n");

test("a function with candidates left out by the cap, and no member among those asked, is not known: never with no term", async () => {
  const result = await setUp({ dir: repo({ "docs/g.md": sixTerms, "src/invoice.ts": "export function invoice(): void {}\n" }), cacheDir: temp("streets-cache-"), judge: clientFor() });
  const text = reportLines(result).join("\n");
  expect(text).toMatch(/with no term: 0\b/);
  expect(text).toMatch(/not known: 1 /);
  expect(text).not.toMatch(/judged not a member of any candidate/);
  expect(result.stored.coverage.measured).toBe(false);
  expect(text).not.toMatch(/\(measured/);
  expect(text).toMatch(/term not known to have members: Invoice foxtrot \(1 candidate left out by the cap/);
});

test("the overflow line counts how many omitted docs terms are without members and how many are not known, with the right plural", async () => {
  const names = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel", "India", "Juliet", "Kilo"];
  const docs = [...names, "Zulu order"].map((name) => `# ${name}\n\ntext\n`).join("\n");
  const result = await setUp({ dir: repo({ "docs/g.md": docs, "src/orders/place.ts": "export function placeOrder(): void {}\n" }), cacheDir: temp("streets-cache-"), judge: clientFor({ "Zulu order": "fail" }) });
  const text = reportLines(result).join("\n");
  expect(text).toMatch(/term with no members: Juliet/);
  expect(text).not.toMatch(/term .*: Kilo/);
  expect(text).toMatch(/and 2 more terms from the docs: 1 with no members, 1 not known to have members/);
  expect(text).not.toMatch(/1 more terms/);
});

test("the overflow line says '1 more term' for one", async () => {
  const names = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel", "India", "Juliet", "Kilo"];
  const result = await setUp({ dir: repo({ "docs/g.md": names.map((name) => `# ${name}\n\ntext\n`).join("\n"), "src/orders/place.ts": "export function placeOrder(): void {}\n" }), cacheDir: temp("streets-cache-"), judge: clientFor() });
  expect(reportLines(result).join("\n")).toMatch(/and 1 more term from the docs: 1 with no members/);
});

test.each([
  ["a text file in a language no adapter reads", { "tools/run.py": "def run():\n    pass\n" }],
  ["a code file that is not fully read", { "src/broken.ts": "export function (((\n" }],
])("with %s, a docs term nothing maps to is not known to have members, never with no members", async (_name, extra) => {
  const result = await setUp({ dir: repo({ "docs/g.md": "# Zebra crossing\n\ntext\n", "src/orders/place.ts": "export function placeOrder(): void {}\n", ...extra }), cacheDir: temp("streets-cache-"), judge: clientFor() });
  const text = reportLines(result).join("\n");
  expect(text).toMatch(/term not known to have members: Zebra crossing \(1 code file could not be read\)/);
  expect(text).not.toMatch(/term with no members: Zebra crossing/);
});

test("a repository whose code was all read still says a docs term nothing shares a word with has no members", async () => {
  const result = await setUp({ dir: repo({ "docs/g.md": "# Zebra crossing\n\ntext\n", "src/orders/place.ts": "export function placeOrder(): void {}\n" }), cacheDir: temp("streets-cache-"), judge: clientFor() });
  expect(reportLines(result).join("\n")).toMatch(/term with no members: Zebra crossing \(no code shares a word with it\)/);
});

test.each([
  ["its records removed and its coverage kept", (file: Loose) => (file.memberships.records = [])],
  ["its coverage raised", (file: Loose) => (file.coverage.mapped = 2)],
  ["its coverage claimed measured", (file: Loose) => ((file.memberships.records = file.memberships.records.slice(0, 1)), (file.coverage.measured = true))],
  ["its memberships removed and its coverage kept", (file: Loose) => delete file.memberships],
])("a stored file with %s is damaged: coverage is checked against the records before an unchanged setup returns it", async (_name, damage) => {
  const dir = repo({ "docs/g.md": "# Invoice\n\ntext\n", "src/billing/invoice.ts": "export function invoice(): void {}\n" });
  const cacheDir = temp("streets-cache-");
  const first = await setUp({ dir, cacheDir, judge: clientFor({ Invoice: 0.97 }) });
  expect(first.stored.coverage).toMatchObject({ mapped: 1, measured: true });
  const file = stored(first.file);
  damage(file);
  writeFileSync(first.file, JSON.stringify(file));
  const second = await setUp({ dir, cacheDir });
  expect(second.work).toBe("replaced unreadable");
  expect(second.stored.coverage).toMatchObject({ mapped: 0, measured: false });
});
