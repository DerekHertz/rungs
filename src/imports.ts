import { compareImports, importTargetText } from "./graph.ts";
import type { Graph, ImportEdge, NodeId } from "./graph.ts";

export interface ImportChange {
  readonly kind: "added" | "removed";
  readonly edge: ImportEdge;
}

/**
 * The import edges that appeared or went away. An edge is the same edge when its file and its
 * target file (both followed through `movedTo`, the pairs compare recorded), syntax and
 * type-only flag are the same; a file target is not compared by specifier, so moving a file
 * changes no edge into it, and lines are no part of it. An external or unresolved target
 * compares by its specifier. The same edge may occur several times in one file: they match one
 * to one in source order, and the surplus is added (or removed). Sorted.
 */
export function diffImports(base: Graph, head: Graph, movedTo: ReadonlyMap<NodeId, NodeId>): ImportChange[] {
  const keyOf = (edge: ImportEdge, follow: (id: NodeId) => NodeId): string => {
    const target = "file" in edge.target ? follow(edge.target.file) : `${importTargetText(edge.target)}\0${edge.specifier}`;
    return `${follow(edge.from)}\0${edge.syntax}\0${edge.typeOnly}\0${target}`;
  };
  const before = new Map<string, ImportEdge[]>();
  for (const edge of base.imports) {
    const key = keyOf(edge, (id) => movedTo.get(id) ?? id);
    before.set(key, [...(before.get(key) ?? []), edge]);
  }
  const changes: ImportChange[] = [];
  const seen = new Map<string, number>();
  for (const edge of head.imports) {
    const key = keyOf(edge, (id) => id);
    const index = seen.get(key) ?? 0;
    seen.set(key, index + 1);
    if (index >= (before.get(key)?.length ?? 0)) changes.push({ kind: "added", edge });
  }
  for (const [key, edges] of before) {
    for (const edge of edges.slice(seen.get(key) ?? 0)) changes.push({ kind: "removed", edge });
  }
  return changes.sort((a, b) => compareImports(a.edge, b.edge) || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
}
