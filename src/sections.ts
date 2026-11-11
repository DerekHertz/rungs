import { diffText } from "./diff.ts";
import { compareIds, nodeId } from "./graph.ts";
import type { FileTree, Graph, LineRange, NodeId, SectionNode } from "./graph.ts";
import { countLines, splitLines } from "./lines.ts";

export type SectionChangeKind = "added" | "removed" | "altered";

/** A Markdown section some added or removed line fell in. */
export interface SectionChange {
  /** The head's id; the base's for a section only the base had. */
  readonly id: NodeId;
  /** The file's path in the head; in the base for a file the change removed. */
  readonly path: string;
  /** For display: the heading's text, "(2)" after a repeat among siblings. */
  readonly name: string;
  /** The heading's text as written, what a description is matched against; "" for the lines before the first heading. */
  readonly heading: string;
  readonly qualifiedName: string;
  readonly headingLevel: number;
  /** The display names of the enclosing sections, outermost first. */
  readonly ancestors: readonly string[];
  /** Their headings as written. */
  readonly ancestorHeadings: readonly string[];
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

/** The name of the lines before a file's first heading, or all of a file with no heading. Never a qualified name a heading can have. */
export const PREAMBLE = "(before the first heading)";

/** The sections of one side of one file, the lines before the first heading standing as one of their own. */
function sectionsOf(sections: readonly SectionNode[], path: string, text: string): SectionNode[] {
  const end = (sections[0]?.range.start ?? countLines(text) + 1) - 1;
  if (end < 1) return [...sections];
  const preamble: SectionNode = { id: nodeId("section", path, PREAMBLE), level: "section", path, name: PREAMBLE, heading: "", parent: nodeId("file", path, ""), headingLevel: 0, qualifiedName: PREAMBLE, range: { start: 1, end } };
  return [preamble, ...sections];
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
 * section that holds it; a section is the same on both sides when its qualified name is. The
 * lines before a file's first heading, or a file with no heading, are a section named PREAMBLE.
 * When the texts are too large to diff, see the fallback below.
 */
export function diffSections(base: Graph, head: Graph, pairs: readonly FilePair[], trees: { readonly base: FileTree; readonly head: FileTree }): SectionChange[] {
  const baseBy = byPath(base);
  const headBy = byPath(head);
  const changes: SectionChange[] = [];
  for (const { basePath, headPath } of pairs) {
    const baseText = basePath === undefined ? "" : (trees.base.get(basePath) ?? "");
    const headText = headPath === undefined ? "" : (trees.head.get(headPath) ?? "");
    const baseSections = basePath === undefined ? [] : sectionsOf(baseBy.get(basePath) ?? [], basePath, baseText);
    const headSections = headPath === undefined ? [] : sectionsOf(headBy.get(headPath) ?? [], headPath, headText);
    const counts = new Map<string, { plus: number; minus: number }>();
    const count = (section: SectionNode | undefined, which: "plus" | "minus"): void => {
      if (section === undefined) return;
      const found = counts.get(section.qualifiedName) ?? { plus: 0, minus: 0 };
      found[which] += 1;
      counts.set(section.qualifiedName, found);
    };
    const ops = diffText(baseText, headText);
    if (ops === undefined) {
      // Too large to diff: what the two sides share at their start and end is unchanged, and the
      // middle between is credited to the sections it overlaps. A section whose own text is the
      // same on both sides is never changed, whatever the middle overlaps.
      const a = splitLines(baseText);
      const b = splitLines(headText);
      let top = 0;
      while (top < a.length && top < b.length && a[top] === b[top]) top++;
      let bottom = 0;
      while (bottom < a.length - top && bottom < b.length - top && a[a.length - 1 - bottom] === b[b.length - 1 - bottom]) bottom++;
      for (let line = top + 1; line <= a.length - bottom; line++) count(holding(baseSections, line), "minus");
      for (let line = top + 1; line <= b.length - bottom; line++) count(holding(headSections, line), "plus");
      const headBy = new Map(headSections.map((section) => [section.qualifiedName, section]));
      for (const section of baseSections) {
        const other = headBy.get(section.qualifiedName);
        if (other !== undefined && a.slice(section.range.start - 1, section.range.end).join("\n") === b.slice(other.range.start - 1, other.range.end).join("\n")) counts.delete(section.qualifiedName);
      }
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
    const headingsOf = (section: SectionNode, within: ReadonlyMap<NodeId, SectionNode>): string[] => {
      const names: string[] = [];
      for (let parent = within.get(section.parent); parent !== undefined; parent = within.get(parent.parent)) names.unshift(parent.heading);
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
        heading: section.heading,
        qualifiedName: name,
        headingLevel: section.headingLevel,
        ancestors: ancestorsOf(section, inHead === undefined ? baseIds : headIds),
        ancestorHeadings: headingsOf(section, inHead === undefined ? baseIds : headIds),
        kind: inBase === undefined ? "added" : inHead === undefined ? "removed" : "altered",
        range: section.range,
        plus,
        minus,
      });
    }
  }
  return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.range.start - b.range.start || compareIds(a.id, b.id));
}
