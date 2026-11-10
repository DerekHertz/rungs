import { compareIds, isCodeNode, lineCount } from "./graph.ts";
import type { Graph, LineRange, ModuleNode, NodeId } from "./graph.ts";

export interface Rect {
  readonly id: NodeId;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly depth: number;
}

export const INSET = 2;
export const LABEL_BAND = 14;
export const GENERATED_WEIGHT = 40;

export function reservesLabelBand(rect: { readonly w: number; readonly h: number }): boolean {
  return rect.w > 3 * LABEL_BAND && rect.h > 3 * LABEL_BAND;
}

interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** A node to place, or null for lines no child covers: placed, never emitted. */
interface Weighted {
  readonly node: ModuleNode | null;
  readonly weight: number;
}

/** A file's area in the picture: its lines, at least 1, with generated files capped. */
export function leafWeight(node: ModuleNode): number {
  const lines = Math.max(lineCount(node), 1);
  return node.level === "file" && node.role === "generated" ? Math.min(lines, GENERATED_WEIGHT) : lines;
}

/** The lines of `range` that lie in none of `children`; a line two children share counts once. */
export function ownLines(range: LineRange, children: readonly LineRange[]): number {
  let covered = 0;
  let reached = range.start - 1;
  for (const child of [...children].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const start = Math.max(child.start, reached + 1);
    const end = Math.min(child.end, range.end);
    if (end >= start) covered += end - start + 1;
    reached = Math.max(reached, end);
  }
  return range.end - range.start + 1 - covered;
}

function rangeOf(node: ModuleNode): LineRange | undefined {
  if (isCodeNode(node)) return node.range;
  return node.level === "file" ? { start: 1, end: node.lines } : undefined;
}

/**
 * Squarified treemap of `root` and everything below it, filling the viewport at depth 0. The
 * positions depend only on the arguments. A package or folder places all its children. A file,
 * class or function places its classes and functions only when its box reserves a label band, and
 * gives the lines they do not cover a share of the box that is left empty, so the node's own fill
 * shows through and nothing is drawn that is not a node.
 */
export function layout(graph: Graph, root: NodeId, width: number, height: number): Rect[] {
  const nodes = new Map<NodeId, ModuleNode>();
  const children = new Map<NodeId, ModuleNode[]>();
  for (const node of graph.nodes) {
    nodes.set(node.id, node);
    if (node.parent === null) continue;
    const siblings = children.get(node.parent) ?? [];
    siblings.push(node);
    children.set(node.parent, siblings);
  }
  const top = nodes.get(root);
  if (top === undefined) throw new Error(`layout root is not in the graph: ${root}`);

  const weights = new Map<NodeId, number>();
  const weightOf = (node: ModuleNode): number => {
    const known = weights.get(node.id);
    if (known !== undefined) return known;
    const below = children.get(node.id)?.filter((child) => !isCodeNode(child));
    const weight =
      isCodeNode(node) || node.level === "file" || below === undefined || below.length === 0
        ? leafWeight(node)
        : below.reduce((sum, child) => sum + weightOf(child), 0);
    weights.set(node.id, weight);
    return weight;
  };

  const itemsBelow = (node: ModuleNode, box: Box): Weighted[] => {
    const below = children.get(node.id) ?? [];
    const range = rangeOf(node);
    if (range === undefined) return below.map((child) => ({ node: child, weight: weightOf(child) }));
    if (!reservesLabelBand(box)) return [];
    const items: Weighted[] = below.map((child) => ({ node: child, weight: weightOf(child) }));
    const own = ownLines(range, below.filter(isCodeNode).map((child) => child.range));
    if (items.length > 0 && own > 0) items.push({ node: null, weight: own });
    return items;
  };

  const rects: Rect[] = [];
  const place = (node: ModuleNode, box: Box, depth: number): void => {
    rects.push({ id: node.id, ...box, depth });
    const items = itemsBelow(node, box);
    if (items.length === 0) return;
    items.sort(
      (a, b) =>
        b.weight - a.weight ||
        Number(a.node === null) - Number(b.node === null) ||
        (a.node && b.node ? compareIds(a.node.id, b.node.id) : 0),
    );
    for (const [child, childBox] of squarify(items, inner(box))) {
      if (child !== null) place(child, childBox, depth + 1);
    }
  };

  place(top, { x: 0, y: 0, w: width, h: height }, 0);
  return rects;
}

function inner(box: Box): Box {
  const top = reservesLabelBand(box) ? LABEL_BAND : INSET;
  if (box.w <= 2 * INSET || box.h <= top + INSET) return box;
  return { x: box.x + INSET, y: box.y + top, w: box.w - 2 * INSET, h: box.h - top - INSET };
}

// Squarified treemap (Bruls, Huizing and van Wijk, 2000): fill rows along the shorter side of
// the remaining box while adding an item does not worsen the row's worst aspect ratio.
function squarify(items: readonly Weighted[], box: Box): [ModuleNode | null, Box][] {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  const scale = (box.w * box.h) / total;
  const placed: [ModuleNode | null, Box][] = [];
  let remaining = box;
  let row: { node: ModuleNode | null; area: number }[] = [];

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
