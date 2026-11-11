import { resourcesOf } from "./graph.ts";
import type { Graph, ModuleNode, NodeId, ResourceKind, Role } from "./graph.ts";
import { importanceOf, reachedFrom } from "./importance.ts";
import type { WayIn } from "./importance.ts";

/*
 * The town: a pure function from the graph (and the names of the sprites the sheet has) to
 * positions on the ground and the sprite each fact picks. Nothing here reads the window, a
 * theme's pixels or a clock, so the same graph and sheet always give the same town (SPEC, The
 * picture). The page only projects and draws it.
 *
 * Ground coordinates: X runs right and towards the viewer, Y runs right and away, in lots.
 */

/** The side of a lot, in ground units: a sprite's diamond is 2 * LOT * AXIS wide. */
export const LOT = 4.3;
/** Space around a block's lots, inside its pad. */
export const PAD = 0.5;
/** The clear ground between blocks. */
export const GAP = 3.2;
/** Harbour structures stand this far apart along the east shore. */
export const PIER_SPACING = 4.4;
/** The least the coast's wobble takes its radius to: 1 - (0.07 + 0.05 + 0.03). */
const WOBBLE_LEAST = 0.85;
/** The lawn is the coast pulled in to this share. */
const LAWN_SHARE = 0.95;
/** A chord of the 120-gon lies at least this far inside its circle. */
const CHORD = 0.99;
/** Clear ground between the outermost lot and the lawn edge. */
const ISLAND_MARGIN = 3;

/** Screen pixels per ground unit of the sheet, as the sheet was rendered (see themes/town/make_sprites.py). */
const PPU = 48;
export const AXIS = PPU * Math.SQRT1_2;
const HALF = AXIS / 2;
const RISE = PPU * Math.cos(Math.PI / 6);

/** Where a ground point (and a height in ground units) lands on the picture, at native sprite size. */
export function project(X: number, Y: number, Z = 0): { x: number; y: number } {
  return { x: (X + Y) * AXIS, y: (X - Y) * HALF - Z * RISE };
}

/** Names appear by zoom: blocks alone while a lot is narrower than this many pixels on screen, files too from then on. */
export const FILE_NAMES_FROM_LOT_PX = 200;

/** What is named at `zoom` (screen pixels per native sprite pixel): only blocks far away, files as well close in. */
export function namesAt(zoom: number): "blocks" | "files" {
  return 2 * LOT * AXIS * zoom >= FILE_NAMES_FROM_LOT_PX ? "files" : "blocks";
}

/** How tall each plinth sprite stands, in ground units (themes/town/make_sprites.py): the building on it is raised by this. */
export const PLINTH_HEIGHTS = [0.3, 0.6, 0.9, 1.2] as const;
/** On a lot, relative to its middle: the gate's gap stands this far towards the front (-Y), and a footpath's one tile runs from the door to the lot's edge. */
export const GATE_FRONT = 2.15;
export const PATH_AT = { X: -0.45, Y: -1.75 } as const;

/**
 * Where a lot's footpath tile lies on the ground. A plinth's front stair stands in the way, so the
 * path starts beyond the stair, which is one 0.3 step deep for each 0.3 of the plinth's height.
 */
export function footpathAt(lot: Pick<Lot, "X" | "Y" | "raise">): { X: number; Y: number } {
  if (lot.raise === 0) return { X: lot.X + PATH_AT.X, Y: lot.Y + PATH_AT.Y };
  return { X: lot.X, Y: lot.Y + PATH_AT.Y - lot.raise };
}

export type BuildingKind = "workshop" | "lab" | "library" | "shed" | "warehouse" | "hut";

/** The kind of building a file's role picks (SPEC: Buildings). A file with no role is a hut, never guessed. */
export function kindOfRole(role: Role | null): BuildingKind {
  switch (role) {
    case "source":
      return "workshop";
    case "tests":
      return "lab";
    case "docs":
      return "library";
    case "config":
      return "shed";
    case "generated":
      return "warehouse";
    case null:
      return "hut";
  }
}

export interface Lot {
  readonly id: NodeId;
  /** The file's name and path, for display. */
  readonly name: string;
  readonly path: string;
  /** The block the lot is in. */
  readonly block: NodeId;
  readonly role: Role | null;
  readonly kind: BuildingKind;
  /** 1 for the smallest size step; always 1 where the sheet has one size of that kind. */
  readonly step: number;
  /** The sprite's name in the sheet. */
  readonly sprite: string;
  readonly classes: number;
  readonly functions: number;
  /** The files that rest on this one through imports, directly or not, by path; the count is its length. */
  readonly restsOn: readonly string[];
  /** The plinth's sprite, none for a file nothing rests on, and how far the building is raised by it. */
  readonly plinth: string | undefined;
  readonly raise: number;
  /** Why the repo declares this file a way in; empty for any other file. */
  readonly wayIn: readonly string[];
  /** A non-test way in: it has a gate. */
  readonly gate: boolean;
  /** Some way in reaches it through imports (a way in reaches itself). A file nothing reaches has no footpath. */
  readonly reached: boolean;
  /** The middle of the lot on the ground. */
  readonly X: number;
  readonly Y: number;
}

export interface Block {
  /** The top-level folder's id; the root's id for the files that sit in no folder. */
  readonly id: NodeId;
  readonly name: string;
  /** Every package and folder in the block, itself first (none for the root's loose files): the ids a camera can be flown to. */
  readonly folders: readonly NodeId[];
  readonly files: number;
  readonly cols: number;
  readonly rows: number;
  /** The pad, on the ground: X0 to X1 across, Y0 (near) to Y1 (far). */
  readonly X0: number;
  readonly X1: number;
  readonly Y0: number;
  readonly Y1: number;
}

/** One structure in the harbour, for a kind of outside resource some effect edge reaches. */
export interface Pier {
  readonly kind: ResourceKind;
  readonly sprite: string;
  readonly X: number;
  readonly Y: number;
}

export interface Town {
  /** Largest first, in the order they were packed. */
  readonly blocks: readonly Block[];
  /** Block by block, each in path order. */
  readonly lots: readonly Lot[];
  readonly piers: readonly Pier[];
  /** Reached kinds the sheet has no structure for yet: nothing is drawn for them. TODO(#100). */
  readonly unpictured: readonly ResourceKind[];
  /** The island's outline, a closed loop of ground points, and the same loop pulled in for the grass. */
  readonly coast: readonly (readonly [number, number])[];
  readonly lawn: readonly (readonly [number, number])[];
  /** The east shore, where the harbour stands. */
  readonly quay: { readonly X: number; readonly Y: number };
  /** The fewest and most classes and functions in a file, generated files left out. */
  readonly counts: { readonly fewest: number; readonly most: number };
  /** The fewest and most files resting on a file that has any: the ends of the plinth scale. */
  readonly importance: { readonly fewest: number; readonly most: number };
  /** How many files nothing reaches. */
  readonly unreached: number;
}

/** The harbour structure each kind of resource picks, by sheet name: written out, never derived from the kind's words. */
const PIER_SPRITES: Readonly<Record<ResourceKind, string>> = {
  process: "port-process",
  network: "port-network",
  queue: "port-queue",
  "file system": "port-file-system",
  timer: "port-timer",
  "code loaded at run time": "port-dynamic-load",
};

export function pierSpriteName(kind: ResourceKind): string {
  return PIER_SPRITES[kind];
}

/**
 * How many size steps the sheet has for a building kind: `workshop-1`, `workshop-2`, ... count
 * as steps; a kind with one plain sprite has one. A kind the sheet lacks has none.
 */
export function stepsOf(kind: BuildingKind, sprites: ReadonlySet<string>): number {
  let steps = 0;
  while (sprites.has(`${kind}-${steps + 1}`)) steps++;
  return steps > 0 ? steps : sprites.has(kind) ? 1 : 0;
}

/**
 * The size step of a file with `count` classes and functions among `steps`, on a square-root
 * scale between the repository's `fewest` and `most`: each step takes an equal share of the root.
 * When every file has the same count there is nothing to compare, so all take the first step.
 */
export function stepOf(count: number, fewest: number, most: number, steps: number): number {
  if (steps <= 1 || most <= fewest) return 1;
  const share = Math.min(1, Math.max(0, (count - fewest) / (most - fewest)));
  return Math.min(steps, Math.floor(Math.sqrt(share) * steps) + 1);
}

function byCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The town of `graph`, built from the sprites named in `sprites`. Each top-level folder is a block
 * and its files lots of one size in a grid in path order; blocks are packed in rows, largest
 * first. Every lot is a fact (a file), and so is every harbour structure (a reached kind of
 * resource): empty ground has nothing on it.
 */
export function townOf(graph: Graph, sprites: ReadonlySet<string>, waysIn: readonly WayIn[] = []): Town {
  const rests = importanceOf(graph);
  const fromWays = reachedFrom(graph, waysIn.map((way) => way.id));
  const wayById = new Map(waysIn.map((way) => [way.id, way]));
  const idPaths = new Map(graph.nodes.map((node) => [node.id, node.path]));
  const weights = [...rests.values()].map((list) => list.length);
  const fewestRests = weights.length === 0 ? 0 : Math.min(...weights);
  const mostRests = weights.length === 0 ? 0 : Math.max(...weights);
  const plinths = PLINTH_HEIGHTS.filter((_, index) => sprites.has(`plinth-${index + 1}`)).length;
  const nodes = new Map<NodeId, ModuleNode>(graph.nodes.map((node) => [node.id, node]));
  const root = graph.nodes.find((node) => node.parent === null && (node.level === "package" || node.level === "folder"));
  const classes = new Map<string, number>();
  const functions = new Map<string, number>();
  for (const node of graph.nodes) {
    if (node.level === "class") classes.set(node.path, (classes.get(node.path) ?? 0) + 1);
    else if (node.level === "function") functions.set(node.path, (functions.get(node.path) ?? 0) + 1);
  }

  /** The child of the root a node stands in, or the root when it stands directly in it. */
  const topOf = (node: ModuleNode): NodeId | undefined => {
    let at: ModuleNode | undefined = node;
    while (at !== undefined && at.parent !== null && at.parent !== root?.id) at = nodes.get(at.parent);
    return at?.parent === root?.id && at !== undefined ? at.id : undefined;
  };

  const filesByBlock = new Map<NodeId, ModuleNode[]>();
  for (const node of graph.nodes) {
    if (node.level !== "file") continue;
    const top = node.parent === root?.id ? root.id : topOf(node);
    if (top === undefined) continue;
    filesByBlock.set(top, [...(filesByBlock.get(top) ?? []), node]);
  }

  const foldersByBlock = new Map<NodeId, NodeId[]>();
  for (const node of graph.nodes) {
    if (node.level !== "folder" && node.level !== "package") continue;
    const top = node.id === root?.id ? undefined : topOf(node);
    if (top !== undefined) foldersByBlock.set(top, [...(foldersByBlock.get(top) ?? []), node.id]);
  }

  const countOf = (path: string): number => (classes.get(path) ?? 0) + (functions.get(path) ?? 0);
  const measured = [...filesByBlock.values()].flat().filter((file) => file.level === "file" && file.role !== "generated").map((file) => countOf(file.path));
  const fewest = measured.length === 0 ? 0 : Math.min(...measured);
  const most = measured.length === 0 ? 0 : Math.max(...measured);

  // Size every block, then pack them in shelves, largest first.
  const sized = [...filesByBlock]
    .map(([id, files]) => {
      const cols = Math.max(1, Math.ceil(Math.sqrt(files.length)));
      const rows = Math.ceil(files.length / cols);
      const container = nodes.get(id);
      const name = id === root?.id ? "(root files)" : (container?.name ?? id);
      return { id, name, files: [...files].sort((a, b) => byCodeUnits(a.path, b.path)), cols, rows, w: cols * LOT + 2 * PAD, d: rows * LOT + 2 * PAD };
    })
    .sort((a, b) => b.files.length - a.files.length || byCodeUnits(a.name, b.name) || byCodeUnits(a.id, b.id));
  const target = Math.sqrt(sized.reduce((sum, block) => sum + (block.w + GAP) * (block.d + GAP), 0)) * 1.3;
  const places = new Map<NodeId, { x: number; z: number }>();
  let x = 0;
  let z = 0;
  let shelf = 0;
  let width = 0;
  for (const block of sized) {
    if (x > 0 && x + block.w > target) {
      x = 0;
      z += shelf + GAP;
      shelf = 0;
    }
    places.set(block.id, { x, z });
    x += block.w + GAP;
    shelf = Math.max(shelf, block.d);
    width = Math.max(width, x - GAP);
  }
  const depth = z + shelf;
  // Plan (x across, z down) to ground (X, Y): the plan's top edge is the far one.
  const ground = (px: number, pz: number): [number, number] => [px - width / 2, depth / 2 - pz];

  const blocks: Block[] = [];
  const lots: Lot[] = [];
  for (const block of sized) {
    const at = places.get(block.id)!;
    const [X0, Y1] = ground(at.x, at.z);
    const [X1, Y0] = ground(at.x + block.w, at.z + block.d);
    blocks.push({ id: block.id, name: block.name, folders: foldersByBlock.get(block.id) ?? [], files: block.files.length, cols: block.cols, rows: block.rows, X0, X1, Y0, Y1 });
    block.files.forEach((file, index) => {
      if (file.level !== "file") return;
      const [X, Y] = ground(at.x + PAD + (index % block.cols) * LOT + LOT / 2, at.z + PAD + Math.floor(index / block.cols) * LOT + LOT / 2);
      const kind = kindOfRole(file.role);
      const steps = stepsOf(kind, sprites);
      // A generated file keeps the smallest size so it never crowds out written code (SPEC: The graph).
      const step = file.role === "generated" ? 1 : stepOf(countOf(file.path), fewest, most, steps);
      const restsOn = (rests.get(file.id) ?? []).map((id) => idPaths.get(id) ?? id).sort(byCodeUnits);
      const plinthStep = restsOn.length === 0 || plinths === 0 ? 0 : stepOf(restsOn.length, fewestRests, mostRests, plinths);
      const way = wayById.get(file.id);
      lots.push({
        id: file.id,
        name: file.name,
        path: file.path,
        block: block.id,
        role: file.role,
        kind,
        step,
        sprite: sprites.has(`${kind}-${step}`) ? `${kind}-${step}` : kind,
        classes: classes.get(file.path) ?? 0,
        functions: functions.get(file.path) ?? 0,
        restsOn,
        plinth: plinthStep === 0 ? undefined : `plinth-${plinthStep}`,
        raise: plinthStep === 0 ? 0 : PLINTH_HEIGHTS[plinthStep - 1]!,
        wayIn: way?.reasons ?? [],
        gate: way !== undefined && file.role !== "tests" && sprites.has("gate"),
        reached: fromWays.has(file.id),
        X,
        Y,
      });
    });
  }

  // The island is a wobbled ellipse round the plan; the harbour stands on its east shore. The wobble never
  // takes the radius below WOBBLE_LEAST of its base, so growing the ellipse through the plan's corners
  // (a margin out) by that and the lawn's share means even the lawn holds the whole plan.
  const grow = Math.SQRT2 / (WOBBLE_LEAST * LAWN_SHARE * CHORD);
  const radiusX = (width / 2 + ISLAND_MARGIN) * grow;
  const radiusY = (depth / 2 + ISLAND_MARGIN) * grow;
  const loop = (scale: number): [number, number][] =>
    Array.from({ length: 120 }, (_, i) => {
      const t = (i / 120) * Math.PI * 2;
      const r = 1 + 0.07 * Math.sin(3 * t + 1) + 0.05 * Math.sin(7 * t + 2) + 0.03 * Math.sin(11 * t);
      return [Math.cos(t) * radiusX * r * scale, Math.sin(t) * radiusY * r * scale];
    });
  const quay = { X: radiusX * 1.04 - 3, Y: 0 };

  const reached = resourcesOf(graph);
  const pictured = reached.filter((kind) => sprites.has(pierSpriteName(kind)));
  const piers = pictured.map((kind, index): Pier => ({
    kind,
    sprite: pierSpriteName(kind),
    X: quay.X - 0.3,
    Y: (index - (pictured.length - 1) / 2) * PIER_SPACING,
  }));

  return {
    blocks,
    lots,
    piers,
    unpictured: reached.filter((kind) => !sprites.has(pierSpriteName(kind))),
    coast: loop(1),
    lawn: loop(0.95),
    quay,
    counts: { fewest, most },
    importance: { fewest: fewestRests, most: mostRests },
    unreached: lots.filter((lot) => !lot.reached).length,
  };
}
