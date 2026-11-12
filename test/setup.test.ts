import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, expect, test, vi } from "vitest";
import { extract } from "../src/extract/extract.ts";
import { reportLines, setUp, vocabularyNotice } from "../src/setup.ts";
import type { SetupResult } from "../src/setup.ts";
import { collectVocabulary, keyOf, VOCABULARY_TABLE_VERSION } from "../src/vocabulary.ts";

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
function write(dir: string, path: string, text: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}
function commit(dir: string, files: Record<string, string>, message = "change"): string {
  for (const [path, text] of Object.entries(files)) write(dir, path, text);
  git(dir, "add", "--all");
  git(dir, "commit", "--quiet", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}
function repo(files: Record<string, string>): string {
  const dir = temp("streets-setup-");
  git(dir, "init", "--quiet", "--initial-branch=main");
  commit(dir, files, "base");
  return dir;
}

const files = {
  "package.json": '{\n  "description": "Checkout service for the shop"\n}\n',
  "docs/guide.md": "# Order flow\n\ntext\n\n## Payment providers\n\ntext\n",
  "src/payments/stripe.ts": "export function chargeCard(amount: number): void {}\n",
  "src/orders/place.ts": "export function placeOrder(): void {}\n",
};

function counting() {
  const collect = vi.fn(collectVocabulary);
  const graphOf = vi.fn(extract);
  return { collect, graphOf, deps: { collect, graphOf } };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

const keyOfTerm = (result: SetupResult): string[] => result.stored.vocabulary.terms.map((term) => term.key);

test("the first setup stores the vocabulary in the cache, outside the repository, and leaves the repository alone", async () => {
  const dir = repo(files);
  const cacheDir = temp("streets-cache-");
  const result = await setUp({ dir, cacheDir });
  expect(result.work).toBe("first setup");
  expect(result.file.startsWith(join(cacheDir, "vocabulary"))).toBe(true);
  expect(existsSync(result.file)).toBe(true);
  const stored = JSON.parse(readFileSync(result.file, "utf8"));
  expect(stored).toMatchObject({ format: 1, tier: "derived", base: { ref: "main", commit: git(dir, "rev-parse", "HEAD") }, vocabulary: { status: "found", tableVersion: VOCABULARY_TABLE_VERSION } });
  expect(stored.vocabulary.terms.length).toBeGreaterThan(3);
  expect(stored.files["src/orders/place.ts"]).toMatch(/^[0-9a-f]{32}$/);
  // Nothing is written into the repository: no new file, and no change git can see.
  expect(git(dir, "status", "--porcelain", "--ignored")).toBe("");
  expect(readdirSync(dir).sort()).toEqual([".git", "docs", "package.json", "src"]);
});

test("a second setup with nothing changed builds no graph, collects nothing and writes nothing", async () => {
  const dir = repo(files);
  const cacheDir = temp("streets-cache-");
  const first = await setUp({ dir, cacheDir });
  const before = statSync(first.file).mtimeMs;
  const bytes = readFileSync(first.file, "utf8");
  const spy = counting();
  const second = await setUp({ dir, cacheDir, deps: spy.deps });
  expect(second.work).toBe("unchanged");
  expect(spy.collect).not.toHaveBeenCalled();
  expect(spy.graphOf).not.toHaveBeenCalled();
  expect(statSync(first.file).mtimeMs).toBe(before);
  expect(readFileSync(first.file, "utf8")).toBe(bytes);
  expect(second.stored).toEqual(first.stored);
});

test("an edited, an added and a removed file are redone and counted", async () => {
  const dir = repo(files);
  const cacheDir = temp("streets-cache-");
  const first = await setUp({ dir, cacheDir });
  commit(dir, { "src/orders/place.ts": "export function placeOrder(): void {}\nexport function cancelOrder(): void {}\n", "src/shipping/label.ts": "export function printLabel(): void {}\n" });
  git(dir, "rm", "--quiet", "src/payments/stripe.ts");
  git(dir, "commit", "--quiet", "-m", "remove");
  const spy = counting();
  const second = await setUp({ dir, cacheDir, deps: spy.deps });
  expect(second.work).toBe("rebuilt");
  expect(second.files).toEqual({ added: 1, changed: 1, removed: 1 });
  expect(spy.collect).toHaveBeenCalledTimes(1);
  expect(keyOfTerm(second)).toContain(keyOf("cancel order"));
  expect(keyOfTerm(second)).toContain(keyOf("shipping"));
  expect(keyOfTerm(second)).not.toContain(keyOf("charge card"));
  expect(keyOfTerm(first)).toContain(keyOf("charge card"));
  expect(second.stored.base.commit).toBe(git(dir, "rev-parse", "HEAD"));
});

test("a changed table version redoes everything even when no file changed", async () => {
  const dir = repo(files);
  const cacheDir = temp("streets-cache-");
  const first = await setUp({ dir, cacheDir });
  const stored = JSON.parse(readFileSync(first.file, "utf8"));
  stored.vocabulary.tableVersion = VOCABULARY_TABLE_VERSION - 1;
  writeFileSync(first.file, JSON.stringify(stored));
  const spy = counting();
  const second = await setUp({ dir, cacheDir, deps: spy.deps });
  expect(second.work).toBe("rules changed");
  expect(second.why).toContain(`from version ${VOCABULARY_TABLE_VERSION - 1} to ${VOCABULARY_TABLE_VERSION}`);
  expect(spy.collect).toHaveBeenCalledTimes(1);
  expect(JSON.parse(readFileSync(first.file, "utf8")).vocabulary.tableVersion).toBe(VOCABULARY_TABLE_VERSION);
  expect(reportLines(second).join("\n")).toContain(`version ${VOCABULARY_TABLE_VERSION - 1}`);
});

test("a stored file that cannot be read is replaced, and the report says so", async () => {
  const dir = repo(files);
  const cacheDir = temp("streets-cache-");
  const first = await setUp({ dir, cacheDir });
  writeFileSync(first.file, "{ not json");
  const second = await setUp({ dir, cacheDir });
  expect(second.work).toBe("replaced unreadable");
  expect(JSON.parse(readFileSync(first.file, "utf8")).vocabulary.status).toBe("found");
  expect(reportLines(second).join("\n")).toMatch(/could not be read/);
});

test("fields another step added to the stored file survive a rebuild", async () => {
  const dir = repo(files);
  const cacheDir = temp("streets-cache-");
  const first = await setUp({ dir, cacheDir });
  const stored = JSON.parse(readFileSync(first.file, "utf8"));
  stored.corrections = [{ term: "order flow", rename: "ordering" }];
  writeFileSync(first.file, JSON.stringify(stored));
  commit(dir, { "src/orders/cancel.ts": "export function cancelOrder(): void {}\n" });
  const second = await setUp({ dir, cacheDir });
  expect(second.work).toBe("rebuilt");
  expect(JSON.parse(readFileSync(first.file, "utf8")).corrections).toEqual([{ term: "order flow", rename: "ordering" }]);
});

test("the default base is the tip of the main branch, not the point a feature branch left it", async () => {
  const dir = repo(files);
  git(dir, "checkout", "--quiet", "-b", "feature");
  git(dir, "checkout", "--quiet", "main");
  const tip = commit(dir, { "src/shipping/label.ts": "export function printLabel(): void {}\n" });
  git(dir, "checkout", "--quiet", "feature");
  const cacheDir = temp("streets-cache-");
  const result = await setUp({ dir, cacheDir });
  expect(result.ref).toBe("main");
  expect(result.stored.base.commit).toBe(tip);
  expect(keyOfTerm(result)).toContain(keyOf("shipping"));
  const other = await setUp({ dir, cacheDir, ref: "feature" });
  expect(other.ref).toBe("feature");
  expect(keyOfTerm(other)).not.toContain(keyOf("shipping"));
});

test("the base is read from the commit: edits in the working tree and untracked files do not count", async () => {
  const dir = repo(files);
  write(dir, "src/orders/place.ts", "export function wrecked(): void {}\n");
  write(dir, "src/untracked.ts", "export const untrackedThing = 1;\n");
  const result = await setUp({ dir, cacheDir: temp("streets-cache-") });
  expect(keyOfTerm(result)).toContain(keyOf("place order"));
  expect(keyOfTerm(result)).not.toContain(keyOf("untracked thing"));
});

test("a repository of another shape and name gets its own file; nothing in the store names one repository", async () => {
  const cacheDir = temp("streets-cache-");
  const a = await setUp({ dir: repo(files), cacheDir });
  const b = await setUp({ dir: repo({ "README.md": "# Tinyparse\n\n## Config files\n\ntext\n", "lib/parser.ts": "export class ConfigParser {}\n" }), cacheDir });
  expect(a.file).not.toBe(b.file);
  expect(readdirSync(join(cacheDir, "vocabulary"))).toHaveLength(2);
  expect(keyOfTerm(b)).toContain(keyOf("config file"));
  expect(keyOfTerm(b)).not.toContain(keyOf("charge card"));
});

test("a repository with no terms says none; one it could not fully read says unknown, never zero terms", async () => {
  const cacheDir = temp("streets-cache-");
  const none = await setUp({ dir: repo({ LICENSE: "MIT\n", "notes.txt": "x\n" }), cacheDir });
  expect(none.stored.vocabulary.status).toBe("none");
  expect(reportLines(none).join("\n")).toMatch(/no terms: everything was read/);
  const unknown = await setUp({ dir: repo({ "main.py": "def run():\n    pass\n" }), cacheDir });
  expect(unknown.stored.vocabulary.status).toBe("unknown");
  const text = reportLines(unknown).join("\n");
  expect(text).toMatch(/terms: unknown/);
  expect(text).toMatch(/not none and not zero/);
  expect(text).toMatch(/1 text file is in a language no adapter reads/);
  expect(text).not.toMatch(/\b0 terms\b/);
  expect(text).not.toMatch(/no terms/);
  expect(JSON.parse(readFileSync(unknown.file, "utf8")).vocabulary.status).toBe("unknown");
});

test("the report gives counts, what was dropped, skipped, unread and not analysed, and coverage as not yet measured", async () => {
  const dir = repo({
    ...files,
    "src/utils/helper.ts": "export function utils(): void {}\n",
    "tools/run.py": "def run():\n    pass\n",
    "docs/broken.ts": "export function (((\n",
  });
  const result = await setUp({ dir, cacheDir: temp("streets-cache-") });
  const text = reportLines(result).join("\n");
  const vocabulary = result.stored.vocabulary;
  expect(text).toContain(`terms: ${vocabulary.terms.length}`);
  expect(text).toMatch(/dropped: \d+/);
  expect(text).toMatch(/skipped: .*too long/);
  expect(text).toMatch(/unread: 1/);
  expect(text).toContain("docs/broken.ts");
  expect(text).toMatch(/not analysed: 1/);
  expect(text).toMatch(/coverage: 0 of \d+ analysed files map to a term/);
  expect(text).toMatch(/memberships/);
  expect(text).toContain(result.file);
});

test("secret-shaped text never reaches the stored file: not as a term and not in a path", async () => {
  const secret = "ghp_1234567890abcdefABCDEF1234567890abcd";
  const dir = repo({
    ...files,
    [`src/${secret}.ts`]: "export function chargeToken(): void {}\n",
    "src/keys.ts": `export const ${secret} = 1;\n`,
    [`docs/${secret}.md`]: "# Token handling\n",
  });
  const result = await setUp({ dir, cacheDir: temp("streets-cache-") });
  const raw = readFileSync(result.file, "utf8");
  expect(raw).not.toContain(secret);
  expect(raw).not.toContain("1234567890abcdef");
  expect(keyOfTerm(result)).toContain(keyOf("charge token"));
  expect(result.stored.pathsWithheld).toBeGreaterThan(0);
  // A second run still finds nothing changed: the withheld path is keyed stably.
  const spy = counting();
  expect((await setUp({ dir, cacheDir: dirname(dirname(result.file)), deps: spy.deps })).work).toBe("unchanged");
  expect(reportLines(result).join("\n")).toMatch(/paths withheld/);
});

test("the stored file never holds the TypeSafe key, whatever the environment says", async () => {
  vi.stubEnv("TYPESAFE_API_KEY", "ts_live_0123456789abcdef0123456789abcdef");
  try {
    const result = await setUp({ dir: repo(files), cacheDir: temp("streets-cache-") });
    expect(readFileSync(result.file, "utf8")).not.toContain("0123456789abcdef");
    expect(reportLines(result).join("\n")).not.toContain("0123456789abcdef");
  } finally {
    vi.unstubAllEnvs();
  }
});

test("a directory that is no repository, or a base that is no commit, is an error and stores nothing", async () => {
  const cacheDir = temp("streets-cache-");
  await expect(setUp({ dir: temp("streets-plain-"), cacheDir })).rejects.toThrow(/not a git repository/);
  await expect(setUp({ dir: repo(files), cacheDir, ref: "nonesuch" })).rejects.toThrow(/unknown base "nonesuch"/);
  expect(existsSync(join(cacheDir, "vocabulary"))).toBe(false);
});

test("setup never runs a program the repository names: a smudge filter does not run", async () => {
  const dir = temp("streets-filter-");
  const marker = join(temp("streets-marker-"), "ran");
  git(dir, "init", "--quiet", "--initial-branch=main");
  git(dir, "config", "filter.run.clean", "cat");
  git(dir, "config", "filter.run.smudge", `touch ${marker}; cat`);
  git(dir, "config", "core.attributesFile", "/dev/null");
  commit(dir, { ...files, ".gitattributes": "*.ts filter=run\n" });
  rmSync(marker, { force: true });
  const result = await setUp({ dir, cacheDir: temp("streets-cache-") });
  expect(existsSync(marker)).toBe(false);
  expect(keyOfTerm(result)).toContain(keyOf("place order"));
  expect(result.stored.vocabulary.status).toBe("found");
});

test("files are read as git stores them: a Windows line ending stays one", async () => {
  const result = await setUp({ dir: repo({ ...files, "docs/crlf.md": "# Return policy\r\n\r\ntext\r\n" }), cacheDir: temp("streets-cache-") });
  const term = result.stored.vocabulary.terms.find((one) => one.key === keyOf("return policy"));
  expect(term?.pins[0]).toMatchObject({ path: "docs/crlf.md", range: { start: 1, end: 1 } });
});

test.each([
  ["dropped", (v: Loose) => delete v.vocabulary.dropped],
  ["skipped", (v: Loose) => delete v.vocabulary.skipped.tooLong],
  ["unread", (v: Loose) => (v.vocabulary.unread = [{ path: "a" }])],
  ["notAnalysed", (v: Loose) => (v.vocabulary.notAnalysed = "3")],
  ["a pin without its text", (v: Loose) => delete v.vocabulary.terms[0].pins[0].written],
  ["a pin's range", (v: Loose) => (v.vocabulary.terms[0].pins[0].range = { start: 1 })],
  ["a term's spellings", (v: Loose) => (v.vocabulary.terms[0].spellings = "x")],
  ["a dropped term", (v: Loose) => (v.vocabulary.dropped.terms = [{ key: 1 }])],
  ["unknown's reason", (v: Loose) => (v.vocabulary.reason = 5)],
  ["coverage", (v: Loose) => delete v.coverage.of],
  ["the repository name", (v: Loose) => delete v.repo],
  ["a file digest", (v: Loose) => (v.files["package.json"] = 7)],
])("a stored record missing %s is replaced, never trusted, and the report does not throw", async (_name, damage) => {
  const dir = repo(files);
  const cacheDir = temp("streets-cache-");
  const first = await setUp({ dir, cacheDir });
  const stored = JSON.parse(readFileSync(first.file, "utf8"));
  damage(stored);
  writeFileSync(first.file, JSON.stringify(stored));
  expect(await vocabularyNotice(dir, cacheDir)).toMatch(/could not be read/);
  const second = await setUp({ dir, cacheDir });
  expect(second.work).toBe("replaced unreadable");
  expect(() => reportLines(second)).not.toThrow();
  expect(reportLines(second).join("\n")).toMatch(/could not be read/);
  const third = await setUp({ dir, cacheDir });
  expect(third.work).toBe("unchanged");
  expect(() => reportLines(third)).not.toThrow();
});

test("paths named like properties of an object are digested and counted: __proto__, constructor, toString", async () => {
  const dir = repo({ ...files, ["__proto__"]: "one\n", constructor: "two\n", toString: "three\n" });
  const cacheDir = temp("streets-cache-");
  const first = await setUp({ dir, cacheDir });
  const stored = JSON.parse(readFileSync(first.file, "utf8"));
  for (const name of ["__proto__", "constructor", "toString"]) expect(Object.hasOwn(stored.files, name)).toBe(true);
  expect((await setUp({ dir, cacheDir })).work).toBe("unchanged");
  git(dir, "rm", "--quiet", "constructor");
  commit(dir, { ["__proto__"]: "one, edited\n", "src/new.ts": "export const fresh = 1;\n" });
  const second = await setUp({ dir, cacheDir });
  expect(second.files).toEqual({ added: 1, changed: 1, removed: 1 });
  expect(Object.keys(JSON.parse(readFileSync(first.file, "utf8")).files)).toContain("__proto__");
});

test("a repository name or a base shaped like a secret is not stored, printed or used as the file name", async () => {
  const secret = "ghp_1234567890abcdefABCDEF1234567890abcd";
  const dir = join(temp("streets-parent-"), secret);
  mkdirSync(dir);
  git(dir, "init", "--quiet", "--initial-branch=main");
  commit(dir, files);
  git(dir, "branch", `feature/${secret}`);
  const cacheDir = temp("streets-cache-");
  const result = await setUp({ dir, cacheDir, ref: `feature/${secret}` });
  expect(readdirSync(join(cacheDir, "vocabulary")).join()).not.toContain("ghp_");
  expect(readdirSync(join(cacheDir, "vocabulary"))).toHaveLength(1);
  const raw = readFileSync(result.file, "utf8");
  expect(raw).not.toContain("1234567890abcdef");
  expect(reportLines(result).join("\n")).not.toContain("1234567890abcdef");
  expect(result.stored.repo).toMatch(/^withheld/);
  expect(result.stored.base.ref).toMatch(/^withheld/);
  expect((await setUp({ dir, cacheDir, ref: `feature/${secret}` })).work).toBe("unchanged");
  await expect(setUp({ dir, cacheDir, ref: `nope/${secret}` })).rejects.toThrow(/unknown base "withheld:[0-9a-f]+"/);
});

test("compare's notice says older rules for an older extractor too", async () => {
  const dir = repo(files);
  const cacheDir = temp("streets-cache-");
  const result = await setUp({ dir, cacheDir });
  const stored = JSON.parse(readFileSync(result.file, "utf8"));
  stored.extractorVersion = "0";
  writeFileSync(result.file, JSON.stringify(stored));
  expect(await vocabularyNotice(dir, cacheDir)).toMatch(/older rules.*extractor.*streets setup/);
  stored.extractorVersion = "99999";
  writeFileSync(result.file, JSON.stringify(stored));
  expect(await vocabularyNotice(dir, cacheDir)).toMatch(/newer rules.*extractor.*streets setup/);
});

test("compare's notice says the vocabulary is missing, then says nothing once setup has run, and flags an old table", async () => {
  const dir = repo(files);
  const cacheDir = temp("streets-cache-");
  expect(await vocabularyNotice(dir, cacheDir)).toMatch(/no vocabulary for this repository.*streets setup/);
  const result = await setUp({ dir, cacheDir });
  expect(await vocabularyNotice(dir, cacheDir)).toBeUndefined();
  const stored = JSON.parse(readFileSync(result.file, "utf8"));
  stored.vocabulary.tableVersion = 1;
  writeFileSync(result.file, JSON.stringify(stored));
  expect(await vocabularyNotice(dir, cacheDir)).toMatch(/older rules.*streets setup/);
  writeFileSync(result.file, "garbage");
  expect(await vocabularyNotice(dir, cacheDir)).toMatch(/could not be read.*streets setup/);
});
