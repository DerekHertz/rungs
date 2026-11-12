import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { jevCost } from "../src/jev/client.ts";
import type { JevAnswer, JevClient, JevRequest, JevResponse } from "../src/jev/client.ts";
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
function repo(files: Record<string, string>): string {
  const dir = temp("streets-round1-");
  git(dir, "init", "--quiet", "--initial-branch=main");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  git(dir, "add", "--all");
  git(dir, "commit", "--quiet", "-m", "base");
  return dir;
}

const files = {
  "package.json": '{\n  "description": "Checkout service for the shop"\n}\n',
  "docs/guide.md": "# Order flow\n\ntext\n\n## Payment providers\n\ntext\n\n## Zebra crossing\n\ntext\n",
  "src/payments/stripe.ts": "// Charges a card.\nexport function chargeCard(amount: number): void {\n  void amount;\n}\n",
  "src/orders/place.ts": "export function placeOrder(): void {}\n",
};

type Loose = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const stored = (file: string): Loose => JSON.parse(readFileSync(file, "utf8"));

/** Maps "orders" to placeOrder and "payments" to chargeCard, a confident no for the rest. */
function goodClient(): JevClient & { requests: JevRequest[] } {
  const requests: JevRequest[] = [];
  return {
    model: "fake-1",
    requests,
    async ask(request): Promise<JevResponse> {
      requests.push(request);
      const term = /^Term: (.*)$/m.exec(request.state.term ?? "")?.[1] ?? "?";
      const yes = term === "orders" || term === "payments" ? 0.97 : 0.03;
      return { answers: { belongs: { type: "yes-no", yes }, incidental: { type: "yes-no", yes: 0.02 } }, usage: { inputTokens: 100, outputTokens: 3, usd: jevCost(100) }, model: "fake-1" };
    },
  };
}
function incompleteClient(kind: "missing" | "unreadable"): JevClient & { requests: JevRequest[] } {
  const requests: JevRequest[] = [];
  return {
    model: "fake-1",
    requests,
    async ask(request): Promise<JevResponse> {
      requests.push(request);
      const incidental: Record<string, JevAnswer> = kind === "missing" ? {} : { incidental: { type: "unreadable", why: "not a probability", raw: "?" } };
      return { answers: { belongs: { type: "yes-no", yes: 0.97 }, ...incidental }, usage: { inputTokens: 100, outputTokens: 3, usd: jevCost(100) }, model: "fake-1" };
    },
  };
}

test.each(["missing", "unreadable"] as const)("a record with a %s answer is not judged: coverage stays not measured, a docs term is not known to have members, and the next judged run asks it again", async (kind) => {
  const dir = repo(files);
  const cacheDir = temp("streets-cache-");
  const bad = incompleteClient(kind);
  const first = await setUp({ dir, cacheDir, judge: bad });
  expect(first.stored.coverage).toMatchObject({ mapped: 0, measured: false });
  expect(first.stored.coverage.unjudged).toBe(bad.requests.length);
  expect(stored(first.file).memberships.records).toEqual([]);
  const text = reportLines(first).join("\n");
  expect(text).not.toMatch(/\(measured/);
  expect(text).not.toMatch(/term with no members: Payment providers/);
  expect(text).toMatch(/term not known to have members: Payment providers \(1 pair not judged\)/);
  const again = goodClient();
  const second = await setUp({ dir, cacheDir, judge: again });
  expect(again.requests).toHaveLength(bad.requests.length);
  expect(second.stored.coverage).toMatchObject({ mapped: 2, measured: true });
});

test("a stored record that lacks an answer to a question it was asked is damaged: the file is replaced, never counted", async () => {
  const dir = repo(files);
  const cacheDir = temp("streets-cache-");
  const first = await setUp({ dir, cacheDir, judge: goodClient() });
  const damaged = stored(first.file);
  damaged.memberships.records[0].answers = {};
  writeFileSync(first.file, JSON.stringify(damaged));
  const second = await setUp({ dir, cacheDir });
  expect(second.work).toBe("replaced unreadable");
  expect(stored(second.file).memberships).toBeUndefined();
  expect(second.stored.coverage).toMatchObject({ mapped: 0, measured: false });
});

test.each([
  ["a verdict the answers do not give", (record: Loose) => ((record.verdict = "settled"), (record.answers.belongs.yes = 0.5))],
  ["an answer that is not a probability", (record: Loose) => (record.answers.belongs.yes = 7)],
  ["a settled verdict on a refusing answer", (record: Loose) => ((record.verdict = "settled"), (record.answers.belongs.yes = 0.01))],
  ["an unreadable answer", (record: Loose) => (record.answers.incidental = { type: "unreadable", why: "x", raw: "y" })],
])("a stored record with %s is damaged", async (_name, damage) => {
  const dir = repo(files);
  const cacheDir = temp("streets-cache-");
  const first = await setUp({ dir, cacheDir, judge: goodClient() });
  const file = stored(first.file);
  damage(file.memberships.records[0]);
  writeFileSync(first.file, JSON.stringify(file));
  expect((await setUp({ dir, cacheDir })).work).toBe("replaced unreadable");
});

test("a record kept from an older question version is not judged against this version's verdict rule", async () => {
  const dir = repo(files);
  const cacheDir = temp("streets-cache-");
  const first = await setUp({ dir, cacheDir, judge: goodClient() });
  const file = stored(first.file);
  file.memberships.records[0].question.version = "membership-v0";
  file.memberships.records[0].verdict = "undecided";
  writeFileSync(first.file, JSON.stringify(file));
  const second = await setUp({ dir, cacheDir });
  expect(second.work).toBe("unchanged");
});

test("coverage over no analysed files is not measured, and says why", async () => {
  const result = await setUp({ dir: repo({ "README.md": "# Tinyparse\n\n## Config files\n\ntext\n" }), cacheDir: temp("streets-cache-"), judge: goodClient() });
  expect(result.stored.coverage).toMatchObject({ of: 0, mapped: 0, measured: false });
  expect(result.stored.coverage.reason).toMatch(/no analysed files/);
  const text = reportLines(result).join("\n");
  expect(text).toMatch(/coverage: not measured: no analysed files/);
  expect(text).not.toMatch(/\(measured/);
});

test("coverage when no pair was picked is not measured, and says why", async () => {
  const result = await setUp({ dir: repo({ "docs/guide.md": "# Banana\n\ntext\n", "src/zz/quux.ts": "export function quux(): void {}\n" }), cacheDir: temp("streets-cache-"), judge: goodClient() });
  expect(result.stored.coverage).toMatchObject({ of: 1, mapped: 0, measured: false });
  expect(result.stored.coverage.reason).toMatch(/no pair was picked/);
  const text = reportLines(result).join("\n");
  expect(text).toMatch(/coverage: not measured: no pair was picked/);
  expect(text).not.toMatch(/\(measured/);
});
