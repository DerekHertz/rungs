import type { Change, Picture, Tally } from "./compare.ts";
import { isCodeNode, resourcesOf } from "./graph.ts";
import type { Graph, ModuleNode, NodeId, ResourceKind, Role } from "./graph.ts";
import { layout, leafWeight } from "./layout.ts";
import type { Rect } from "./layout.ts";

/** The ground plan is laid out at this logical size whatever the window is. */
export const PLAN_WIDTH = 960;
export const PLAN_DEPTH = 600;

/** How thick a district's plate is. A nested district stands on its parent's plate. */
export const PLATE_HEIGHT = 2.5;

/** A building with the repository's fewest classes and functions, kept visible above its plate. */
export const MIN_HEIGHT = 5;
/** The thinnest slice of an altered building that is drawn as changed, so one changed function in a big file still shows. */
export const BAND_MIN = 5;
/** The most, a quarter of the plan's depth. */
export const MAX_HEIGHT = PLAN_DEPTH / 4;

/** Each side of a lot is pulled in by this share of the lot's shorter side. */
export const FOOTPRINT_INSET = 0.05;

/** Breaks a tie between roles covering equally many lines; a district with no role comes last. */
export const ROLE_ORDER: readonly Role[] = ["source", "tests", "docs", "config", "generated"];

/** The resource plates stand in a row this far beyond the plan's far edge, each this big, this far apart. */
export const RESOURCE_PLATE = { w: 130, d: 70, gap: 40, offset: 48, height: 6 };

/** An outside resource: a low plate at the edge of the picture, for every kind some effect edge reaches. */
export interface Resource {
  readonly kind: ResourceKind;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly d: number;
  /** The files with an edge to it, and under a comparison how many of those have a new one. */
  readonly files: number;
  readonly fresh: number;
}

/** The resources a file, class or function reaches, and the ones a new edge (under a comparison) reaches. */
export interface Reach {
  readonly kinds: readonly ResourceKind[];
  readonly fresh: readonly ResourceKind[];
}

const NO_REACH: Reach = { kinds: [], fresh: [] };

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
  /** A district that stood in the base and is gone: drawn as an outline. */
  readonly ghost: boolean;
  /** The changed files below, by kind; null when the picture is not a comparison. */
  readonly tally: Tally | null;
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
  /** Null when the picture is not a comparison. A removed file is a ghost building. */
  readonly change: Change | null;
  /** The file's changed classes and functions, by kind; null when not a comparison. */
  readonly tally: Tally | null;
  /**
   * How much of the roof end of an altered file is drawn as changed: the share of its floors
   * (classes and functions) that are altered or added. Absent for any other file.
   */
  readonly band?: number;
  /** What the file's own and nested code reaches. */
  readonly reach: Reach;
}

/** The smallest and largest number of classes and functions in a file of the repository, generated files left out. */
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
  /** In RESOURCE_ORDER, left to right, beyond the plan's far edge; none when the graph has no effect edges. */
  readonly resources: readonly Resource[];
  /** What the heights were scaled between, for the legend. */
  readonly counts: CountRange;
  /** The height of the tallest building's roof. */
  readonly top: number;
  /** True when the picture is a comparison. */
  readonly compared: boolean;
}

/**
 * Height grows with the square root of a file's classes and functions, measured from the
 * repository's fewest to its most, so one huge file leaves the rest distinguishable. When every
 * file has the same count there is nothing to compare and all sit at the minimum. Generated files
 * are not part of the measure: the caller leaves them out of `counts` and draws them at MIN_HEIGHT.
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

/** What `id` reaches: nothing for a node with no edge in or below it, never its file's reach. */
export function reachOf(reaches: ReadonlyMap<NodeId, Reach>, id: NodeId): Reach {
  return reaches.get(id) ?? NO_REACH;
}

export function withoutCode(graph: Graph): Graph {
  return { ...graph, nodes: graph.nodes.filter((node) => !isCodeNode(node)) };
}

/**
 * The city of everything below `root`. The ground plan is the squarified layout of the graph
 * without its classes and functions, which are not drawn here.
 */
export function cityOf(picture: Picture, root: NodeId): City {
  return buildCity(picture, layout(withoutCode(picture.graph), root, PLAN_WIDTH, PLAN_DEPTH));
}

/**
 * The height of the changed slice of an altered file of `height`, which has `floors` classes and
 * functions: their altered and added ones take that share of the height, never less than BAND_MIN.
 * A function that was removed has no floor left, and a file with no code (or all of it changed) is
 * changed throughout.
 */
export function changedBand(height: number, floors: number, tally: Tally): number {
  if (floors === 0) return height;
  const share = (height * Math.min(tally.altered + tally.added, floors)) / floors;
  return Math.min(height, Math.max(BAND_MIN, share));
}

/** `rects` are a layout of `picture.graph`; the rects of classes and functions are ignored. */
export function buildCity(picture: Picture, rects: readonly Rect[]): City {
  const { graph, overlay } = picture;
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
  const isGenerated = (file: ModuleNode): boolean => file.level === "file" && file.role === "generated";
  const scale = heightScale(
    files.filter((rect) => !isGenerated(nodes.get(rect.id)!)).map((rect) => countOf(nodes.get(rect.id)!.path)),
  );

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
      ghost: overlay?.change(rect.id) === "removed",
      tally: overlay?.tally(rect.id) ?? null,
    });
  }

  const reaches = reachMap(picture);
  const buildings: Building[] = [];
  for (const rect of files) {
    const file = nodes.get(rect.id)!;
    const parentLevel = file.parent === null ? undefined : levels.get(file.parent);
    const inset = FOOTPRINT_INSET * Math.min(rect.w, rect.h);
    const height = isGenerated(file) ? MIN_HEIGHT : scale.height(countOf(file.path));
    const change = overlay?.change(rect.id) ?? null;
    const tally = overlay?.tally(rect.id) ?? null;
    buildings.push({
      id: rect.id,
      name: file.name,
      x: rect.x + inset,
      y: rect.y + inset,
      w: rect.w - 2 * inset,
      d: rect.h - 2 * inset,
      base: parentLevel === undefined ? 0 : (parentLevel + 1) * PLATE_HEIGHT,
      height,
      role: file.level === "file" ? file.role : null,
      analysed: file.level === "file" && file.analysis === "analysed",
      classes: classes.get(file.path) ?? 0,
      functions: functions.get(file.path) ?? 0,
      change,
      tally,
      ...(change === "altered" && tally !== null ? { band: changedBand(height, countOf(file.path), tally) } : {}),
      reach: reaches.get(rect.id) ?? NO_REACH,
    });
  }

  const kinds = resourcesOf(graph);
  const rowWidth = kinds.length * RESOURCE_PLATE.w + (kinds.length - 1) * RESOURCE_PLATE.gap;
  const resources = kinds.map((kind, index): Resource => ({
    kind,
    x: (PLAN_WIDTH - rowWidth) / 2 + index * (RESOURCE_PLATE.w + RESOURCE_PLATE.gap),
    y: PLAN_DEPTH + RESOURCE_PLATE.offset,
    w: RESOURCE_PLATE.w,
    d: RESOURCE_PLATE.d,
    files: buildings.filter((building) => building.reach.kinds.includes(kind)).length,
    fresh: buildings.filter((building) => building.reach.fresh.includes(kind)).length,
  }));

  return {
    width: PLAN_WIDTH,
    depth: PLAN_DEPTH,
    districts,
    buildings,
    resources,
    counts: { fewest: scale.fewest, most: scale.most },
    top: buildings.reduce((top, building) => Math.max(top, building.base + building.height), 0),
    compared: overlay !== null,
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
