import { isCodeNode } from "./graph.ts";
import type { Graph, ImportEdge, ModuleNode, NodeId } from "./graph.ts";

/*
 * Importance and reach, both from the import edges alone (SPEC, The graph). A type-only import
 * counts: the file that holds it stops compiling when the file it names stops, so it rests on it,
 * and a file only types reach is still reached. Edges to outside packages and unresolved ones
 * name no file and are left out.
 */

export interface WayIn {
  readonly id: NodeId;
  readonly path: string;
  /** Why this file is a way in, sorted: `package.json main`, `package.json bin`, `package.json exports`, `package.json scripts.test`, `test file`. */
  readonly reasons: readonly string[];
}

function fileEdges(graph: Graph): { forward: Map<NodeId, NodeId[]>; backward: Map<NodeId, NodeId[]> } {
  const forward = new Map<NodeId, NodeId[]>();
  const backward = new Map<NodeId, NodeId[]>();
  for (const edge of graph.imports) {
    if (!("file" in edge.target) || edge.target.file === edge.from) continue;
    forward.set(edge.from, [...(forward.get(edge.from) ?? []), edge.target.file]);
    backward.set(edge.target.file, [...(backward.get(edge.target.file) ?? []), edge.from]);
  }
  return { forward, backward };
}

/** Every file reachable from `starts` along `next`; a start is in it only when a cycle leads back to it. */
function closure(starts: Iterable<NodeId>, next: ReadonlyMap<NodeId, readonly NodeId[]>): Set<NodeId> {
  const seen = new Set<NodeId>();
  const stack = [...starts];
  while (stack.length > 0) {
    for (const to of next.get(stack.pop()!) ?? []) {
      if (seen.has(to)) continue;
      seen.add(to);
      stack.push(to);
    }
  }
  return seen;
}

/**
 * For each file, the files that rest on it: those that import it, directly or through others.
 * Never the file itself. The count is the list's length; a file nothing rests on has no entry.
 * Each list is sorted by id.
 */
export function importanceOf(graph: Graph): Map<NodeId, NodeId[]> {
  const { backward } = fileEdges(graph);
  const rests = new Map<NodeId, NodeId[]>();
  for (const id of backward.keys()) {
    const above = closure([id], backward);
    above.delete(id);
    if (above.size > 0) rests.set(id, [...above].sort());
  }
  return rests;
}

/**
 * The files with a footpath: those some way in reaches through imports (the ways in themselves
 * included), and every file that is not code, which imports never reach and so is never judged by
 * them. Code is a file a language adapter analyses.
 */
export function reachedFrom(graph: Graph, waysIn: readonly NodeId[]): Set<NodeId> {
  const { forward } = fileEdges(graph);
  const reached = closure(waysIn, forward);
  for (const id of waysIn) reached.add(id);
  // A file that could not be fully read is code: it has a footpath only when a way in reaches it.
  for (const node of graph.nodes) if (node.level === "file" && node.analysis === "not analysed") reached.add(node.id);
  return reached;
}

/**
 * The code files no way in is known to reach, but that a way in may reach through a file that
 * could not be fully read: its imports are unknown, so once a way in reaches one, any other file
 * may be reached through it. Reach of these is unknown, not known and not known absent.
 */
export function possiblyReachedFrom(graph: Graph, waysIn: readonly NodeId[]): Set<NodeId> {
  const reached = reachedFrom(graph, waysIn);
  const possible = new Set<NodeId>();
  if (!graph.nodes.some((node) => node.level === "file" && node.analysis === "not fully read" && reached.has(node.id))) return possible;
  for (const node of graph.nodes) if (node.level === "file" && !reached.has(node.id)) possible.add(node.id);
  return possible;
}

/** "1 file rests on it", "N files rest on it"; with files that could not be read, "at least N files rest on it, plus unknown via K unread files". */
export function restsText(known: number, unread = 0): string {
  const base = `${known} ${known === 1 ? "file rests" : "files rest"} on it`;
  return unread === 0 ? base : `at least ${base}, plus unknown via ${unread} unread ${unread === 1 ? "file" : "files"}`;
}

/**
 * The files that could not be fully read and are not already known to rest on `file`: each may
 * import it, so they are the "plus unknown" of any count of what rests on it. `known` is the
 * files counted; `file` itself and the files at `also` (its other path) are never one.
 */
export function unknownRestOf(graph: Graph, file: NodeId, known: Iterable<NodeId>, also: readonly string[] = []): NodeId[] {
  const counted = new Set<NodeId>([file, ...known]);
  const paths = new Set(also);
  return graph.nodes.flatMap((node) => (node.level === "file" && node.analysis === "not fully read" && !counted.has(node.id) && !paths.has(node.path) ? [node.id] : []));
}

/** The files that rest on `file` through the names `of` it, or through any name when `of` is "all". Never the file itself. */
export type ExportRadius = (file: NodeId, of: readonly string[] | "all") => NodeId[];

/**
 * Blast radius per export (SPEC, The graph: Edges, Importance). An import edge records the names
 * it takes (`ImportEdge.names`), so a changed export's dependents are the files whose edge into
 * the file takes that name or all of them, found again through each `export ... from` that passes
 * the name on (under the name it gives it; `export *` never passes `default`), plus the files
 * resting on those by import, directly or not. A file that only re-exports a name rests on it
 * for that name alone: its other importers are not counted. Anything the extractor could not
 * read as a name is "all", so no file is undercounted; asking for "all" is `importanceOf`.
 */
export function exportRadiusOf(graph: Graph): ExportRadius {
  const { backward } = fileEdges(graph);
  const into = new Map<NodeId, ImportEdge[]>();
  for (const edge of graph.imports) {
    if (!("file" in edge.target) || (edge.target.file === edge.from && edge.reexports === undefined)) continue;
    into.set(edge.target.file, [...(into.get(edge.target.file) ?? []), edge]);
  }
  return (file, of) => {
    if (of === "all") {
      const above = closure([file], backward);
      above.delete(file);
      return [...above].sort();
    }
    const direct = new Set<NodeId>();
    const passed = new Set<NodeId>();
    const seen = new Set<string>();
    const queue: [NodeId, string][] = of.map((name) => [file, name]);
    while (queue.length > 0) {
      const [at, name] = queue.pop()!;
      const key = `${at}\0${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      for (const edge of into.get(at) ?? []) {
        const { reexports } = edge;
        if (reexports === undefined) {
          if (edge.names === "all" || edge.names.includes(name)) direct.add(edge.from);
        } else if (reexports === "star") {
          if (name === "default") continue;
          passed.add(edge.from);
          queue.push([edge.from, name]);
        } else {
          for (const pass of reexports) {
            if (pass.name !== name && pass.name !== "*") continue;
            passed.add(edge.from);
            queue.push([edge.from, pass.as]);
          }
        }
      }
    }
    const rest = closure(direct, backward);
    for (const id of [...direct, ...passed]) rest.add(id);
    rest.delete(file);
    return [...rest].sort();
  };
}

/**
 * The names the exported ones of `nodes` (a block's head and base forms) are exported under, or
 * "all" when that is not known: a node the extractor wrote no names for, `*` (any name reaches
 * it), or none exported at all.
 */
export function exportNamesOf(nodes: readonly ModuleNode[]): readonly string[] | "all" {
  const names = new Set<string>();
  for (const node of nodes) {
    if (!isCodeNode(node) || !node.exported) continue;
    if (node.exportedAs === undefined || node.exportedAs.includes("*")) return "all";
    for (const name of node.exportedAs) names.add(name);
  }
  return names.size === 0 ? "all" : [...names].sort();
}
