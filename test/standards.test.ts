import { expect, test } from "vitest";
import { extract } from "../src/extract/extract.ts";
import type { FileTree } from "../src/graph.ts";
import { STANDARDS_TABLE_VERSION, collectStandards } from "../src/standards.ts";

const tree = (files: Record<string, string>): FileTree => new Map(Object.entries(files));
const baseOf = (files: Record<string, string>) => {
  const t = tree(files);
  return { graph: extract(t), tree: t };
};

// Two repositories with different layouts, and one with no written rules.
const agentsRepo = {
  "package.json": "{}\n",
  "AGENTS.md": ["# Project", "Intro words.", "", "## Working rules", "", "### Review rounds", "Two rounds at most.", "", "### Tests", "Write the red test first.", "", "## Layout", "src holds code."].join("\n") + "\n",
  "CONTRIBUTING.md": "Open an issue first.\nKeep commits small.\n",
  "src/a.ts": "export const a = 1;\n",
};
const readmeRepo = {
  "README.md": ["# Tool", "What it is.", "", "## Install", "npm i", "", "## Contributing", "Fork it.", "", "### Code style", "Use tabs.", "", "## License", "MIT"].join("\n") + "\n",
  "docs/style-guide.md": "# Style\nName things plainly.\n",
  ".claude/rules/naming.md": "Camel case.\n",
  "CLAUDE.md": "No headings here, only a rule.\n",
};
const bareRepo = {
  "README.md": "# Tool\nWhat it is.\n\n## Install\nnpm i\n",
  "src/a.ts": "export const a = 1;\n",
};

test("a repository with AGENTS.md and CONTRIBUTING.md yields each section pinned to its own lines", () => {
  const found = collectStandards(baseOf(agentsRepo));
  expect(found.status).toBe("found");
  expect(found.unread).toEqual([]);
  expect(found.tableVersion).toBe(STANDARDS_TABLE_VERSION);
  expect(found.rules.map((rule) => [rule.path, rule.heading, rule.range.start, rule.range.end])).toEqual([
    ["AGENTS.md", "Project", 1, 3],
    ["AGENTS.md", "Review rounds", 6, 8],
    ["AGENTS.md", "Tests", 9, 11],
    ["AGENTS.md", "Layout", 12, 13],
    ["CONTRIBUTING.md", "", 1, 2],
  ]);
  // "Working rules" holds only its children, so it is not a rule of its own; ranges never overlap.
  const review = found.rules.find((rule) => rule.heading === "Review rounds")!;
  expect(review.ancestorHeadings).toEqual(["Project", "Working rules"]);
  expect(review.kind).toBe("agent instructions");
  expect(found.rules.at(-1)!.kind).toBe("contributing");
});

test("a repository with a README, a style guide, rule folders and a heading-less CLAUDE.md yields rules from each", () => {
  const found = collectStandards(baseOf(readmeRepo));
  expect(found.status).toBe("found");
  expect(found.rules.map((rule) => [rule.path, rule.heading, rule.kind])).toEqual([
    [".claude/rules/naming.md", "", "agent instructions"],
    ["CLAUDE.md", "", "agent instructions"],
    ["README.md", "Contributing", "readme"],
    ["README.md", "Code style", "readme"],
    ["docs/style-guide.md", "Style", "style guide"],
  ]);
  // The README's other sections are not rules.
  expect(found.rules.some((rule) => ["Install", "License", "Tool"].includes(rule.heading))).toBe(false);
});

test("a repository with no written rules yields none, which is not unknown", () => {
  const found = collectStandards(baseOf(bareRepo));
  expect(found).toMatchObject({ status: "none", rules: [], unread: [] });
});

test("no base at all is unknown, never none", () => {
  const found = collectStandards(undefined);
  expect(found.status).toBe("unknown");
  expect(found.rules).toEqual([]);
  expect(found.reason).toMatch(/base/);
});

test("a rule file that cannot be read is unknown, and listed as unread beside the rules that could be", () => {
  const only = collectStandards(baseOf({ "AGENTS.md": "# A\u0000\u0001 binary\n" }));
  expect(only).toMatchObject({ status: "unknown", rules: [], unread: ["AGENTS.md"] });
  const some = collectStandards(baseOf({ "AGENTS.md": "# A\u0000\u0001 binary\n", "CONTRIBUTING.md": "Be kind.\n" }));
  expect(some.status).toBe("found");
  expect(some.unread).toEqual(["AGENTS.md"]);
});

test("a graph that does not match its tree is unknown rather than a guess", () => {
  const t = tree({ "AGENTS.md": "# A\nrule\n" });
  const found = collectStandards({ graph: extract(tree({ "other.md": "x\n" })), tree: t });
  expect(found).toMatchObject({ status: "unknown", unread: ["AGENTS.md"] });
});

test("rules come from the base: a change that loosens a rule neither hides nor rewrites it", () => {
  const base = baseOf({ "AGENTS.md": "# Rules\nNever skip tests.\n", "CONTRIBUTING.md": "Small commits.\n" });
  const head = tree({ "AGENTS.md": "# Rules\nSkip tests freely.\n", "CONTRIBUTING.md": "Small commits.\n", "STYLEGUIDE.md": "New rule.\n" });
  const found = collectStandards(base, head);
  expect(found.rules.map((rule) => [rule.path, rule.edited])).toEqual([
    ["AGENTS.md", true],
    ["CONTRIBUTING.md", false],
  ]);
  // A rule file only the change added is not in the base, so it binds nothing.
  expect(found.rules.some((rule) => rule.path === "STYLEGUIDE.md")).toBe(false);
});

test("a rule file the change deleted or moved is edited by it; without the head, edited is unknown", () => {
  const base = baseOf({ "AGENTS.md": "# Rules\nA.\n" });
  expect(collectStandards(base, tree({ "docs/AGENTS.md": "# Rules\nA.\n" })).rules[0]!.edited).toBe(true);
  expect(collectStandards(base, tree({})).rules[0]!.edited).toBe(true);
  expect(collectStandards(base).rules[0]!.edited).toBeNull();
});

test("nested agent files and any letter case are matched; a path named __proto__ is just a path", () => {
  const found = collectStandards(baseOf({ "packages/web/agents.md": "# Web\nUse hooks.\n", "__proto__.md": "# Not a rule\nx\n", "docs/Contributing.md": "Hi.\n" }));
  expect(found.rules.map((rule) => rule.path)).toEqual(["docs/Contributing.md", "packages/web/agents.md"]);
});

test("a rule file the graph holds but the tree lacks is unread, so the answer is unknown, never none", () => {
  const graph = extract(tree({ "AGENTS.md": "# A\nrule\n" }));
  expect(collectStandards({ graph, tree: tree({}) })).toMatchObject({ status: "unknown", rules: [], unread: ["AGENTS.md"] });
  const both = tree({ "AGENTS.md": "# A\nrule\n", "CONTRIBUTING.md": "Be kind.\n" });
  const some = collectStandards({ graph: extract(both), tree: tree({ "CONTRIBUTING.md": "Be kind.\n" }) });
  expect(some).toMatchObject({ status: "found", unread: ["AGENTS.md"] });
});

test("a rule file the table names but the extractor reads no sections from (an uppercase extension) is unread, not skipped", () => {
  const found = collectStandards(baseOf({ "AGENTS.MD": "# A\nrule\n" }));
  expect(found).toMatchObject({ status: "unknown", rules: [], unread: ["AGENTS.MD"] });
});

test("a setext heading with no body, and a file of blank lines, are not rules", () => {
  const found = collectStandards(baseOf({ "CONTRIBUTING.md": "Title\n=====\n\n", "AGENTS.md": "\n\n" }));
  expect(found).toMatchObject({ status: "none", rules: [] });
});
