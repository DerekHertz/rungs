import type { NodeId, ResourceKind } from "./graph.ts";
import type { Reach } from "./reach.ts";
import type { Lot, Pier } from "./town.ts";

/*
 * What the town says about outside calls, as pure facts: which buildings carry the mark for a new
 * call out (#130), and which lines run from a building to the harbour structures it reaches
 * (#131). The page only draws them.
 */

/**
 * The files that carry the mark of a new call to the outside world: a changed file (altered or
 * added) with a new effect edge in it. A removed or moved file, and any file when nothing is
 * compared, has none. The mark names nothing: where a call goes is named inside the file, and only
 * in a file that already existed (SPEC, Review).
 */
export function callsOut(lots: readonly Pick<Lot, "id" | "change">[], reaches: ReadonlyMap<NodeId, Reach>): ReadonlySet<NodeId> {
  return new Set(lots.filter((lot) => (lot.change === "altered" || lot.change === "added") && (reaches.get(lot.id)?.fresh.length ?? 0) > 0).map((lot) => lot.id));
}

/** One line from a building to a harbour structure. `fresh` lines are drawn bright, the rest dim. */
export interface ReachLine {
  readonly kind: ResourceKind;
  readonly X: number;
  readonly Y: number;
  readonly fresh: boolean;
}

/**
 * A line for each resource kind the building reaches that has a harbour structure, in the
 * harbour's order. Under a comparison a line is bright only for a new edge; with none, every
 * line is bright, since nothing is old against nothing.
 */
export function reachLines(reach: Reach | undefined, piers: readonly Pier[], comparing: boolean): ReachLine[] {
  if (reach === undefined) return [];
  return piers.filter((pier) => reach.kinds.includes(pier.kind)).map((pier) => ({ kind: pier.kind, X: pier.X, Y: pier.Y, fresh: !comparing || reach.fresh.includes(pier.kind) }));
}

interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * The part of a segment inside the screen, less `margin` on each side, and whether its far end
 * was cut off. A harbour structure far out of view therefore still shows the direction of the
 * line, ending at the edge (the 3D city drew these off the screen, #53). Nothing when no part is on screen.
 */
export function clipToView(from: Point, to: Point, view: { width: number; height: number }, margin: number): { from: Point; to: Point; cut: boolean } | undefined {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  let t0 = 0;
  let t1 = 1;
  const edges: [number, number][] = [
    [-dx, from.x - margin],
    [dx, view.width - margin - from.x],
    [-dy, from.y - margin],
    [dy, view.height - margin - from.y],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return undefined;
    } else {
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
    }
  }
  if (t0 > t1) return undefined;
  const at = (t: number): Point => ({ x: Math.round(from.x + dx * t), y: Math.round(from.y + dy * t) });
  return { from: t0 === 0 ? from : at(t0), to: t1 === 1 ? to : at(t1), cut: t1 < 1 };
}
