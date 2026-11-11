import type { NodeId } from "./graph.ts";

/** Where a double-click on the district `hit` flies while `focus` fills the window: to `hit`, or nowhere if it already does. */
export function flyTarget(focus: NodeId, hit: NodeId): NodeId | undefined {
  return hit === focus ? undefined : hit;
}

/**
 * What Esc does to the camera once nothing is open: the folder to fly to, or undefined when there is nowhere to go.
 * A block framed alone (rubble whose folder is gone) is left for `focus` itself, even at the root.
 */
export function escapeStep(focus: NodeId, alone: boolean, root: NodeId, parent: (id: NodeId) => NodeId): NodeId | undefined {
  if (alone) return focus;
  return focus === root ? undefined : parent(focus);
}
