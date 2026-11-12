import { posix } from "node:path";
import type { FileNode, FileTree, Graph, LineRange, NodeId, SectionNode } from "./graph.ts";
import { sliceLines } from "./lines.ts";
import { sectionsOf } from "./sections.ts";
import { STANDARDS_TABLE, STANDARDS_TABLE_VERSION } from "./standards-table.ts";
import type { RuleKind, StandardsEntry } from "./standards-table.ts";

export { STANDARDS_TABLE_VERSION } from "./standards-table.ts";
export type { RuleKind } from "./standards-table.ts";

/*
 * The written rules of a repository (SPEC rule 5, never guess; CODING_STANDARDS, unknown is never
 * zero). A rule is a Markdown section of a file the table in standards-table.ts names, found in the
 * graph's sections and pinned to its own lines. No model is called, and the table is the same for
 * every repository.
 *
 * Rules are read from the BASE tree and graph only. The head tree is looked at for one thing: did
 * the change touch the rule's file. A change cannot loosen the rule it is judged by, because the
 * rule's lines are the base's.
 */

/** One section of a rule file, pinned to the lines that are its own. */
export interface Rule {
  /** The section's id in the base graph. */
  readonly id: NodeId;
  /** The rule file, in the base. */
  readonly path: string;
  readonly kind: RuleKind;
  /** The heading as written; "" for the lines before a file's first heading, or all of a file with none. */
  readonly heading: string;
  readonly qualifiedName: string;
  /** The headings of the enclosing sections, outermost first. */
  readonly ancestorHeadings: readonly string[];
  /** The section's own lines in the base: its heading to the line before its first nested heading. Never overlaps another rule's. */
  readonly range: LineRange;
  /** True when the change edited, moved or deleted the rule's file, so the lines above are what the change would replace. Null when the head was not given: unknown. */
  readonly edited: boolean | null;
}

/**
 * - "found": at least one rule. `unread` may still name rule files that could not be read, so the list is then incomplete.
 * - "none": the base was read, every file the table names was read, and none holds a rule.
 * - "unknown": the rules could not be read, so there may be some. Never to be shown or counted as none.
 */
export type StandardsStatus = "found" | "none" | "unknown";

export interface Standards {
  readonly tableVersion: number;
  readonly status: StandardsStatus;
  /** Sorted by path, then line. */
  readonly rules: readonly Rule[];
  /** Files the table names in the base that could not be read as text (binary, or absent from the graph), sorted. */
  readonly unread: readonly string[];
  /** Why the status is "unknown", for display. */
  readonly reason?: string;
}

/** The base as the collector reads it: its graph and the texts the graph was extracted from. */
export interface BaseSide {
  readonly graph: Graph;
  readonly tree: FileTree;
}

/** The first table entry naming this path. A section exists only in a ".md" file, as the extractor reads it. */
function entryFor(path: string): StandardsEntry | undefined {
  return posix.extname(path) === ".md" ? STANDARDS_TABLE.find((entry) => entry.path.test(path)) : undefined;
}

/** A section's lines to its first nested heading, or its whole range when it has none. */
function ownRange(section: SectionNode, children: readonly SectionNode[]): LineRange {
  const first = children.reduce((least, child) => Math.min(least, child.range.start), section.range.end + 1);
  return { start: section.range.start, end: first - 1 };
}

/** Whether lines hold more than the heading itself: the text under it, not a setext underline or blank lines. */
function hasBody(text: string, range: LineRange, isHeading: boolean): boolean {
  const lines = sliceLines(text, range).split("\n").slice(isHeading ? 1 : 0);
  return lines.some((line) => !/^\s*(?:=+|-+)?\s*$/.test(line));
}

export function collectStandards(base: BaseSide | undefined, head?: FileTree): Standards {
  if (base === undefined) return { tableVersion: STANDARDS_TABLE_VERSION, status: "unknown", rules: [], unread: [], reason: "the base tree could not be read" };
  const files = new Map<string, FileNode>();
  for (const node of base.graph.nodes) if (node.level === "file") files.set(node.path, node);
  const sectionsBy = new Map<string, SectionNode[]>();
  for (const section of base.graph.sections) sectionsBy.set(section.path, [...(sectionsBy.get(section.path) ?? []), section]);

  const rules: Rule[] = [];
  const unread: string[] = [];
  for (const path of [...base.tree.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const entry = entryFor(path);
    if (entry === undefined) continue;
    const text = base.tree.get(path)!;
    // A binary file has bytes, not lines; a file the graph does not hold means the graph is not of this tree. Neither is "no rules".
    if ((files.get(path)?.lines ?? null) === null) {
      unread.push(path);
      continue;
    }
    const found = sectionsBy.get(path) ?? [];
    found.sort((a, b) => a.range.start - b.range.start || b.range.end - a.range.end);
    const sections = sectionsOf(found, path, text);
    const byId = new Map(sections.map((section) => [section.id, section]));
    const children = new Map<NodeId, SectionNode[]>();
    for (const section of sections) children.set(section.parent, [...(children.get(section.parent) ?? []), section]);
    for (const section of sections) {
      const ancestors: SectionNode[] = [];
      for (let parent = byId.get(section.parent); parent !== undefined; parent = byId.get(parent.parent)) ancestors.unshift(parent);
      const headings = ancestors.map((one) => one.heading);
      if (entry.headings !== undefined && ![section.heading, ...headings].some((heading) => entry.headings!.test(heading))) continue;
      const range = ownRange(section, children.get(section.id) ?? []);
      if (!hasBody(text, range, section.headingLevel > 0)) continue;
      rules.push({ id: section.id, path, kind: entry.kind, heading: section.heading, qualifiedName: section.qualifiedName, ancestorHeadings: headings, range, edited: head === undefined ? null : head.get(path) !== text });
    }
  }
  if (rules.length > 0) return { tableVersion: STANDARDS_TABLE_VERSION, status: "found", rules, unread };
  if (unread.length > 0) return { tableVersion: STANDARDS_TABLE_VERSION, status: "unknown", rules, unread, reason: `a rule file could not be read: ${unread.join(", ")}` };
  return { tableVersion: STANDARDS_TABLE_VERSION, status: "none", rules, unread };
}
