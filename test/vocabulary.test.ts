import { expect, test } from "vitest";
import { extract } from "../src/extract/extract.ts";
import type { FileTree } from "../src/graph.ts";
import { GENERIC_PHRASES, GENERIC_WORDS, VOCABULARY_TABLE_VERSION } from "../src/vocabulary-table.ts";
import { collectVocabulary, singular, wordsOf } from "../src/vocabulary.ts";
import type { Term, Vocabulary } from "../src/vocabulary.ts";

const tree = (files: Record<string, string>): FileTree => new Map(Object.entries(files));
const baseOf = (files: Record<string, string>) => {
  const t = tree(files);
  return { graph: extract(t), tree: t };
};
const lines = (...rows: string[]): string => rows.join("\n") + "\n";
const termOf = (vocabulary: Vocabulary, key: string): Term => {
  const found = vocabulary.terms.find((term) => term.key === key);
  if (found === undefined) throw new Error(`no term "${key}" among ${vocabulary.terms.map((term) => term.key).join(", ")}`);
  return found;
};
const keys = (vocabulary: Vocabulary): string[] => vocabulary.terms.map((term) => term.key);

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
  expect(keys(vocabulary)).toEqual([
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
  ]);
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
      { key: "license", rule: "generic" },
      { key: "src", rule: "generic" },
      { key: "test", rule: "generic" },
      { key: "util", rule: "generic" },
    ],
  });
  expect(keys(vocabulary)).not.toContain("util");
  // The app's "util" folder is dropped too, and its one-letter constant "x" as too short to mean anything.
  const more = collectVocabulary(baseOf(app));
  expect(more.dropped.terms).toEqual(expect.arrayContaining([{ key: "util", rule: "generic" }, { key: "x", rule: "short" }]));
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
  expect(keys(vocabulary).filter((key) => key.includes("flow"))).toEqual(["order flow"]);
});

test("an app with docs: nested docs, kebab-case folders and exports are read; vendored, hidden and generic things are counted, not read", () => {
  const vocabulary = collectVocabulary(baseOf(app));
  expect(keys(vocabulary)).toEqual(expect.arrayContaining(["architecture", "payment provider", "payment", "charge card", "glossary", "checkout service", "shop"]));
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
  expect(keys(other)).toEqual(["real"]);
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
  expect(bare.dropped.terms.map((one) => one.key)).toEqual(["ab", "readme", "src"]);
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
  expect(keys(vocabulary)).toEqual(["sandbox", "work"]);
  expect(termOf(vocabulary, "sandbox").pins.map((pin) => pin.written)).toEqual(["The sandbox", "sandboxOf", "isTheSandbox"]);
  // A name made only of stop words is not a word.
  expect(collectVocabulary(baseOf({ "A.md": "# What is it\n" })).skipped.notAWord).toBe(1);
});

test("names that are keys of Object.prototype are ordinary terms", () => {
  const vocabulary = collectVocabulary(baseOf({ "A.md": "# constructor\n\n## __proto__\n\n## toString\n" }));
  expect(keys(vocabulary)).toEqual(["constructor", "proto", "string"]);
});

test("words: case, plural and separators give one spelling; the table's lists are already singular", () => {
  expect(wordsOf("reviewRounds")).toEqual(["review", "rounds"]);
  expect(wordsOf("REVIEW_ROUNDS")).toEqual(["review", "rounds"]);
  expect(wordsOf("review-rounds")).toEqual(["review", "rounds"]);
  expect(wordsOf("HTMLParser")).toEqual(["html", "parser"]);
  expect(wordsOf("sha256Digest")).toEqual(["sha", "256", "digest"]);
  expect(wordsOf("doesn't")).toEqual(["doesnt"]);
  for (const [plural, one] of [["rounds", "round"], ["policies", "policy"], ["boxes", "box"], ["classes", "class"], ["cases", "case"], ["status", "status"], ["analysis", "analysis"], ["bus", "bus"], ["keys", "key"]]) expect(singular(plural!)).toBe(one);
  for (const word of GENERIC_WORDS) expect(singular(word)).toBe(word);
  for (const phrase of GENERIC_PHRASES) expect(phrase).toBe(wordsOf(phrase).map(singular).join(" "));
});

test("a package.json that starts with a byte order mark still gives its description", () => {
  const vocabulary = collectVocabulary(baseOf({ "package.json": '﻿{"description": "Lint changelogs"}\n' }));
  expect(termOf(vocabulary, "lint changelog").pins[0]).toMatchObject({ source: "package description", range: { start: 1, end: 1 } });
  expect(vocabulary.unread).toEqual([]);
});
