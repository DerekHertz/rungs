import type { NodeId } from "./graph.ts";

/** Where a double-click on the district `hit` flies while `focus` fills the window: to `hit`, or nowhere if it already does. */
export function flyTarget(focus: NodeId, hit: NodeId): NodeId | undefined {
  return hit === focus ? undefined : hit;
}
