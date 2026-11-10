import { compareIds } from "./graph.ts";
import type { Graph, ModuleNode, NodeId } from "./graph.ts";

export interface Rect {
  readonly id: NodeId;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly depth: number;
}

const INSET = 2;
export const LABEL_BAND = 14;

export function reservesLabelBand(rect: { readonly w: number; readonly h: number }): boolean {
  return rect.w > 3 * LABEL_BAND && rect.h > 3 * LABEL_BAND;
}

interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

interface Weighted {
  readonly node: ModuleNode;
  readonly weight: number;
}

export function layout(graph: Graph, width: number, height: number): Rect[] {
  const children = new Map<NodeId | null, ModuleNode[]>();
  for (const node of graph.nodes) {
    const siblings = children.get(node.parent) ?? [];
    siblings.push(node);
    children.set(node.parent, siblings);
  }

  const weights = new Map<NodeId, number>();
  const weightOf = (node: ModuleNode): number => {
    const known = weights.get(node.id);
    if (known !== undefined) return known;
    const below = children.get(node.id);
    const weight =
      node.level === "file" || below === undefined
        ? Math.max(node.lines, 1)
        : below.reduce((sum, child) => sum + weightOf(child), 0);
    weights.set(node.id, weight);
    return weight;
  };

  const rects: Rect[] = [];
  const place = (node: ModuleNode, box: Box, depth: number): void => {
    rects.push({ id: node.id, ...box, depth });
    const below = children.get(node.id);
    if (below === undefined) return;
    const ordered = below
      .map((child) => ({ node: child, weight: weightOf(child) }))
      .sort((a, b) => b.weight - a.weight || compareIds(a.node.id, b.node.id));
    for (const [child, childBox] of squarify(ordered, inner(box))) place(child, childBox, depth + 1);
  };

  for (const root of children.get(null) ?? []) place(root, { x: 0, y: 0, w: width, h: height }, 0);
  return rects;
}

function inner(box: Box): Box {
  const top = reservesLabelBand(box) ? LABEL_BAND : INSET;
  if (box.w <= 2 * INSET || box.h <= top + INSET) return box;
  return { x: box.x + INSET, y: box.y + top, w: box.w - 2 * INSET, h: box.h - top - INSET };
}

// Squarified treemap (Bruls, Huizing and van Wijk, 2000): fill rows along the shorter side of
// the remaining box while adding an item does not worsen the row's worst aspect ratio.
function squarify(items: readonly Weighted[], box: Box): [ModuleNode, Box][] {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  const scale = (box.w * box.h) / total;
  const placed: [ModuleNode, Box][] = [];
  let remaining = box;
  let row: { node: ModuleNode; area: number }[] = [];

  const worst = (areas: readonly number[], side: number): number => {
    const sum = areas.reduce((a, b) => a + b, 0);
    return Math.max(
      (side * side * Math.max(...areas)) / (sum * sum),
      (sum * sum) / (side * side * Math.min(...areas)),
    );
  };

  const flush = (last: boolean): void => {
    const sum = row.reduce((a, item) => a + item.area, 0);
    const vertical = remaining.w >= remaining.h;
    const fill = vertical ? remaining.w : remaining.h;
    const thickness = last ? fill : Math.min(fill, vertical ? sum / remaining.h : sum / remaining.w);
    let offset = 0;
    row.forEach((item, index) => {
      const length = vertical ? remaining.h : remaining.w;
      const span = index === row.length - 1 ? length - offset : (item.area / sum) * length;
      placed.push([
        item.node,
        vertical
          ? { x: remaining.x, y: remaining.y + offset, w: thickness, h: span }
          : { x: remaining.x + offset, y: remaining.y, w: span, h: thickness },
      ]);
      offset += span;
    });
    remaining = vertical
      ? { x: remaining.x + thickness, y: remaining.y, w: remaining.w - thickness, h: remaining.h }
      : { x: remaining.x, y: remaining.y + thickness, w: remaining.w, h: remaining.h - thickness };
    row = [];
  };

  if (!(scale > 0)) return items.map((item) => [item.node, { ...box, w: 0, h: 0 }]);
  for (const item of items) {
    const area = item.weight * scale;
    const side = Math.min(remaining.w, remaining.h);
    const areas = row.map((r) => r.area);
    if (row.length > 0 && worst([...areas, area], side) > worst(areas, side)) flush(false);
    row.push({ node: item.node, area });
  }
  if (row.length > 0) flush(true);
  return placed;
}
