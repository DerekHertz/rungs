import { expect, test } from "vitest";
import { extract } from "../src/extract/extract.ts";
import type { FileTree } from "../src/graph.ts";
import { GENERIC_PHRASES, GENERIC_WORDS, VOCABULARY_TABLE_VERSION } from "../src/vocabulary-table.ts";
import { collectVocabulary, keyOf, stem, wordsOf } from "../src/vocabulary.ts";
import type { Term, Vocabulary } from "../src/vocabulary.ts";

const tree = (files: Record<string, string>): FileTree => new Map(Object.entries(files));
const baseOf = (files: Record<string, string>) => {
  const t = tree(files);
  return { graph: extract(t), tree: t };
};
const lines = (...rows: string[]): string => rows.join("\n") + "\n";
const termOf = (vocabulary: Vocabulary, phrase: string): Term => {
  const key = keyOf(phrase);
  const found = vocabulary.terms.find((term) => term.key === key);
  if (found === undefined) throw new Error(`no term "${key}" among ${vocabulary.terms.map((term) => term.key).join(", ")}`);
  return found;
};
const keys = (vocabulary: Vocabulary): string[] => vocabulary.terms.map((term) => term.key);
/** What `keys` gives for these phrases, in order: keys are stems, so tests write phrases and compare through keyOf. */
const want = (...phrases: string[]): string[] => phrases.map(keyOf).sort();

// Fixture 1: a small library. One package, a README, a few modules, one test file, a generic folder.
const library = {
  "package.json": lines("{", '  "name": "tinyparse",', '  "description": "Parse small config files, with friendly error messages",', '  "version": "1.0.0"', "}"),
  "README.md": lines("# Tinyparse", "", "Reads config.", "", "## Config files", "text", "", "## Error messages", "text", "", "## License", "MIT"),
  "src/parser/index.ts": lines("export function parseConfig(text: string): object {", "  return {};", "}", "export const MAX_DEPTH = 8;"),
  "src/utils/strings.ts": lines("export function trimLines(text: string): string {", "  return text;", "}"),
  "src/errors.ts": lines("export class ParseError extends Error {}", "export interface ParseOptions {", "  strict: boolean;", "}"),
  "test/parser.test.ts": lines(
    'import { describe, it } from "vitest";',
    'describe("parser", () => {',
    '  it("reads a config file", () => {});',
    "  it(",
    '    "reports the line of an error message when the input is malformed",',
    "    () => {},",
    "  );",
    "});",
  ),
};

// Fixture 2: an app with docs. Different shape: nested docs, kebab-case folders, a vendored folder,
// a tooling folder, a binary doc, and the same concept written four ways.
const app = {
  "package.json": lines("{", '  "description": "Checkout service for the shop"', "}"),
  "docs/architecture.md": lines("# Architecture", "", "## Order flow", "How an order moves.", "", "## Payment providers", "Stripe."),
  "docs/glossary.md": lines("Glossary", "========", "", "text", "", "Order flows", "-----------", "text"),
  "src/order-flows/place.ts": lines("export async function orderFlow(", "  id: string,", "): Promise<void> {}"),
  "src/payments/stripe.ts": lines("export function chargeCard(amount: number): void {}"),
  "src/utils/index.ts": lines("export const x = 1;"),
  "test/orders.test.ts": lines(
    'import { describe, it, test } from "vitest";',
    'describe("order flow", () => {',
    '  it("charges the card", () => {});',
    '  test("sk-live_9f8e7d6c5b4a39281706", () => {});',
    "});",
  ),
  "vendor/lib/thing.js": "export function vendoredThing() {}\n",
  ".github/workflows/ci.yml": "name: ci\n",
  "docs/logo.md": "PNG\u0000\u0001data\n",
};

test("a small library yields its headings, folders, exports, tests and description as terms, each pinned", () => {
  const vocabulary = collectVocabulary(baseOf(library));
  expect(vocabulary.status).toBe("found");
  expect(vocabulary.tableVersion).toBe(VOCABULARY_TABLE_VERSION);
  expect(keys(vocabulary)).toEqual(want(
    "config file",
    "error message",
    "friendly error message",
    "max depth",
    "parse config",
    "parse error",
    "parse option",
    "parse small config file",
    "parser",
    "read a config file",
    "tinyparse",
    "trim line",
  ));
  // Headings pin to their heading line, folders to their path (they have no lines).
  expect(termOf(vocabulary, "config file").pins).toEqual([
    { source: "heading", path: "README.md", range: { start: 5, end: 5 }, written: "Config files" },
  ]);
  expect(termOf(vocabulary, "parser").pins).toEqual([
    { source: "folder", path: "src/parser", range: null, written: "parser" },
    { source: "test", path: "test/parser.test.ts", range: { start: 2, end: 2 }, written: "parser" },
  ]);
  // An export pins to the line of its declaration, a type to the line the text shows it on.
  expect(termOf(vocabulary, "parse config").pins).toEqual([{ source: "export", path: "src/parser/index.ts", range: { start: 1, end: 1 }, written: "parseConfig" }]);
  expect(termOf(vocabulary, "max depth").pins[0]).toMatchObject({ source: "export", range: { start: 4, end: 4 }, written: "MAX_DEPTH" });
  expect(termOf(vocabulary, "parse option").pins[0]).toMatchObject({ path: "src/errors.ts", range: { start: 2, end: 2 } });
  // A test title wrapped onto its own line is pinned there, not to the callback's line.
  expect(termOf(vocabulary, "read a config file").pins).toEqual([{ source: "test", path: "test/parser.test.ts", range: { start: 3, end: 3 }, written: "reads a config file" }]);
  // The description is prose: cut at stop words and punctuation, and pinned to its line in package.json.
  expect(termOf(vocabulary, "parse small config file").pins).toEqual([{ source: "package description", path: "package.json", range: { start: 3, end: 3 }, written: "Parse small config files" }]);
  expect(termOf(vocabulary, "friendly error message").pins[0]).toMatchObject({ source: "package description", range: { start: 3, end: 3 } });
  // Nothing hard to read, so nothing is listed as unread.
  expect(vocabulary.unread).toEqual([]);
  expect(vocabulary.notAnalysed).toBe(0);
});

test("a term most repositories would match is dropped by the written rule, and the drop is counted and named", () => {
  const vocabulary = collectVocabulary(baseOf(library));
  // "license" (a heading), "src", "test" and "utils" (folders) are generic; the library's own words stay.
  expect(vocabulary.dropped).toEqual({
    count: 4,
    terms: [
      { key: keyOf("license"), name: "License", rule: "generic" },
      { key: "src", name: "src", rule: "generic" },
      { key: "test", name: "test", rule: "generic" },
      { key: keyOf("utils"), name: "utils", rule: "generic" },
    ],
  });
  expect(keys(vocabulary)).not.toContain(keyOf("utils"));
  // The app's "utils" folder is dropped too, and its one-letter constant "x" as too short to mean anything.
  const more = collectVocabulary(baseOf(app));
  expect(more.dropped.terms).toEqual(expect.arrayContaining([{ key: keyOf("utils"), name: "utils", rule: "generic" }, { key: "x", name: "x", rule: "short" }]));
  expect(more.dropped.count).toBe(more.dropped.terms.length);
});

test("the same concept written four ways is one term, with every spelling and every place it was written", () => {
  const vocabulary = collectVocabulary(baseOf(app));
  const flow = termOf(vocabulary, "order flow");
  expect(flow.spellings).toEqual(["Order flow", "Order flows", "orderFlow", "order flow", "order-flows"].sort());
  expect(flow.pins.map((pin) => [pin.source, pin.path, pin.range])).toEqual([
    ["heading", "docs/architecture.md", { start: 3, end: 3 }],
    // A heading underlined with dashes is two lines.
    ["heading", "docs/glossary.md", { start: 6, end: 7 }],
    ["folder", "src/order-flows", null],
    ["export", "src/order-flows/place.ts", { start: 1, end: 1 }],
    ["test", "test/orders.test.ts", { start: 2, end: 2 }],
  ]);
  // Each spelling's count decides the display name; a tie goes to the first in sorted order.
  expect(flow.name).toBe("Order flow");
  expect(keys(vocabulary).filter((key) => key.includes("flow"))).toEqual(want("order flow"));
});

test("an app with docs: nested docs, kebab-case folders and exports are read; vendored, hidden and generic things are counted, not read", () => {
  const vocabulary = collectVocabulary(baseOf(app));
  expect(keys(vocabulary)).toEqual(expect.arrayContaining(want("architecture", "payment provider", "payment", "charge card", "glossary", "checkout service", "shop")));
  // The vendored folder and file and the hidden tooling folder give no term.
  expect(keys(vocabulary).some((key) => key.includes("vendor") || key.includes("github") || key.includes("workflow"))).toBe(false);
  expect(vocabulary.skipped.generated).toBeGreaterThanOrEqual(2);
  expect(vocabulary.skipped.hiddenFolders).toBe(2);
});

test("a secret-shaped test title never becomes a term, and is counted as withheld", () => {
  const vocabulary = collectVocabulary(baseOf(app));
  expect(vocabulary.skipped.withheld).toBe(1);
  const everything = JSON.stringify(vocabulary);
  expect(everything).not.toContain("9f8e7d6c5b4a39281706");
  expect(everything).not.toContain("sk-live");
  // A secret-shaped heading, export name and package description are withheld the same way.
  const other = collectVocabulary(
    baseOf({
      "package.json": JSON.stringify({ description: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" }),
      "NOTES.md": "# AKIAABCDEFGHIJKLMNOP\ntext\n",
      "src/a.ts": "export const ghp_abcdefghijklmnopqrstuvwxyz0123456789 = 1;\nexport function real() {}\n",
    }),
  );
  expect(keys(other)).toEqual(want("real"));
  expect(other.skipped.withheld).toBe(3);
});

test("a phrase too long to be a term is skipped and counted, never cut", () => {
  const vocabulary = collectVocabulary(baseOf(library));
  // The wrapped test title has more than five words.
  expect(vocabulary.skipped.tooLong).toBe(1);
  expect(keys(vocabulary).some((key) => key.includes("malformed"))).toBe(false);
});

test("a file that cannot be read is listed, and a vocabulary of nothing but that is unknown, never none", () => {
  const withBinary = collectVocabulary(baseOf(app));
  expect(withBinary.status).toBe("found");
  expect(withBinary.unread).toEqual([{ path: "docs/logo.md", reason: "binary" }]);

  const onlyUnread = collectVocabulary(baseOf({ "NOTES.md": "# A\u0000\u0001 binary\n" }));
  expect(onlyUnread).toMatchObject({ status: "unknown", terms: [], unread: [{ path: "NOTES.md", reason: "binary" }] });
  expect(onlyUnread.reason).toMatch(/NOTES\.md/);

  // A file with syntax errors has no code nodes: its names are unknown.
  const broken = collectVocabulary(baseOf({ "src/a.ts": "export function (((\n" }));
  expect(broken).toMatchObject({ status: "unknown", unread: [{ path: "src/a.ts", reason: "not fully read" }] });

  // A language no adapter reads is counted, so an empty list there is not "none".
  const python = collectVocabulary(baseOf({ "tool.py": "print(1)\n" }));
  expect(python).toMatchObject({ status: "unknown", terms: [], notAnalysed: 1 });

  // A manifest that is not JSON, and a Markdown file the graph never saw.
  expect(collectVocabulary(baseOf({ "package.json": "{not json" })).unread).toEqual([{ path: "package.json", reason: "not a JSON object" }]);
  const t = tree({ "A.md": "# A\n", "B.md": "# B thing\n" });
  expect(collectVocabulary({ graph: extract(tree({ "A.md": "# A\n" })), tree: t }).unread).toEqual([{ path: "B.md", reason: "missing from the graph" }]);
  expect(collectVocabulary({ graph: extract(t), tree: tree({ "A.md": "# A\n" }) }).unread).toEqual([{ path: "B.md", reason: "missing from the tree" }]);
});

test("no base is unknown; a repository that wrote no term, with everything read, is none", () => {
  expect(collectVocabulary(undefined)).toMatchObject({ status: "unknown", terms: [], reason: expect.stringMatching(/base/) });
  const bare = collectVocabulary(baseOf({ "README.md": "# Readme\n", "src/index.ts": "export const ab = 1;\n" }));
  expect(bare).toMatchObject({ status: "none", terms: [], unread: [], notAnalysed: 0 });
  // The words it wrote were dropped and counted: "readme" and "src" are generic, "ab" is too short.
  expect(bare.dropped.terms.map((one) => one.key)).toEqual(want("ab", "readme", "src"));
});

test("the collector is pure: same input, same output; the input is untouched; the output is plain data", () => {
  const input = baseOf(app);
  const before = JSON.stringify([...input.tree]);
  const first = collectVocabulary(input);
  expect(collectVocabulary(input)).toEqual(first);
  expect(JSON.stringify([...input.tree])).toBe(before);
  expect(JSON.parse(JSON.stringify(first))).toEqual(first);
  // Terms are sorted by key, pins by path and line.
  expect(keys(first)).toEqual([...keys(first)].sort());
});

test("stop words at either end are not part of a name, so a heading and an export of it merge", () => {
  const vocabulary = collectVocabulary(baseOf({ "A.md": "# The sandbox\n\n## How it works\n", "src/a.ts": "export function sandboxOf() {}\nexport function isTheSandbox() {}\n" }));
  expect(keys(vocabulary)).toEqual(want("sandbox", "work"));
  expect(termOf(vocabulary, "sandbox").pins.map((pin) => pin.written)).toEqual(["The sandbox", "sandboxOf", "isTheSandbox"]);
  // A name made only of stop words is not a word.
  expect(collectVocabulary(baseOf({ "A.md": "# What is it\n" })).skipped.notAWord).toBe(1);
});

test("names that are keys of Object.prototype are ordinary terms", () => {
  const vocabulary = collectVocabulary(baseOf({ "A.md": "# constructor\n\n## __proto__\n\n## toString\n" }));
  expect(keys(vocabulary)).toEqual(want("constructor", "proto", "string"));
});

test("words: case and separators give one spelling; the table's lists are plain lower-case words", () => {
  expect(wordsOf("reviewRounds")).toEqual(["review", "rounds"]);
  expect(wordsOf("REVIEW_ROUNDS")).toEqual(["review", "rounds"]);
  expect(wordsOf("review-rounds")).toEqual(["review", "rounds"]);
  expect(wordsOf("HTMLParser")).toEqual(["html", "parser"]);
  expect(wordsOf("sha256Digest")).toEqual(["sha", "256", "digest"]);
  expect(wordsOf("doesn't")).toEqual(["doesnt"]);
  for (const word of GENERIC_WORDS) expect(word).toMatch(/^[a-z]+$/);
  for (const phrase of GENERIC_PHRASES) expect(phrase).toMatch(/^[a-z]+(?: [a-z]+)+$/);
});

test("a package.json that starts with a byte order mark still gives its description", () => {
  const vocabulary = collectVocabulary(baseOf({ "package.json": '﻿{"description": "Lint changelogs"}\n' }));
  expect(termOf(vocabulary, "lint changelog").pins[0]).toMatchObject({ source: "package description", range: { start: 1, end: 1 } });
  expect(vocabulary.unread).toEqual([]);
});

// Round 1 of the Codex review of PR 276.

test("a file that could hold words and was not read is counted, so no term is never a false none", () => {
  // A binary file with a code name, and a test file in a language no adapter reads.
  expect(collectVocabulary(baseOf({ "a.ts": "\0export function billing() {}" }))).toMatchObject({ status: "unknown", terms: [], unread: [{ path: "a.ts", reason: "binary" }] });
  expect(collectVocabulary(baseOf({ "tests/billing.py": "def test_billing(): pass\n" }))).toMatchObject({ status: "unknown", terms: [], notAnalysed: 1 });
  // A media file and a data file hold no code, so they do not make a repository unknown.
  expect(collectVocabulary(baseOf({ "logo.png": "\0PNG", "rows.json": "[]\n" }))).toMatchObject({ status: "none", unread: [], notAnalysed: 0 });
  expect(collectVocabulary(baseOf({ "test/fixtures/rows.json": "[]\n", "test/notes.md": "# Billing\n" })).notAnalysed).toBe(0);
});

test("an export alias is pinned to the line that writes it, and to no line when none does", () => {
  const vocabulary = collectVocabulary(baseOf({ "a.ts": lines("export function local() {}", "export {", "  local as Invoice,", "};") }));
  expect(termOf(vocabulary, "local").pins[0]!.range).toEqual({ start: 1, end: 1 });
  expect(termOf(vocabulary, "invoice").pins).toEqual([{ source: "export", path: "a.ts", range: { start: 3, end: 3 }, written: "Invoice" }]);
  // A name the text never shows is not given a line.
  const hidden = collectVocabulary({ graph: extract(tree({ "a.ts": "function local() {}\nexport { local as Invoice };\n" })), tree: tree({ "a.ts": "function local() {}\nexport { local };\n" }) });
  expect(termOf(hidden, "invoice").pins[0]!.range).toBeNull();
});

test("a re-exported name is a term, pinned to its re-export line", () => {
  const vocabulary = collectVocabulary(baseOf({ "a.ts": lines('import "./x";', 'export { local as Invoice } from "./b";', 'export * as Ledger from "./c";', 'export { default } from "./d";'), "b.ts": "export function local() {}\n" }));
  expect(termOf(vocabulary, "invoice").pins).toEqual([{ source: "export", path: "a.ts", range: { start: 2, end: 2 }, written: "Invoice" }]);
  expect(termOf(vocabulary, "ledger").pins[0]).toMatchObject({ path: "a.ts", range: { start: 3, end: 3 } });
  expect(keys(vocabulary)).not.toContain("default");
});

test("a folder that holds a package.json is a package, and its directory name is still a folder term", () => {
  const vocabulary = collectVocabulary(baseOf({ "billing/package.json": '{"name": "b"}\n', "packages/ledger/package.json": "{}\n" }));
  expect(termOf(vocabulary, "billing").pins).toEqual([{ source: "folder", path: "billing", range: null, written: "billing" }]);
  expect(termOf(vocabulary, "ledger").pins[0]).toMatchObject({ source: "folder", path: "packages/ledger" });
});

test("a test title in a wrapped call is pinned to the line that writes it, and never to a sibling's", () => {
  const vocabulary = collectVocabulary(
    baseOf({
      "test/a.test.ts": lines(
        'import { describe, it } from "vitest";',
        'describe("outer", () => {',
        '  it("same", () => {});',
        "  it(",
        '    "same",',
        "    {",
        "      timeout: 1,",
        "    },",
        "    () => {},",
        "  );",
        "});",
      ),
    }),
  );
  expect(termOf(vocabulary, "same").pins.map((pin) => pin.range)).toEqual([{ start: 3, end: 3 }, { start: 5, end: 5 }]);
  // Written with escapes: pinned to the literal that writes it, which is the title's own line.
  const escaped = collectVocabulary(baseOf({ "test/b.test.ts": lines('import { it } from "vitest";', 'it("say \\"billing\\"", () => {});') }));
  expect(termOf(escaped, "say billing").pins[0]!.range).toEqual({ start: 2, end: 2 });
});

test("the description is the top-level key, not the first one in nested JSON; a heading of several lines pins every line", () => {
  const nested = lines("{", '  "custom": {', '    "description": "nested words"', "  },", '  "description": "Invoice processing"', "}");
  const vocabulary = collectVocabulary(baseOf({ "package.json": nested }));
  expect(termOf(vocabulary, "invoice processing").pins).toEqual([{ source: "package description", path: "package.json", range: { start: 5, end: 5 }, written: "Invoice processing" }]);
  expect(keys(vocabulary).some((key) => key.includes("nested"))).toBe(false);
  const oneLine = collectVocabulary(baseOf({ "package.json": '{"custom":{"description":"nested"},"description":"Invoice processing"}' }));
  expect(termOf(oneLine, "invoice processing").pins[0]!.range).toEqual({ start: 1, end: 1 });
  const setext = collectVocabulary(baseOf({ "A.md": lines("Invoice", "processing", "----------", "text", "", "Ledger", "======") }));
  expect(termOf(setext, "invoice processing").pins[0]!.range).toEqual({ start: 1, end: 3 });
  expect(termOf(setext, "ledger").pins[0]!.range).toEqual({ start: 6, end: 7 });
});

test("a plural and its singular merge: tested pairs", () => {
  const pairs = [
    ["cache", "caches"], ["status", "statuses"], ["box", "boxes"], ["class", "classes"], ["policy", "policies"], ["query", "queries"], ["case", "cases"],
    ["branch", "branches"], ["quiz", "quizzes"], ["size", "sizes"], ["bus", "buses"], ["address", "addresses"], ["dish", "dishes"], ["day", "days"],
    ["key", "keys"], ["database", "databases"], ["cookie", "cookies"], ["house", "houses"], ["tree", "trees"], ["type", "types"], ["use", "uses"],
  ] as const;
  for (const [one, many] of pairs) expect([one, stem(many)]).toEqual([one, stem(one)]);
  // Different words stay different.
  expect(stem("cache")).not.toBe(stem("cash"));
  expect(stem("status")).not.toBe(stem("state"));
  const vocabulary = collectVocabulary(baseOf({ "A.md": lines("# Cache", "", "# Caches", "", "# Status", "", "# Statuses") }));
  expect(vocabulary.terms.map((term) => term.pins.length)).toEqual([2, 2]);
  expect(vocabulary.tableVersion).toBeGreaterThan(1);
});

test("a test call with no callback is collected, and a title that is not a literal is counted, never silently absent", () => {
  const vocabulary = collectVocabulary(
    baseOf({
      "test/a.test.ts": lines(
        'import { it, test, describe } from "vitest";',
        "const name = 'n';",
        'test.todo("billing");',
        "it.skip(",
        "  'ledger entries',",
        ");",
        "it(name, () => {});",
        "it.todo(`todo ${name}`);",
        "describe.todo(name);",
      ),
    }),
  );
  expect(termOf(vocabulary, "billing").pins).toEqual([{ source: "test", path: "test/a.test.ts", range: { start: 3, end: 3 }, written: "billing" }]);
  expect(termOf(vocabulary, "ledger entry").pins[0]!.range).toEqual({ start: 5, end: 5 });
  expect(vocabulary.skipped.notLiteral).toBe(3);
});

// Round 2 of the Codex review of PR 276.

test("a test call in a comment or a string is not a test call", () => {
  const vocabulary = collectVocabulary(
    baseOf({ "a.test.ts": lines('// test.todo("phantom billing");', "/* it.skip('phantom ledger') */", "const text = 'test.todo(\"phantom invoice\")';", "const more = `it.skip(\"phantom payment\")`;") }),
  );
  expect(vocabulary).toMatchObject({ status: "none", terms: [] });
  expect(vocabulary.skipped.notLiteral).toBe(0);
});

test("a test title is the call's literal first argument, whatever its callback is", () => {
  const vocabulary = collectVocabulary(
    baseOf({
      "a.test.ts": lines(
        'import { test, it } from "vitest";',
        'test("billing", function check() {});',
        "function run() {}",
        'it.only("ledger", run);',
        "test(",
        '  "payment"',
        ", async () => {});",
        "test.concurrent(`invoice`, () => {});",
      ),
    }),
  );
  expect(keys(vocabulary)).toEqual(want("billing", "ledger", "payment", "invoice"));
  expect(termOf(vocabulary, "billing").pins).toEqual([{ source: "test", path: "a.test.ts", range: { start: 2, end: 2 }, written: "billing" }]);
  expect(termOf(vocabulary, "ledger").pins[0]!.range).toEqual({ start: 4, end: 4 });
  expect(termOf(vocabulary, "payment").pins[0]!.range).toEqual({ start: 6, end: 6 });
});

test("a test file's exports are collected like any other file's", () => {
  const vocabulary = collectVocabulary(baseOf({ "test/helpers.ts": "export function billing() {}\n" }));
  expect(termOf(vocabulary, "billing").pins).toEqual([{ source: "export", path: "test/helpers.ts", range: { start: 1, end: 1 }, written: "billing" }]);
});

test("a code file no adapter reads is counted in any role; data, media and plain repository files are not", () => {
  expect(collectVocabulary(baseOf({ "docs/worker.py": "def billing(): pass\n" }))).toMatchObject({ status: "unknown", terms: [], notAnalysed: 1 });
  expect(collectVocabulary(baseOf({ "tests/worker.rb": "def billing; end\n" }))).toMatchObject({ status: "unknown", notAnalysed: 1 });
  expect(collectVocabulary(baseOf({ ".gitignore": "dist\n", LICENSE: "MIT\n", "ci.yml": "name: ci\n", "package.json": "{}\n" }))).toMatchObject({ status: "none", notAnalysed: 0 });
});

test("a test title that cannot be read makes no term unknown, never none", () => {
  const vocabulary = collectVocabulary(baseOf({ "a.test.ts": lines('import { test } from "vitest";', "const title = getTitle();", "test(title, () => {});") }));
  expect(vocabulary).toMatchObject({ status: "unknown", terms: [] });
  expect(vocabulary.skipped.notLiteral).toBe(1);
  expect(vocabulary.reason).toMatch(/title/);
});

test("a wildcard re-export names nothing, and a namespace re-export keeps its name", () => {
  const vocabulary = collectVocabulary(baseOf({ "a.ts": lines('export * from "./billing";', 'export type * from "./ledger";', 'export * as Ledger from "./c";') }));
  expect(keys(vocabulary)).toEqual(want("ledger"));
  expect(vocabulary.skipped.wildcard).toBe(2);
});

test("a test title is a secret by its shape, not because the word withheld is in it", () => {
  const vocabulary = collectVocabulary(baseOf({ "test/a.test.ts": lines('import { test } from "vitest";', 'test("withheld invoices", () => {});') }));
  expect(termOf(vocabulary, "withheld invoice").pins[0]).toMatchObject({ source: "test", range: { start: 2, end: 2 } });
  expect(vocabulary.skipped.withheld).toBe(0);
});
