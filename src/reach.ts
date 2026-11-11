import type { Picture } from "./compare.ts";
import { isCodeNode, resourcesOf } from "./graph.ts";
import type { ModuleNode, NodeId, ResourceKind } from "./graph.ts";

/** The resources a file, class or function reaches, and the ones a new edge (under a comparison) reaches. */
export interface Reach {
  readonly kinds: readonly ResourceKind[];
  readonly fresh: readonly ResourceKind[];
}

/**
 * For each file, class and function with an effect edge in or below it, the resources it reaches.
 * An edge counts for its owner and every class or function around it, up to its file.
 */
export function reachMap(picture: Picture): ReadonlyMap<NodeId, Reach> {
  const { graph, overlay } = picture;
  const nodes = new Map<NodeId, ModuleNode>(graph.nodes.map((node) => [node.id, node]));
  const found = new Map<NodeId, { kinds: Set<ResourceKind>; fresh: Set<ResourceKind> }>();
  for (const edge of graph.edges) {
    const kind = edge.to.slice("resource:".length) as ResourceKind;
    const fresh = overlay?.freshEdge(edge) ?? false;
    for (let node = nodes.get(edge.from); node !== undefined; node = isCodeNode(node) ? nodes.get(node.parent) : undefined) {
      const reach = found.get(node.id) ?? { kinds: new Set(), fresh: new Set() };
      reach.kinds.add(kind);
      if (fresh) reach.fresh.add(kind);
      found.set(node.id, reach);
      if (!isCodeNode(node)) break;
    }
  }
  const inOrder = (kinds: ReadonlySet<ResourceKind>): ResourceKind[] => resourcesOf(graph).filter((kind) => kinds.has(kind));
  return new Map([...found].map(([id, reach]) => [id, { kinds: inOrder(reach.kinds), fresh: inOrder(reach.fresh) }]));
}
