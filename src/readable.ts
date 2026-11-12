import { compare } from "./compare.ts";
import type { Comparison, UnreadFile } from "./compare.ts";
import { extract } from "./extract/extract.ts";
import { isCodeNode } from "./graph.ts";
import type { FileTree, Graph, ModuleNode, NodeId } from "./graph.ts";

/**
 * Two graphs with every file either side could not fully read made equal in what they claim about
 * it: on both sides it keeps its file node (marked "not fully read") and nothing under it. A file
 * that parses on one side and fails on the other would otherwise show phantom removed or added
 * functions, contracts and calls, which are the missing parse and not a change (SPEC rule 5).
 * A file that moved with identical text to a path the other side parses (view.ts to view.tsx) is
 * the same file: its other path is withheld too.
 */
export function withholdUnread(base: Graph, head: Graph): { readonly base: Graph; readonly head: Graph; readonly unread: readonly UnreadFile[]; readonly withheld: ReadonlySet<string> } {
  const filesOf = (graph: Graph): Map<string, string> => new Map(graph.nodes.flatMap((node) => (node.level === "file" ? [[node.path, node.digest] as const] : [])));
  const unreadIn = (graph: Graph): Set<string> => new Set(graph.nodes.flatMap((node) => (node.level === "file" && node.analysis === "not fully read" ? [node.path] : [])));
  const was = filesOf(base);
  const now = filesOf(head);
  const onBase = unreadIn(base);
  const onHead = unreadIn(head);
  // The side each withheld path failed on; a partner path takes the side of the file it pairs with.
  const sides = new Map<string, "base" | "head" | "both">();
  for (const path of new Set([...onBase, ...onHead])) sides.set(path, onBase.has(path) ? (onHead.has(path) ? "both" : "base") : "head");
  const partners = (unread: ReadonlySet<string>, own: ReadonlyMap<string, string>, other: ReadonlyMap<string, string>, side: "base" | "head"): void => {
    for (const path of unread) {
      if (other.has(path)) continue;
      const digest = own.get(path);
      for (const [counterpart, theirs] of other) if (theirs === digest && !own.has(counterpart) && !sides.has(counterpart)) sides.set(counterpart, side);
    }
  };
  partners(onBase, was, now, "base");
  partners(onHead, now, was, "head");
  const paths = [...sides.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const withheld = new Set(paths);
  if (paths.length === 0) return { base, head, unread: [], withheld };
  const strip = (graph: Graph): Graph => {
    const pathOf = new Map<NodeId, string>(graph.nodes.map((node) => [node.id, node.path]));
    const inside = (id: NodeId): boolean => withheld.has(pathOf.get(id) ?? "");
    const nodes = graph.nodes.flatMap((node): ModuleNode[] => {
      if (isCodeNode(node)) return withheld.has(node.path) ? [] : [node];
      if (node.level !== "file" || !withheld.has(node.path)) return [node];
      return [{ id: node.id, level: node.level, path: node.path, name: node.name, parent: node.parent, lines: node.lines, analysis: "not fully read", role: node.role, digest: node.digest }];
    });
    return {
      ...graph,
      nodes,
      edges: graph.edges.filter((edge) => !inside(edge.from)),
      resolutions: graph.resolutions.filter((edge) => !inside(edge.from)),
      imports: graph.imports.filter((edge) => !inside(edge.from)),
    };
  };
  // Every withheld file is listed, a file that fails the same way on both sides too: what the review says of the rest is only true of the files that could be read.
  const unread = paths.map((path): UnreadFile => ({ path, side: sides.get(path)! }));
  return { base: strip(base), head: strip(head), unread, withheld };
}

const without = (tree: FileTree, paths: ReadonlySet<string>): FileTree => new Map([...tree].filter(([path]) => !paths.has(path)));

/**
 * Both trees extracted, made equal on the files neither can fully read, and compared. Every caller that compares two trees goes through this.
 * `baseTree` and `headTree` are the trees without the withheld files, for every derived fact that reads text (the test changes): an unread file has no tests to weaken.
 */
export function readableComparison(baseTree: FileTree, headTree: FileTree): { readonly baseGraph: Graph; readonly graph: Graph; readonly comparison: Comparison; readonly baseTree: FileTree; readonly headTree: FileTree } {
  const made = withholdUnread(extract(baseTree), extract(headTree));
  return {
    baseGraph: made.base,
    graph: made.head,
    comparison: compare(made.base, made.head, { base: baseTree, head: headTree }, made.unread),
    baseTree: without(baseTree, made.withheld),
    headTree: without(headTree, made.withheld),
  };
}
