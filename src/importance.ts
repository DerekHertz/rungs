import type { Graph, NodeId } from "./graph.ts";

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
  for (const node of graph.nodes) if (node.level === "file" && node.analysis !== "analysed") reached.add(node.id);
  return reached;
}
