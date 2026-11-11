import { expect, test } from "vitest";
import { compare, pictureOf } from "../src/compare.ts";
import { extract } from "../src/extract/extract.ts";
import { markdownSections } from "../src/extract/markdown.ts";
import type { FileTree } from "../src/graph.ts";
import { headingAppears, sectionCount, unmentioned } from "../src/review.ts";
import { unmentionedSummary } from "../src/review-summary.ts";

const tree = (files: Record<string, string>): FileTree => new Map(Object.entries(files));

test("every ATX heading is a section, nested by level and pinned to its lines", () => {
  const text = "# One\nintro\n## Two\nbody\n### Three\n## Four\n# Five\n";
  expect(markdownSections(text)).toEqual([
    { text: "One", level: 1, start: 1, end: 6 },
    { text: "Two", level: 2, start: 3, end: 5 },
    { text: "Three", level: 3, start: 5, end: 5 },
    { text: "Four", level: 2, start: 6, end: 6 },
    { text: "Five", level: 1, start: 7, end: 7 },
  ]);
});

test("headings inside fenced code, indented code and non-headings are not sections", () => {
  const text = ["# Real", "```sh", "# comment", "```", "~~~~", "## in tilde", "~~~", "still fenced", "~~~~", "    # indented", "#nospace", "####### seven", "## Closed ##", "#"].join("\n");
  expect(markdownSections(text).map((heading) => [heading.level, heading.text])).toEqual([
    [1, "Real"],
    [2, "Closed"],
    [1, ""],
  ]);
});

test("the extractor records sections with identity (level, path, qualified name)", () => {
  const graph = extract(tree({ "docs/a.md": "# Top\n## Dup\n## Dup\n### Sub\n# Other\n## Dup\n", "src/b.ts": "// # not markdown\n" }));
  expect(graph.sections.map((section) => section.id)).toEqual([
    'section:docs/a.md#Other',
    'section:docs/a.md#Other.Dup',
    'section:docs/a.md#Top',
    'section:docs/a.md#Top.Dup',
    'section:docs/a.md#Top.Dup@2',
    'section:docs/a.md#Top.Dup@2.Sub',
  ]);
  const second = graph.sections.find((section) => section.qualifiedName === 'Top.Dup@2');
  expect(second).toMatchObject({ name: "Dup (2)", headingLevel: 2, parent: 'section:docs/a.md#Top', range: { start: 3, end: 4 } });
  expect(graph.sections.find((section) => section.qualifiedName === 'Top')?.parent).toBe("file:docs/a.md");
  // Sections are beside the modules, not among them.
  expect(graph.nodes.some((node) => (node.level as string) === "section")).toBe(false);
});

const spec = (picture: string, review: string): string => `# Title\nintro\n## The picture\n${picture}\n## Review\n### Comparison marks\n${review}\n## Seams\nsame\n`;

const compared = (base: Record<string, string>, head: Record<string, string>) => {
  const baseTree = tree(base);
  const headTree = tree(head);
  const headGraph = extract(headTree);
  const comparison = compare(extract(baseTree), headGraph, { base: baseTree, head: headTree });
  return { comparison, graph: pictureOf(headGraph, comparison).graph };
};

test("a changed line counts once, in the innermost section, added and removed apart", () => {
  const { comparison } = compared({ "SPEC.md": spec("old", "x") }, { "SPEC.md": spec("new one\nnew two", "x\ny") });
  expect(comparison.sections.map((s) => [s.qualifiedName, s.kind, s.plus, s.minus, s.ancestors])).toEqual([
    ['Title."The picture"', "altered", 2, 1, ["Title"]],
    ['Title.Review."Comparison marks"', "altered", 1, 0, ["Title", "Review"]],
  ]);
});

test("added and removed sections are listed whole, and a renamed heading is one of each", () => {
  const { comparison } = compared({ "a.md": "# A\n## Old\nx\n" }, { "a.md": "# A\n## New\nx\ny\n" });
  expect(comparison.sections.map((s) => [s.name, s.kind, s.plus, s.minus])).toEqual([
    ["New", "added", 2, 0],
    ["Old", "removed", 0, 1],
  ]);
});

test("without the texts a comparison lists no sections; a file with no change lists none", () => {
  const baseTree = tree({ "a.md": "# A\n" });
  const headTree = tree({ "a.md": "# A\nmore\n" });
  expect(compare(extract(baseTree), extract(headTree)).sections).toEqual([]);
  expect(compare(extract(baseTree), extract(baseTree), { base: baseTree, head: baseTree }).sections).toEqual([]);
});

test("a moved Markdown file keeps its sections' identity across the move", () => {
  const { comparison } = compared({ "old/a.md": "# A\n## B\nx\n" }, { "new/a.md": "# A\n## B\nx\n" });
  expect(comparison.changes.map((change) => change.kind)).toContain("moved");
  expect(comparison.sections).toEqual([]);
});

test("a heading is mentioned as a whole phrase, ignoring case, white space and punctuation around it", () => {
  expect(headingAppears("Touches the picture and Review.", "Review")).toBe(true);
  expect(headingAppears("see THE   PICTURE section", "The picture")).toBe(true);
  expect(headingAppears("a reviewer looked", "Review")).toBe(false);
  expect(headingAppears("a preview", "Review")).toBe(false);
  expect(headingAppears("Seams (Theme) too", "Seams (Theme)")).toBe(true);
  expect(headingAppears("anything", "")).toBe(false);
  expect(headingAppears("the ## marks", "##")).toBe(false);
});

test("unmentioned lists a Markdown file's changed sections under it, and drops the ones the description names", () => {
  const { comparison, graph } = compared({ "SPEC.md": spec("old", "x") }, { "SPEC.md": spec("new", "y") });
  const none = unmentioned(comparison, graph, "Tidies things.");
  const file = none.entries[0]!;
  expect(file.label).toBe("SPEC.md");
  expect(file.children.map((child) => [child.level, child.label, "plus" in child ? child.plus : 0, "minus" in child ? child.minus : 0])).toEqual([
    ["section", "Title › The picture", 1, 1],
    ["section", "Title › Review › Comparison marks", 1, 1],
  ]);
  expect(sectionCount(none.entries)).toBe(2);
  // Naming a heading covers it; naming an enclosing heading covers what is inside it.
  expect(unmentioned(comparison, graph, "Reworks the picture.").entries[0]!.children.map((child) => child.label)).toEqual(["Title › Review › Comparison marks"]);
  expect(unmentioned(comparison, graph, "Reworks the picture and review.").entries[0]!.children).toEqual([]);
  // Naming the file covers every section.
  expect(unmentioned(comparison, graph, "Edits SPEC.md.").entries).toEqual([]);
});

test("a section's changed lines never make a mentioned-by-path file unmentioned, and the summary counts sections", () => {
  expect(unmentionedSummary({ files: 1, sections: 3, calls: 0 })).toBe("1 file · 3 sections");
  expect(unmentionedSummary({ files: 0, sections: 0, calls: 0 })).toBe("nothing");
});

test("a fence inside a list item or a block quote hides the headings in it", () => {
  const text = "# Public\n\n- ~~~\n  # Example\n  ~~~\n\n> ```\n> # Quoted\n> ```\n\n1. ```js\n   # Numbered\n   ```\n\n# Private\nold\n";
  expect(markdownSections(text).map((heading) => heading.text)).toEqual(["Public", "Private"]);
  expect(markdownSections("- item\n\n```\n# in\n```\n# After\n").map((heading) => heading.text)).toEqual(["After"]);
});

test("lines before the first heading, and files with no heading, are a section only the file path covers", () => {
  const { comparison, graph } = compared({ "a.md": "intro\n# A\nx\n", "b.md": "plain\n" }, { "a.md": "intro 2\n# A\nx\n", "b.md": "plain 2\n" });
  expect(comparison.sections.map((s) => [s.path, s.name, s.plus, s.minus])).toEqual([
    ["a.md", "(before the first heading)", 1, 1],
    ["b.md", "(before the first heading)", 1, 1],
  ]);
  expect(unmentioned(comparison, graph, "Edits the before the first heading text.").entries.map((entry) => entry.label)).toEqual(["a.md", "b.md"]);
  expect(unmentioned(comparison, graph, "Edits a.md.").entries.map((entry) => entry.label)).toEqual(["b.md"]);
});

test("display suffixes never change what a heading covers", () => {
  const release = compared({ "a.md": "# Release (2)\nx\n" }, { "a.md": "# Release (2)\ny\n" });
  expect(unmentioned(release.comparison, release.graph, "Release").entries[0]!.children).toHaveLength(1);
  expect(unmentioned(release.comparison, release.graph, "Release (2)").entries[0]!.children).toEqual([]);
  const twin = compared({ "a.md": "# First\n# First\n## Child\nx\n" }, { "a.md": "# First\n# First\n## Child\ny\n" });
  expect(unmentioned(twin.comparison, twin.graph, "First").entries[0]!.children).toEqual([]);
});

test("a diff too large to search never marks an unchanged section as changed", () => {
  const run = (word: string): string => `${word}\n`.repeat(1100);
  const { comparison } = compared({ "a.md": `# A\n${run("x")}${run("y")}# B\nsame\n` }, { "a.md": `# A\n${run("y")}${run("x")}# B\nsame\n` });
  expect(comparison.sections.map((s) => [s.name, s.plus, s.minus])).toEqual([["A", 2200, 2200]]);
});
