import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { jevCost } from "../src/jev/client.ts";
import type { JevClient, JevResponse } from "../src/jev/client.ts";
import { readVocabulary } from "../src/setup.ts";
import type { StoredVocabulary } from "../src/setup.ts";
import { VOCABULARY_USAGE, vocabularyCommand } from "../src/vocabulary-command.ts";
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
function repo(files: Record<string, string>): string {
  const dir = temp("streets-vcmd-");
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
  "docs/guide.md": "# Order flow\n\ntext\n\n## Payment providers\n\ntext\n",
  "src/payments/stripe.ts": "export function chargeCard(amount: number): void {}\n",
  "src/orders/place.ts": "export function placeOrder(): void {}\n",
  "src/orders/cancel.ts": "export function placeOrder(): void {}\n",
  "src/misc/odd.ts": "export function oddJob(): void {}\n",
};
const answering: JevClient = {
  model: "fake-1",
  async ask(): Promise<JevResponse> {
    return { answers: { belongs: { type: "yes-no", yes: 0.03 }, incidental: { type: "yes-no", yes: 0.02 } }, usage: { inputTokens: 1, outputTokens: 1, usd: jevCost(1) }, model: "fake-1" };
  },
};

/** A repository with a stored vocabulary, and a way to run the command against it. The clock moves a minute with every call. */
async function world(judge = false) {
  const dir = repo(files);
  const cacheDir = temp("streets-cache-");
  const first = await setUp({ dir, cacheDir, ...(judge ? { judge: answering } : {}) });
  let minute = 0;
  const run = (args: string[], over: { name?: string | undefined } = { name: "Ada Lovelace" }) =>
    vocabularyCommand([...args, "--dir", dir], { cacheDir, now: () => new Date(Date.UTC(2026, 10, 11, 10, minute++)), gitName: async () => over.name });
  const stored = (): StoredVocabulary & Record<string, unknown> => JSON.parse(readFileSync(first.file, "utf8"));
  return { dir, cacheDir, file: first.file, run, stored };
}
const text = (result: { out: readonly string[]; err: readonly string[] }): string => [...result.out, ...result.err].join("\n");

test("with no command or with --help it prints how to use it, naming every command", async () => {
  const { run } = await world();
  const none = await run([]);
  expect(none.code).toBe(2);
  const help = await run(["--help"]);
  expect(help.code).toBe(0);
  for (const word of ["list", "confirm", "rename", "merge", "remove", "member", "certify", "--by", "--dir"]) expect(text(help)).toContain(word);
  expect(VOCABULARY_USAGE).toContain("certify");
  const wrong = await run(["frobnicate"]);
  expect(wrong.code).toBe(2);
  expect(text(wrong)).toContain("frobnicate");
});

test("without a stored vocabulary every command says to run setup and changes nothing", async () => {
  const dir = repo(files);
  const cacheDir = temp("streets-cache-");
  for (const args of [["list"], ["confirm", "orders"], ["certify"]]) {
    const result = await vocabularyCommand([...args, "--dir", dir], { cacheDir, gitName: async () => "Ada" });
    expect(result.code).toBe(1);
    expect(text(result)).toContain("streets setup");
  }
  expect(readdirSync(cacheDir)).toEqual([]);
});

test("confirm stores who and when, as a display name taken from git config; the email is never stored", async () => {
  const { run, stored } = await world();
  const done = await run(["confirm", "Orders"]);
  expect(done.code).toBe(0);
  expect(stored().corrections).toEqual([{ kind: "confirm", term: "order", label: "orders", by: "Ada Lovelace", at: "2026-11-11T10:00:00.000Z" }]);
  expect(JSON.stringify(stored())).not.toContain("@");
  expect(text(done)).toContain("confirmed orders");
});

test("--by names the person instead of git config, and with neither the command refuses and changes nothing", async () => {
  const { run, stored } = await world();
  await run(["confirm", "orders", "--by", "Grace"], { name: "Ada" });
  expect(stored().corrections![0]).toMatchObject({ by: "Grace" });
  const before = JSON.stringify(stored());
  const none = await run(["confirm", "payments"], { name: undefined });
  expect(none.code).toBe(1);
  expect(text(none)).toContain("--by");
  expect(JSON.stringify(stored())).toBe(before);
});

test("an email is on the page only when the person passes it as the name", async () => {
  const { run, stored } = await world();
  await run(["confirm", "orders", "--by", "ada@example.com"]);
  expect(stored().corrections![0]).toMatchObject({ by: "ada@example.com" });
});

test("a name shaped like a secret is refused as the author and as a new term name", async () => {
  const { run, stored } = await world();
  const secret = `ghp_${"a1B2c3D4e5F6g7H8i9J0"}`;
  expect((await run(["confirm", "orders", "--by", secret])).code).toBe(1);
  const renamed = await run(["rename", "orders", secret]);
  expect(renamed.code).toBe(1);
  expect(text(renamed)).toContain("secret");
  expect(text(renamed)).not.toContain(secret);
  expect(stored().corrections).toBeUndefined();
});

test("rename shows the new name from then on, and finds the term by its new name", async () => {
  const { run, stored } = await world();
  expect((await run(["rename", "payments", "billing"])).code).toBe(0);
  expect(stored().corrections![0]).toMatchObject({ kind: "rename", term: "payment", name: "billing", label: "payments" });
  expect(text(await run(["list"]))).toContain("billing");
  expect((await run(["confirm", "billing"])).code).toBe(0);
  expect((await run(["rename", "billing", "  "])).code).toBe(1);
  expect((await run(["rename", "billing", "line\nbreak"])).code).toBe(1);
  expect((await run(["rename", "billing", "billing"])).code).toBe(1);
});

test("a term that is not there, or that two terms answer to, is an error naming the choices", async () => {
  const { run, stored, file } = await world();
  const missing = await run(["confirm", "nonesuch"]);
  expect(missing.code).toBe(1);
  expect(text(missing)).toContain("nonesuch");
  expect(stored().corrections).toBeUndefined();
  const whole = stored();
  const first = whole.vocabulary.terms[0]!;
  writeFileSync(file, JSON.stringify({ ...whole, vocabulary: { ...whole.vocabulary, terms: [...whole.vocabulary.terms, { ...first, key: "twin" }] } }));
  const ambiguous = await run(["confirm", first.name]);
  expect(ambiguous.code).toBe(1);
  expect(text(ambiguous)).toContain("twin");
  expect(stored().corrections).toBeUndefined();
  // A key is exact: it names one term.
  expect((await run(["confirm", "twin"])).code).toBe(0);
});

test("merge folds a term into another; it refuses itself, a loop, and a term that is gone", async () => {
  const { run, stored } = await world();
  expect((await run(["merge", "payments", "payments"])).code).toBe(1);
  expect((await run(["merge", "payments", "orders"])).code).toBe(0);
  expect(stored().corrections![0]).toMatchObject({ kind: "merge", term: "payment", into: "order" });
  const loop = await run(["merge", "orders", "payments"]);
  expect(loop.code).toBe(1);
  expect(text(loop)).toContain("payments");
  await run(["remove", "order flow"]);
  const toRemoved = await run(["merge", "orders", "order flow"]);
  expect(toRemoved.code).toBe(1);
});

test("remove hides a term and says which merged terms go with it", async () => {
  const { run, stored } = await world();
  await run(["merge", "payments", "orders"]);
  const removed = await run(["remove", "orders"]);
  expect(removed.code).toBe(0);
  expect(text(removed)).toContain("payments");
  expect(stored().corrections!.at(-1)).toMatchObject({ kind: "remove", term: "order" });
  expect(text(await run(["list"]))).toMatch(/removed/);
});

test("member corrects a pair by function name, path#name or full key, with yes or no", async () => {
  const { run, stored } = await world(true);
  expect((await run(["member", "chargeCard", "payments", "yes"])).code).toBe(0);
  expect(stored().corrections![0]).toMatchObject({ kind: "member", unit: "function:src/payments/stripe.ts#chargeCard", term: "payment", belongs: true });
  expect((await run(["member", "src/orders/place.ts#placeOrder", "orders", "no"])).code).toBe(0);
  expect(stored().corrections![1]).toMatchObject({ unit: "function:src/orders/place.ts#placeOrder", term: "order", belongs: false });
  expect((await run(["member", "function:src/misc/odd.ts#oddJob", "orders", "yes"])).code).toBe(0);
  const bad = await run(["member", "chargeCard", "payments", "maybe"]);
  expect(bad.code).toBe(2);
});

test("member says when a function name is ambiguous or unknown, and changes nothing", async () => {
  const { run, stored } = await world(true);
  const ambiguous = await run(["member", "placeOrder", "orders", "yes"]);
  expect(ambiguous.code).toBe(1);
  expect(text(ambiguous)).toContain("src/orders/cancel.ts");
  expect(text(ambiguous)).toContain("src/orders/place.ts");
  const unknown = await run(["member", "nothingLikeIt", "orders", "yes"]);
  expect(unknown.code).toBe(1);
  expect(text(unknown)).toContain("function:");
  expect(stored().corrections).toBeUndefined();
});

test("certify records who and when; list says so; any later correction makes it drafted again; certifying twice changes nothing", async () => {
  const { run, stored } = await world();
  expect(text(await run(["list"]))).toContain("drafted: nobody has certified it");
  await run(["confirm", "orders"]);
  const done = await run(["certify"]);
  expect(done.code).toBe(0);
  expect(stored().certification).toMatchObject({ by: "Ada Lovelace", at: "2026-11-11T10:01:00.000Z" });
  expect(text(await run(["list"]))).toContain("certified by Ada Lovelace at 2026-11-11T10:01:00.000Z");
  const before = JSON.stringify(stored());
  const again = await run(["certify"]);
  expect(again.code).toBe(0);
  expect(text(again)).toContain("already certified");
  expect(JSON.stringify(stored())).toBe(before);
  await run(["remove", "payments"]);
  expect(text(await run(["list"]))).toContain("drafted: corrections changed since Ada Lovelace certified it");
  await run(["certify", "--by", "Grace"]);
  expect(text(await run(["list"]))).toContain("certified by Grace");
});

test("a vocabulary whose terms are unknown cannot be certified", async () => {
  const { run, stored, file } = await world();
  const whole = stored();
  writeFileSync(file, JSON.stringify({ ...whole, vocabulary: { ...whole.vocabulary, status: "unknown", reason: "a file could not be read" } }));
  const refused = await run(["certify"]);
  expect(refused.code).toBe(1);
  expect(text(refused)).toContain("unknown");
  expect(stored().certification).toBeUndefined();
});

test("list shows every term with what was done to it, the corrections in order, and the ones that no longer apply", async () => {
  const { run } = await world(true);
  await run(["rename", "payments", "billing"]);
  await run(["confirm", "orders"]);
  await run(["member", "function:src/gone.ts#gone", "orders", "yes"]);
  await run(["remove", "order flow"]);
  const listed = text(await run(["list"]));
  expect(listed).toContain("billing");
  expect(listed).toContain("renamed from payments");
  expect(listed).toContain("confirmed by Ada Lovelace");
  expect(listed).toContain("corrections: 4, 1 no longer apply");
  expect(listed).toContain("no longer applies");
  expect(listed.indexOf("rename payments")).toBeLessThan(listed.indexOf("confirm orders"));
});

test("everything printed from the store is withheld when it is shaped like a secret", async () => {
  const { run, stored, file } = await world();
  const secret = `ghp_${"a1B2c3D4e5F6g7H8i9J0"}`;
  const whole = stored();
  writeFileSync(
    file,
    JSON.stringify({
      ...whole,
      vocabulary: { ...whole.vocabulary, terms: whole.vocabulary.terms.map((term, index) => (index === 0 ? { ...term, name: secret } : term)) },
      corrections: [{ kind: "confirm", term: whole.vocabulary.terms[0]!.key, label: secret, by: secret, at: "2026-11-11T10:00:00.000Z" }],
    }),
  );
  const listed = text(await run(["list"]));
  expect(listed).not.toContain(secret);
  expect(listed).toContain("withheld");
  const done = await run(["confirm", whole.vocabulary.terms[1]!.name]);
  expect(text(done)).not.toContain(secret);
});

test("a stored file that cannot be read is reported and left exactly as it was, whatever it holds", async () => {
  const { run, file, stored } = await world();
  await run(["confirm", "orders"]);
  const damaged = `${readFileSync(file, "utf8").slice(0, 150)}`;
  writeFileSync(file, damaged);
  for (const args of [["list"], ["confirm", "payments"], ["certify"], ["rename", "orders", "x"]]) {
    const result = await run(args);
    expect(result.code).toBe(1);
    expect(text(result)).toContain("could not be read");
    expect(text(result)).toContain("streets setup");
    expect(readFileSync(file, "utf8")).toBe(damaged);
  }
  void stored;
});

test("a write leaves no scratch file, and keeps every field another step added", async () => {
  const { run, file, stored } = await world();
  writeFileSync(file, JSON.stringify({ ...stored(), reviewerNotes: ["keep me"] }));
  await run(["confirm", "orders"]);
  expect(stored().reviewerNotes).toEqual(["keep me"]);
  expect(readdirSync(dirname(file)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});

test("the written store is read whole by setup's own reader", async () => {
  const { run, dir, cacheDir } = await world();
  await run(["rename", "payments", "billing"]);
  await run(["member", "function:src/misc/odd.ts#oddJob", "orders", "no"]);
  await run(["certify"]);
  expect((await readVocabulary(dir, cacheDir)).kind).toBe("ok");
});
