import { isCodeNode } from "./graph.ts";
import type { Graph, ModuleNode, NodeId, Role } from "./graph.ts";
import { layout, leafWeight } from "./layout.ts";
import type { Rect } from "./layout.ts";

/** The ground plan is laid out at this logical size whatever the window is. */
export const PLAN_WIDTH = 960;
export const PLAN_DEPTH = 600;

/** How thick a district's plate is. A nested district stands on its parent's plate. */
export const PLATE_HEIGHT = 2.5;

/** A building with the repository's fewest classes and functions, kept visible above its plate. */
export const MIN_HEIGHT = 5;
/** The most, a quarter of the plan's depth. */
export const MAX_HEIGHT = PLAN_DEPTH / 4;

/** Each side of a lot is pulled in by this share of the lot's shorter side. */
export const FOOTPRINT_INSET = 0.05;

/** Breaks a tie between roles covering equally many lines; a district with no role comes last. */
export const ROLE_ORDER: readonly Role[] = ["source", "tests", "docs", "config", "generated"];

/** A package or folder: a raised plate on its rect of the ground plan. */
export interface District {
  readonly id: NodeId;
  /** For display only. */
  readonly name: string;
  /** The district this one stands on; null for the root. */
  readonly parent: NodeId | null;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly d: number;
  /** 0 for the root; one more than the district it stands on. */
  readonly level: number;
  /** The height of the underside of the plate. */
  readonly base: number;
  /** The role covering the most lines below, or null when no file below has one. */
  readonly role: Role | null;
}

/** A file: a box on its lot, standing on its district's plate. */
export interface Building {
  readonly id: NodeId;
  /** The file's name, for display only. */
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly d: number;
  readonly base: number;
  readonly height: number;
  readonly role: Role | null;
  /** False for a file no language adapter read; SPEC rule 5 says it is drawn as exactly that. */
  readonly analysed: boolean;
  readonly classes: number;
  readonly functions: number;
}

/** The smallest and largest number of classes and functions in a file of the repository. */
export interface CountRange {
  readonly fewest: number;
  readonly most: number;
}

export interface HeightScale extends CountRange {
  height(count: number): number;
}

/** What the renderer draws, in plan units: x across, y down the plan, heights up. */
export interface City {
  readonly width: number;
  readonly depth: number;
  /** Parents before the districts inside them. */
  readonly districts: readonly District[];
  readonly buildings: readonly Building[];
  /** What the heights were scaled between, for the legend. */
  readonly counts: CountRange;
  /** The height of the tallest building's roof. */
  readonly top: number;
}

/**
 * Height grows with the square root of a file's classes and functions, measured from the
 * repository's fewest to its most, so one huge file leaves the rest distinguishable. When every
 * file has the same count there is nothing to compare and all sit at the minimum.
 */
export function heightScale(counts: readonly number[]): HeightScale {
  let fewest = counts.length === 0 ? 0 : Infinity;
  let most = counts.length === 0 ? 0 : -Infinity;
  for (const count of counts) {
    fewest = Math.min(fewest, count);
    most = Math.max(most, count);
  }
  return {
    fewest,
    most,
    height(count) {
      if (most === fewest) return MIN_HEIGHT;
      const share = Math.min(1, Math.max(0, (count - fewest) / (most - fewest)));
      return MIN_HEIGHT + (MAX_HEIGHT - MIN_HEIGHT) * Math.sqrt(share);
    },
  };
}

export function withoutCode(graph: Graph): Graph {
  return { ...graph, nodes: graph.nodes.filter((node) => !isCodeNode(node)) };
}

/**
 * The city of everything below `root`. The ground plan is the squarified layout of the graph
 * without its classes and functions, which are not drawn here.
 */
export function cityOf(graph: Graph, root: NodeId): City {
  return buildCity(graph, layout(withoutCode(graph), root, PLAN_WIDTH, PLAN_DEPTH));
}

/** `rects` are a layout of `graph`; the rects of classes and functions are ignored. */
export function buildCity(graph: Graph, rects: readonly Rect[]): City {
  const nodes = new Map<NodeId, ModuleNode>(graph.nodes.map((node) => [node.id, node]));
  const classes = new Map<string, number>();
  const functions = new Map<string, number>();
  for (const node of graph.nodes) {
    if (node.level === "class") classes.set(node.path, (classes.get(node.path) ?? 0) + 1);
    else if (node.level === "function") functions.set(node.path, (functions.get(node.path) ?? 0) + 1);
  }

  const lots = rects.filter((rect) => !isCodeNode(nodes.get(rect.id)!));
  const files = lots.filter((rect) => nodes.get(rect.id)!.level === "file");
  const levels = new Map<NodeId, number>();
  for (const rect of lots) if (nodes.get(rect.id)!.level !== "file") levels.set(rect.id, rect.depth);

  const roles = dominantRoles(files.map((rect) => nodes.get(rect.id)!), nodes);
  const countOf = (path: string): number => (classes.get(path) ?? 0) + (functions.get(path) ?? 0);
  const scale = heightScale(files.map((rect) => countOf(nodes.get(rect.id)!.path)));

  const districts: District[] = [];
  for (const rect of lots) {
    if (nodes.get(rect.id)!.level === "file") continue;
    const container = nodes.get(rect.id)!;
    districts.push({
      id: rect.id,
      name: container.name,
      parent: container.parent,
      x: rect.x,
      y: rect.y,
      w: rect.w,
      d: rect.h,
      level: rect.depth,
      base: rect.depth * PLATE_HEIGHT,
      role: roles.get(rect.id) ?? null,
    });
  }

  const buildings: Building[] = [];
  for (const rect of files) {
    const file = nodes.get(rect.id)!;
    const parentLevel = file.parent === null ? undefined : levels.get(file.parent);
    const inset = FOOTPRINT_INSET * Math.min(rect.w, rect.h);
    buildings.push({
      id: rect.id,
      name: file.name,
      x: rect.x + inset,
      y: rect.y + inset,
      w: rect.w - 2 * inset,
      d: rect.h - 2 * inset,
      base: parentLevel === undefined ? 0 : (parentLevel + 1) * PLATE_HEIGHT,
      height: scale.height(countOf(file.path)),
      role: file.level === "file" ? file.role : null,
      analysed: file.level === "file" && file.analysis === "analysed",
      classes: classes.get(file.path) ?? 0,
      functions: functions.get(file.path) ?? 0,
    });
  }

  return {
    width: PLAN_WIDTH,
    depth: PLAN_DEPTH,
    districts,
    buildings,
    counts: { fewest: scale.fewest, most: scale.most },
    top: buildings.reduce((top, building) => Math.max(top, building.base + building.height), 0),
  };
}

/** For each package and folder, the role covering the most lines below it. */
function dominantRoles(files: readonly ModuleNode[], nodes: ReadonlyMap<NodeId, ModuleNode>): Map<NodeId, Role | null> {
  const totals = new Map<NodeId, Map<Role | null, number>>();
  for (const file of files) {
    if (file.level !== "file") continue;
    const weight = leafWeight(file);
    for (let id: NodeId | null = file.parent; id !== null; id = nodes.get(id)?.parent ?? null) {
      const byRole = totals.get(id) ?? new Map<Role | null, number>();
      byRole.set(file.role, (byRole.get(file.role) ?? 0) + weight);
      totals.set(id, byRole);
    }
  }
  const dominant = new Map<NodeId, Role | null>();
  for (const [id, byRole] of totals) {
    let best: Role | null = null;
    let bestLines = 0;
    for (const role of [...ROLE_ORDER, null]) {
      const lines = byRole.get(role) ?? 0;
      if (lines > bestLines) [best, bestLines] = [role, lines];
    }
    dominant.set(id, best);
  }
  return dominant;
}
