import { compareEdges, isCodeNode, targetText } from "./graph.ts";
import type { EffectEdge, Graph, NodeId, ResourceKind } from "./graph.ts";

// Page-safe: the review panel bundles this module, so nothing here may import node:*.

/** An effect edge that exists on one side of a comparison only. */
export interface EffectChange {
  readonly kind: "added" | "removed";
  /** As its own graph has it: the head edge for "added", the base edge for "removed". */
  readonly edge: EffectEdge;
}

export const resourceKindOf = (edge: EffectEdge): ResourceKind => edge.to.slice("resource:".length) as ResourceKind;

/** "process child_process execFileSync "git"", "network fetch (target unknown)", "timer setTimeout". */
export function effectLabel(edge: EffectEdge): string {
  const head = `${resourceKindOf(edge)} ${edge.operation}`;
  if (edge.target === "none") return head;
  return edge.target === "unknown" ? `${head} (target unknown)` : `${head} ${targetText(edge.target)}`;
}

/**
 * The effect edges that appeared or went away. An edge is the same edge when its owner (a base
 * owner followed through `movedTo`, the pairs compare recorded), resource, operation and target
 * are the same; lines are not part of it, so an edit above shifts nothing. The same edge may
 * occur several times in one owner: they match one to one in source order, and the surplus is
 * added (or removed), the later ones first to count.
 */
export function diffEffects(base: Graph, head: Graph, movedTo: ReadonlyMap<NodeId, NodeId>): EffectChange[] {
  const keyOf = (edge: EffectEdge, owner: NodeId): string =>
    `${owner}\0${edge.to}\0${edge.operation}\0${targetText(edge.target)}`;
  const before = new Map<string, EffectEdge[]>();
  for (const edge of base.edges) {
    const key = keyOf(edge, movedTo.get(edge.from) ?? edge.from);
    before.set(key, [...(before.get(key) ?? []), edge]);
  }
  const changes: EffectChange[] = [];
  const seen = new Map<string, number>();
  for (const edge of head.edges) {
    const key = keyOf(edge, edge.from);
    const index = seen.get(key) ?? 0;
    seen.set(key, index + 1);
    if (index >= (before.get(key)?.length ?? 0)) changes.push({ kind: "added", edge });
  }
  for (const [key, edges] of before) {
    for (const edge of edges.slice(seen.get(key) ?? 0)) changes.push({ kind: "removed", edge });
  }
  return changes.sort((a, b) => compareEdges(a.edge, b.edge) || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
}

/**
 * For each class and function, the labels of the effects of its own calls and of every class or
 * function written inside it, so a closure's call counts for the exported function that holds it.
 * Calls at a file's top level belong to the file and are in no set. Direct calls only: a call
 * through another function's body is not followed until call edges exist.
 */
export function effectSets(graph: Graph): ReadonlyMap<NodeId, ReadonlySet<string>> {
  const parentOf = new Map<NodeId, NodeId>();
  for (const node of graph.nodes) if (isCodeNode(node)) parentOf.set(node.id, node.parent);
  const sets = new Map<NodeId, Set<string>>();
  for (const edge of graph.edges) {
    const label = effectLabel(edge);
    for (let id: NodeId | undefined = edge.from; id !== undefined && parentOf.has(id); id = parentOf.get(id)) {
      const set = sets.get(id) ?? new Set<string>();
      set.add(label);
      sets.set(id, set);
    }
  }
  return sets;
}
