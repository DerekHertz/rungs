import { diffText } from "./diff.ts";
import { compareIds, nodeId } from "./graph.ts";
import type { FileTree, Graph, LineRange, NodeId, SectionNode } from "./graph.ts";
import { countLines } from "./lines.ts";

export type SectionChangeKind = "added" | "removed" | "altered";

/** A Markdown section some added or removed line fell in. */
export interface SectionChange {
  /** The head's id; the base's for a section only the base had. */
  readonly id: NodeId;
  /** The file's path in the head; in the base for a file the change removed. */
  readonly path: string;
  /** The heading's text, "(2)" after a repeat among siblings. */
  readonly name: string;
  readonly qualifiedName: string;
  readonly headingLevel: number;
  /** The headings of the enclosing sections, outermost first. */
  readonly ancestors: readonly string[];
  /** "added" when the head has the section and the base does not, "removed" the other way round. */
  readonly kind: SectionChangeKind;
  /** The section's lines in the head; in the base for a removed one. */
  readonly range: LineRange;
  /** Added lines and removed lines inside it, not counting its nested sections' own lines twice: each line counts once, in the innermost section holding it. */
  readonly plus: number;
  readonly minus: number;
}

/** A Markdown file on each side: the path in the base and in the head, undefined when the file is new or gone. */
export interface FilePair {
  readonly basePath: string | undefined;
  readonly headPath: string | undefined;
}

const byPath = (graph: Graph): Map<string, SectionNode[]> => {
  const found = new Map<string, SectionNode[]>();
  for (const section of graph.sections) found.set(section.path, [...(found.get(section.path) ?? []), section]);
  for (const list of found.values()) list.sort((a, b) => a.range.start - b.range.start || b.range.end - a.range.end);
  return found;
};

/** The innermost section holding `line`: the last one starting at or before it that reaches it. */
function holding(sections: readonly SectionNode[], line: number): SectionNode | undefined {
  let found: SectionNode | undefined;
  for (const section of sections) {
    if (section.range.start > line) break;
    if (line <= section.range.end) found = section;
  }
  return found;
}

/**
 * The sections whose lines changed in each Markdown file of `pairs`, by a line diff of the two
 * texts. Each added line counts in the head section that holds it, each removed line in the base
 * section that holds it; a section is the same on both sides when its qualified name is. A line
 * before a file's first heading is in no section. When the texts are too large to diff, every
 * base line counts as removed and every head line as added.
 */
export function diffSections(base: Graph, head: Graph, pairs: readonly FilePair[], trees: { readonly base: FileTree; readonly head: FileTree }): SectionChange[] {
  const baseBy = byPath(base);
  const headBy = byPath(head);
  const changes: SectionChange[] = [];
  for (const { basePath, headPath } of pairs) {
    const baseText = basePath === undefined ? "" : (trees.base.get(basePath) ?? "");
    const headText = headPath === undefined ? "" : (trees.head.get(headPath) ?? "");
    const baseSections = basePath === undefined ? [] : (baseBy.get(basePath) ?? []);
    const headSections = headPath === undefined ? [] : (headBy.get(headPath) ?? []);
    if (baseSections.length === 0 && headSections.length === 0) continue;
    const counts = new Map<string, { plus: number; minus: number }>();
    const count = (section: SectionNode | undefined, which: "plus" | "minus"): void => {
      if (section === undefined) return;
      const found = counts.get(section.qualifiedName) ?? { plus: 0, minus: 0 };
      found[which] += 1;
      counts.set(section.qualifiedName, found);
    };
    const ops = diffText(baseText, headText);
    if (ops === undefined) {
      for (let line = 1; line <= countLines(baseText); line++) count(holding(baseSections, line), "minus");
      for (let line = 1; line <= countLines(headText); line++) count(holding(headSections, line), "plus");
    } else {
      for (const op of ops) {
        if (op.kind === "added") count(holding(headSections, op.head), "plus");
        else if (op.kind === "removed") count(holding(baseSections, op.base), "minus");
      }
    }
    const headNames = new Map(headSections.map((section) => [section.qualifiedName, section]));
    const baseNames = new Map(baseSections.map((section) => [section.qualifiedName, section]));
    const ancestorsOf = (section: SectionNode, within: ReadonlyMap<NodeId, SectionNode>): string[] => {
      const names: string[] = [];
      for (let parent = within.get(section.parent); parent !== undefined; parent = within.get(parent.parent)) names.unshift(parent.name);
      return names;
    };
    const side = (sections: readonly SectionNode[]): Map<NodeId, SectionNode> => new Map(sections.map((section) => [section.id, section]));
    const headIds = side(headSections);
    const baseIds = side(baseSections);
    for (const [name, { plus, minus }] of counts) {
      const inHead = headNames.get(name);
      const inBase = baseNames.get(name);
      const section = inHead ?? inBase!;
      const path = headPath ?? basePath!;
      changes.push({
        id: inHead === undefined ? nodeId("section", path, name) : inHead.id,
        path,
        name: section.name,
        qualifiedName: name,
        headingLevel: section.headingLevel,
        ancestors: ancestorsOf(section, inHead === undefined ? baseIds : headIds),
        kind: inBase === undefined ? "added" : inHead === undefined ? "removed" : "altered",
        range: section.range,
        plus,
        minus,
      });
    }
  }
  return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.range.start - b.range.start || compareIds(a.id, b.id));
}
