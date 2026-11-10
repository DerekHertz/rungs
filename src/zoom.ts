import { rootOf } from "./graph.ts";
import type { Graph, ModuleNode, NodeId } from "./graph.ts";

/** The graph's nodes by id, with the root and which nodes have something inside them. */
export interface Tree {
  readonly root: NodeId;
  node(id: NodeId): ModuleNode;
  hasChildren(id: NodeId): boolean;
}

export function indexGraph(graph: Graph): Tree {
  const nodes = new Map<NodeId, ModuleNode>(graph.nodes.map((node) => [node.id, node]));
  const parents = new Set<NodeId>();
  for (const node of graph.nodes) if (node.parent !== null) parents.add(node.parent);
  return {
    root: rootOf(graph),
    node(id) {
      const node = nodes.get(id);
      if (node === undefined) throw new Error(`no node ${id}`);
      return node;
    },
    hasChildren: (id) => parents.has(id),
  };
}

/** The nodes from the top of the repository down to `id`, both included. */
export function trail(tree: Tree, id: NodeId): ModuleNode[] {
  const steps: ModuleNode[] = [];
  for (let node: ModuleNode | undefined = tree.node(id); node !== undefined; ) {
    steps.push(node);
    node = node.parent === null ? undefined : tree.node(node.parent);
  }
  return steps.reverse();
}

/** One step out from `current`; the top of the repository stays where it is. */
export function zoomOut(tree: Tree, current: NodeId): NodeId {
  return tree.node(current).parent ?? current;
}

/**
 * Where a double-click on `hit` zooms to while `current` fills the window: the nearest node from
 * `hit` upward that has something inside it, if it lies strictly inside `current`.
 */
export function zoomTarget(tree: Tree, current: NodeId, hit: NodeId): NodeId | undefined {
  let target: NodeId | undefined;
  for (let id: NodeId | null = hit; id !== null; id = tree.node(id).parent) {
    if (id === current) return target;
    if (target === undefined && tree.hasChildren(id)) target = id;
  }
  return undefined;
}
