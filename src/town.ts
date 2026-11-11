import type { Comparison } from "./compare.ts";
import { resourcesOf } from "./graph.ts";
import type { ContainerNode, FileNode, Graph, ModuleNode, NodeId, ResourceKind, Role } from "./graph.ts";
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
/** The clear ground between the parts inside a block: its own lots, its smaller blocks, its rubble. */
export const INNER_GAP = 2;
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

/**
 * Whether a block `depth` folders below the top is named when a lot is `lotPx` pixels wide on screen:
 * a top-level block always, a nested one from 40% of the width files are named at, a deeper one a
 * halving step closer in, so names arrive level by level as you zoom and never before the files'.
 */
export function blockNamedAt(zoom: number, depth: number): boolean {
  if (depth === 0) return true;
  return 2 * LOT * AXIS * zoom >= FILE_NAMES_FROM_LOT_PX * 0.8 * (1 - 0.5 ** depth);
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

/**
 * What a lot says about the change: "unchanged" when there is no comparison. A moved file is
 * "moved" at its new place and "moved-away" on the lot it left, which is rubble like a removed one.
 */
export type LotChange = "unchanged" | "altered" | "added" | "removed" | "moved" | "moved-away";

/** Where a crane stands beside the building it marks, from the lot's middle. */
export const CRANE_AT = { X: -1.75, Y: 1.75 } as const;
/** Where the sign naming a moved file's new path stands, from the lot's middle (it faces the viewer on -Y). */
export const MOVED_SIGN_AT = { X: 0, Y: -1.3 } as const;
/** How far a block's fence stands outside its pad. */
export const FENCE_OUT = 0.4;

/**
 * The scaffolding sprite a building takes, by the building's own sprite: a workshop or lab takes
 * the scaffold of its size step, a shed or hut the small one, a warehouse the low one, and a library (whose roof and steps reach 1.6 m out on the near side, past the low scaffold's poles) scaffold-1.
 * Null when the sheet has none, so nothing is drawn that the sheet cannot show.
 */
export function scaffoldOf(sprite: string, sprites: ReadonlySet<string>): string | null {
  const sized = /^(?:workshop|lab)-(\d+)$/.exec(sprite);
  const wanted = sized !== null ? `scaffold-${sized[1]}` : sprite === "shed" || sprite === "hut" ? "scaffold-small" : sprite === "warehouse" ? "scaffold-low" : "scaffold-1";
  return sprites.has(wanted) ? wanted : null;
}

export interface Lot {
  readonly id: NodeId;
  /** The file's name and path, for display. */
  readonly name: string;
  readonly path: string;
  /** The top-level block the lot is in. */
  readonly block: NodeId;
  /** The innermost block the lot is in: the lot's own folder (the top-level block's id when it stands directly in it). */
  readonly folder: NodeId;
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
  /** The change this lot shows; "unchanged" when nothing is compared. */
  readonly change: LotChange;
  /** The scaffolding over an altered file's building, when the sheet has one for its size. */
  readonly overlay: string | null;
  /** True for an altered file: a crane stands beside it. */
  readonly crane: boolean;
  /** Whether the file is named at near zoom: every file with no comparison, only altered files under one. */
  readonly named: boolean;
  /** For the rubble a moved file left: the file at its new path, whose path goes on the sign. */
  readonly movedTo: { readonly id: NodeId; readonly path: string } | null;
  /** The middle of the lot on the ground. */
  readonly X: number;
  readonly Y: number;
}

export interface Block {
  /** The folder's id; for a top-level block the root's id stands for the files that sit in no folder. */
  readonly id: NodeId;
  readonly name: string;
  /** The block this one is inside; null for a top-level block. */
  readonly parent: NodeId | null;
  /** 0 for a top-level block, 1 for a folder inside it, and so on. */
  readonly depth: number;
  /** Every package and folder in the block, itself first (none for the root's loose files): the ids a camera can be flown to. */
  readonly folders: readonly NodeId[];
  /** Files in the block, nested blocks' included. */
  readonly files: number;
  /** The grid of the block's own files: columns and rows (the rubble's, for a block only rubble stands in). */
  readonly cols: number;
  readonly rows: number;
  /** The pad, on the ground: X0 to X1 across, Y0 (near) to Y1 (far). */
  readonly X0: number;
  readonly X1: number;
  readonly Y0: number;
  readonly Y1: number;
  /** Files of each kind of change in the block, nested folders counted; all zero with no comparison. */
  readonly changes: BlockChanges;
  /** The fence round the pad and the sign by its corner, for a block where more than half the files are added. */
  readonly fence: Fence | null;
}

export interface BlockChanges {
  readonly added: number;
  readonly altered: number;
  readonly removed: number;
  readonly moved: number;
}

export interface Fence {
  /** One metre of barrier each. */
  readonly posts: readonly { readonly sprite: "fence-x" | "fence-y"; readonly X: number; readonly Y: number }[];
  readonly sign: { readonly X: number; readonly Y: number };
  /** The sign's words, e.g. "tools · 93 new". */
  readonly text: string;
}

/**
 * A block's name with its counts under a comparison ("tools · 93 new · 4 altered"); with none, its
 * name alone near, and with its file count far away. A block nothing changed in has no counts.
 */
export function blockLabel(block: Pick<Block, "name" | "files" | "changes">, comparing: boolean, far: boolean): string {
  if (!comparing) return far ? `${block.name} · ${block.files}` : block.name;
  const { added, altered, removed, moved } = block.changes;
  const parts = [added > 0 ? `${added} new` : "", altered > 0 ? `${altered} altered` : "", removed > 0 ? `${removed} removed` : "", moved > 0 ? `${moved} moved` : ""];
  return [block.name, ...parts.filter((part) => part !== "")].join(" · ");
}

/** More than half of the `present` files are added. */
export function mostlyNew(added: number, present: number): boolean {
  return present > 0 && added * 2 > present;
}

/** The fence round a pad and the sign by its near corner: a pure function of the pad and its count of new files. */
export function fenceOf(pad: Pick<Block, "X0" | "X1" | "Y0" | "Y1" | "name">, added: number): Fence {
  const posts: { sprite: "fence-x" | "fence-y"; X: number; Y: number }[] = [];
  const along = (from: number, to: number): number[] => {
    const count = Math.max(1, Math.ceil(to - from - 0.01));
    return Array.from({ length: count }, (_, i) => from + ((i + 0.5) * (to - from)) / count);
  };
  for (const X of along(pad.X0, pad.X1)) posts.push({ sprite: "fence-x", X, Y: pad.Y0 - FENCE_OUT }, { sprite: "fence-x", X, Y: pad.Y1 + FENCE_OUT });
  for (const Y of along(pad.Y0, pad.Y1)) posts.push({ sprite: "fence-y", X: pad.X0 - FENCE_OUT, Y }, { sprite: "fence-y", X: pad.X1 + FENCE_OUT, Y });
  return { posts, sign: { X: pad.X1 + 1.7, Y: pad.Y0 - 1.5 }, text: `${pad.name} · ${added} new` };
}

function byCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The graph with a ghost file for each file the base had and the head has not: a removed file, and
 * the path a moved file left (one a picture's graph already holds is not added twice). A ghost stands in the nearest folder the picture has by path, and a
 * folder only the base had comes back when a ghost stands in it.
 */
export function withGhosts(graph: Graph, comparison: Comparison): { graph: Graph; ghosts: ReadonlySet<NodeId> } {
  const present = new Set<NodeId>(graph.nodes.map((node) => node.id));
  const root = graph.nodes.find((node) => node.parent === null && (node.level === "package" || node.level === "folder"));
  if (root === undefined) return { graph, ghosts: new Set() };
  const ghostFiles: FileNode[] = [];
  for (const change of comparison.changes) {
    if (change.kind === "removed" && change.node.level === "file") ghostFiles.push(change.node);
    else if (change.kind === "moved" && change.from.level === "file") ghostFiles.push(change.from);
  }
  const directoryOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")));
  const directoryAt = new Map<string, NodeId>();
  for (const node of graph.nodes) if (node.level === "folder" || node.level === "package") directoryAt.set(node.path, node.id);
  const standIn = (path: string): NodeId => {
    for (let dir = directoryOf(path); ; dir = directoryOf(dir)) {
      const found = directoryAt.get(dir);
      if (found !== undefined) return found;
      if (dir === "") return root.id;
    }
  };
  const gone = new Map<string, ContainerNode>();
  for (const change of comparison.changes) {
    if (change.kind === "removed" && (change.node.level === "folder" || change.node.level === "package")) gone.set(change.node.path, change.node);
  }
  const wanted = new Set<string>();
  for (const file of ghostFiles) for (let dir = directoryOf(file.path); dir !== ""; dir = directoryOf(dir)) wanted.add(dir);
  const added: ModuleNode[] = [];
  for (const path of [...wanted].sort((a, b) => a.length - b.length || byCodeUnits(a, b))) {
    const node = gone.get(path);
    if (node === undefined || directoryAt.has(path) || present.has(node.id)) continue;
    added.push({ ...node, parent: standIn(path) });
    directoryAt.set(path, node.id);
    present.add(node.id);
  }
  const ghosts = new Set<NodeId>();
  for (const file of ghostFiles) {
    ghosts.add(file.id);
    if (present.has(file.id)) continue;
    added.push({ ...file, parent: standIn(file.path) });
    present.add(file.id);
  }
  return { graph: { ...graph, nodes: [...graph.nodes, ...added] }, ghosts };
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
  /** Every block nested inside a top-level one, each after the block it is in. */
  readonly nested: readonly Block[];
  /** Top-level block by top-level block: head lots first, rubble after. */
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
  /** True under a comparison: names, marks and counts follow the change. */
  readonly comparing: boolean;
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

/**
 * The town of `graph`, built from the sprites named in `sprites`. Each top-level folder is a block
 * whose own files are lots of one size in a grid in path order, and each folder inside it is a smaller
 * block packed inside it by the same rule (rows, largest first), at every depth; top-level blocks are
 * packed the same way. Every lot is a fact (a file), and so is every harbour structure (a reached kind of
 * resource): empty ground has nothing on it.
 *
 * Under a comparison the lots of the files the base had and the head lacks stay (a removed file,
 * and the old path of a moved one), as rubble, and each lot and block carries the marks the change
 * picks (SPEC, Review): decided here from the graph and the comparison alone.
 */
export function townOf(head: Graph, sprites: ReadonlySet<string>, comparison: Comparison | null = null, waysIn: readonly WayIn[] = []): Town {
  const { graph, ghosts } = comparison === null ? { graph: head, ghosts: new Set<NodeId>() } : withGhosts(head, comparison);
  // Importance and reach are the head's alone: a ghost has no place in them.
  const rests = importanceOf(head);
  const fromWays = reachedFrom(head, waysIn.map((way) => way.id));
  const wayById = new Map(waysIn.map((way) => [way.id, way]));
  const idPaths = new Map(graph.nodes.map((node) => [node.id, node.path]));
  const weights = [...rests.values()].map((list) => list.length);
  const fewestRests = weights.length === 0 ? 0 : Math.min(...weights);
  const mostRests = weights.length === 0 ? 0 : Math.max(...weights);
  const plinths = PLINTH_HEIGHTS.filter((_, index) => sprites.has(`plinth-${index + 1}`)).length;
  const kinds = new Map<NodeId, "added" | "altered" | "removed" | "moved">();
  const movedTo = new Map<NodeId, { id: NodeId; path: string }>();
  for (const change of comparison?.changes ?? []) {
    if (change.node.level !== "file") continue;
    kinds.set(change.node.id, change.kind);
    if (change.kind === "moved" && change.from.level === "file") movedTo.set(change.from.id, { id: change.node.id, path: change.node.path });
  }
  const nodes = new Map<NodeId, ModuleNode>(graph.nodes.map((node) => [node.id, node]));
  const root = graph.nodes.find((node) => node.parent === null && (node.level === "package" || node.level === "folder"));
  const classes = new Map<string, number>();
  const functions = new Map<string, number>();
  for (const node of graph.nodes) {
    if (node.level === "class") classes.set(node.path, (classes.get(node.path) ?? 0) + 1);
    else if (node.level === "function") functions.set(node.path, (functions.get(node.path) ?? 0) + 1);
  }


  // A block is a folder: its own files are a grid of equal lots in path order, and its subfolders are smaller blocks
  // packed under the grid. A comparison overlays the head's town: head files and blocks lay out exactly as they do
  // with no comparison, and the ghosts (rubble) come after, in a strip at the foot of the block they stood in.
  interface Tree {
    readonly id: NodeId;
    readonly name: string;
    readonly parent: Tree | null;
    readonly depth: number;
    readonly heads: ModuleNode[];
    readonly gone: ModuleNode[];
    readonly kids: Tree[];
    /** Head files here and below, and rubble here and below. */
    headTotal: number;
    goneTotal: number;
  }
  const trees = new Map<NodeId, Tree>();
  const treeFor = (id: NodeId): Tree | undefined => {
    const known = trees.get(id);
    if (known !== undefined) return known;
    const node = nodes.get(id);
    if (node === undefined || (node.level !== "folder" && node.level !== "package") || id === root?.id) return undefined;
    let parent: Tree | null = null;
    if (node.parent !== root?.id) {
      parent = node.parent === null ? null : (treeFor(node.parent) ?? null);
      if (parent === null) return undefined;
    }
    const made: Tree = { id, name: node.name, parent, depth: parent === null ? 0 : parent.depth + 1, heads: [], gone: [], kids: [], headTotal: 0, goneTotal: 0 };
    trees.set(id, made);
    parent?.kids.push(made);
    return made;
  };
  const rootTree: Tree | undefined = root === undefined ? undefined : { id: root.id, name: "(root files)", parent: null, depth: 0, heads: [], gone: [], kids: [], headTotal: 0, goneTotal: 0 };
  for (const node of graph.nodes) {
    if (node.level !== "file") continue;
    const at = node.parent === root?.id ? rootTree : node.parent === null ? undefined : treeFor(node.parent);
    if (at === undefined) continue;
    (ghosts.has(node.id) ? at.gone : at.heads).push(node);
    for (let up: Tree | null = at; up !== null; up = up.parent) {
      if (ghosts.has(node.id)) up.goneTotal++;
      else up.headTotal++;
    }
  }
  const tops: Tree[] = [...trees.values()].filter((tree) => tree.parent === null);
  if (rootTree !== undefined && rootTree.heads.length + rootTree.gone.length > 0) tops.push(rootTree);

  // Every package and folder in a block, nested ones and ones with no files included, itself first.
  const folderIds = new Map<NodeId, NodeId[]>([...trees.keys()].map((id) => [id, [id]]));
  for (const node of graph.nodes) {
    if ((node.level !== "folder" && node.level !== "package") || node.id === root?.id) continue;
    for (let up = node.parent === null ? undefined : nodes.get(node.parent); up !== undefined; up = up.parent === null ? undefined : nodes.get(up.parent)) {
      folderIds.get(up.id)?.push(node.id);
    }
  }

  const countOf = (path: string): number => (classes.get(path) ?? 0) + (functions.get(path) ?? 0);
  const measured = graph.nodes.filter((file) => file.level === "file" && file.role !== "generated" && !ghosts.has(file.id)).map((file) => countOf(file.path));
  const fewest = measured.length === 0 ? 0 : Math.min(...measured);
  const most = measured.length === 0 ? 0 : Math.max(...measured);

  const byPath = (a: ModuleNode, b: ModuleNode): number => byCodeUnits(a.path, b.path);
  /** Blocks with head files in the order they have without a comparison, then those only rubble stands in. */
  const inOrder = (a: Tree, b: Tree): number => b.headTotal - a.headTotal || (a.headTotal > 0 ? 0 : b.goneTotal - a.goneTotal) || byCodeUnits(a.name, b.name) || byCodeUnits(a.id, b.id);

  interface Laid {
    readonly tree: Tree;
    readonly w: number;
    readonly d: number;
    readonly cols: number;
    readonly rows: number;
    readonly own: ModuleNode[];
    readonly kids: { readonly laid: Laid; readonly x: number; readonly z: number }[];
    /** Where the grid of its own files starts, and where each smaller block does, from the pad's inner corner. */
    readonly gridAt: { readonly x: number; readonly z: number };
    readonly strip: { readonly files: ModuleNode[]; readonly cols: number; readonly z: number };
  }
  /** Shelves, left to right: a block that does not fit what is left of `target` starts the next shelf. */
  const pack = (items: readonly { w: number; d: number }[], target: number, gap: number): { places: { x: number; z: number }[]; w: number; d: number } => {
    const places: { x: number; z: number }[] = [];
    let x = 0;
    let z = 0;
    let shelf = 0;
    let w = 0;
    for (const item of items) {
      if (x > 0 && x + item.w > target) {
        x = 0;
        z += shelf + gap;
        shelf = 0;
      }
      places.push({ x, z });
      x += item.w + gap;
      shelf = Math.max(shelf, item.d);
      w = Math.max(w, x - gap);
    }
    return { places, w, d: items.length === 0 ? 0 : z + shelf };
  };
  const memo = new Map<string, Laid>();
  const lay = (tree: Tree, withGhosts: boolean): Laid => {
    const key = `${tree.id}|${withGhosts}`;
    const known = memo.get(key);
    if (known !== undefined) return known;
    const own = [...tree.heads].sort(byPath);
    const gone = withGhosts ? [...tree.gone].sort(byPath) : [];
    const kids = tree.kids.filter((kid) => (withGhosts ? kid.headTotal + kid.goneTotal : kid.headTotal) > 0).sort(inOrder);
    const gridCols = own.length > 0 ? Math.ceil(Math.sqrt(own.length)) : 0;
    const gridRows = gridCols === 0 ? 0 : Math.ceil(own.length / gridCols);
    const gridW = gridCols * LOT;
    const gridD = gridRows * LOT;
    const laidKids = kids.map((kid) => lay(kid, withGhosts));
    // How the shelves wrap is decided by the head's blocks as they are with no comparison, so rubble never changes it.
    const headKids = kids.filter((kid) => kid.headTotal > 0);
    const sizing = headKids.length > 0 ? headKids.map((kid) => lay(kid, false)) : laidKids;
    // The block's own grid is the first thing on the first shelf, and its smaller blocks fill in beside and below it.
    const grid = own.length > 0 ? [{ w: gridW, d: gridD }] : [];
    const target = Math.max(gridW, Math.sqrt([...grid, ...sizing].reduce((sum, item) => sum + (item.w + INNER_GAP) * (item.d + INNER_GAP), 0)) * 1.3);
    const packed = pack([...grid, ...laidKids], target, INNER_GAP);
    const headInner = Math.max(gridW, packed.w);
    const stripCols = gone.length === 0 ? 0 : headInner > 0 ? Math.max(1, Math.floor(headInner / LOT + 1e-9)) : Math.ceil(Math.sqrt(gone.length));
    const inner = headInner > 0 ? headInner : stripCols * LOT;
    const stripRows = stripCols === 0 ? 0 : Math.ceil(gone.length / stripCols);
    const stripZ = PAD + packed.d + (kids.length > 0 && gone.length > 0 ? INNER_GAP : 0);
    const laid: Laid = {
      tree,
      w: inner + 2 * PAD,
      d: stripZ + stripRows * LOT + PAD,
      cols: own.length > 0 ? gridCols : stripCols,
      rows: own.length > 0 ? gridRows : stripRows,
      own,
      gridAt: grid.length > 0 ? packed.places[0]! : { x: 0, z: 0 },
      kids: laidKids.map((kid, index) => ({ laid: kid, x: packed.places[index + grid.length]!.x, z: packed.places[index + grid.length]!.z })),
      strip: { files: gone, cols: stripCols, z: stripZ },
    };
    memo.set(key, laid);
    return laid;
  };

  const topsLaid = tops.filter((tree) => tree.headTotal + tree.goneTotal > 0).sort(inOrder).map((tree) => lay(tree, true));
  const topHeads = topsLaid.filter((top) => top.tree.headTotal > 0).map((top) => lay(top.tree, false));
  const target = Math.sqrt((topHeads.length > 0 ? topHeads : topsLaid).reduce((sum, block) => sum + (block.w + GAP) * (block.d + GAP), 0)) * 1.3;
  const packedTops = pack(topsLaid, target, GAP);
  const width = packedTops.w;
  const depth = packedTops.d;
  // Plan (x across, z down) to ground (X, Y): the plan's top edge is the far one.
  const ground = (px: number, pz: number): [number, number] => [px - width / 2, depth / 2 - pz];

  const filesOf = (tree: Tree): ModuleNode[] => [...tree.heads, ...tree.gone, ...tree.kids.flatMap(filesOf)];
  const blocks: Block[] = [];
  const nested: Block[] = [];
  const headLots: Lot[] = [];
  const goneLots: Lot[] = [];
  const lotAt = (file: ModuleNode, X: number, Y: number, top: NodeId, folder: NodeId): Lot | undefined => {
    if (file.level !== "file") return undefined;
    const kind = kindOfRole(file.role);
    const gone = ghosts.has(file.id);
    const change: LotChange = comparison === null ? "unchanged" : gone ? (movedTo.has(file.id) ? "moved-away" : "removed") : (kinds.get(file.id) as LotChange | undefined) ?? "unchanged";
    const steps = stepsOf(kind, sprites);
    // A generated file keeps the smallest size so it never crowds out written code (SPEC: The graph).
    const step = file.role === "generated" ? 1 : stepOf(countOf(file.path), fewest, most, steps);
    const restsOn = (rests.get(file.id) ?? []).map((id) => idPaths.get(id) ?? id).sort(byCodeUnits);
    const plinthStep = restsOn.length === 0 || plinths === 0 ? 0 : stepOf(restsOn.length, fewestRests, mostRests, plinths);
    const way = wayById.get(file.id);
    return {
      id: file.id,
      name: file.name,
      path: file.path,
      block: top,
      folder,
      role: file.role,
      kind,
      step,
      sprite: gone ? "rubble" : sprites.has(`${kind}-${step}`) ? `${kind}-${step}` : kind,
      classes: classes.get(file.path) ?? 0,
      functions: functions.get(file.path) ?? 0,
      restsOn,
      plinth: plinthStep === 0 ? undefined : `plinth-${plinthStep}`,
      raise: plinthStep === 0 ? 0 : PLINTH_HEIGHTS[plinthStep - 1]!,
      wayIn: way?.reasons ?? [],
      gate: way !== undefined && file.role !== "tests" && sprites.has("gate"),
      reached: ghosts.has(file.id) || fromWays.has(file.id),
      change,
      overlay: change === "altered" ? scaffoldOf(sprites.has(`${kind}-${step}`) ? `${kind}-${step}` : kind, sprites) : null,
      crane: change === "altered" && sprites.has("crane"),
      named: comparison === null || change === "altered",
      movedTo: movedTo.get(file.id) ?? null,
      X,
      Y,
    };
  };
  const place = (laid: Laid, ax: number, az: number, top: NodeId): void => {
    const tree = laid.tree;
    const [X0, Y1] = ground(ax, az);
    const [X1, Y0] = ground(ax + laid.w, az + laid.d);
    const changes = { added: 0, altered: 0, removed: 0, moved: 0 };
    let present = 0;
    const all = filesOf(tree);
    for (const file of all) {
      if (ghosts.has(file.id)) {
        if (kinds.get(file.id) === "removed") changes.removed++;
        continue;
      }
      present++;
      const kind = kinds.get(file.id);
      if (kind !== undefined) changes[kind]++;
    }
    const pad = { name: tree.name, X0, X1, Y0, Y1 };
    const block: Block = {
      id: tree.id,
      name: tree.name,
      parent: tree.parent?.id ?? null,
      depth: tree.depth,
      folders: tree.id === root?.id ? [] : (folderIds.get(tree.id) ?? [tree.id]),
      files: all.length,
      cols: laid.cols,
      rows: laid.rows,
      X0, X1, Y0, Y1,
      changes,
      fence: comparison !== null && mostlyNew(changes.added, present) ? fenceOf(pad, changes.added) : null,
    };
    (tree.depth === 0 ? blocks : nested).push(block);
    const gridCols = laid.own.length > 0 ? laid.cols : 1;
    laid.own.forEach((file, index) => {
      const [X, Y] = ground(ax + PAD + laid.gridAt.x + (index % gridCols) * LOT + LOT / 2, az + PAD + laid.gridAt.z + Math.floor(index / gridCols) * LOT + LOT / 2);
      const lot = lotAt(file, X, Y, top, tree.id);
      if (lot !== undefined) headLots.push(lot);
    });
    for (const kid of laid.kids) place(kid.laid, ax + PAD + kid.x, az + PAD + kid.z, top);
    laid.strip.files.forEach((file, index) => {
      const [X, Y] = ground(ax + PAD + (index % laid.strip.cols) * LOT + LOT / 2, az + laid.strip.z + Math.floor(index / laid.strip.cols) * LOT + LOT / 2);
      const lot = lotAt(file, X, Y, top, tree.id);
      if (lot !== undefined) goneLots.push(lot);
    });
  };
  const lots: Lot[] = [];
  topsLaid.forEach((laid, index) => {
    headLots.length = 0;
    goneLots.length = 0;
    const at = packedTops.places[index]!;
    place(laid, at.x, at.z, laid.tree.id);
    lots.push(...headLots, ...goneLots);
  });

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
    nested,
    lots,
    piers,
    unpictured: reached.filter((kind) => !sprites.has(pierSpriteName(kind))),
    coast: loop(1),
    lawn: loop(0.95),
    quay,
    counts: { fewest, most },
    importance: { fewest: fewestRests, most: mostRests },
    unreached: lots.filter((lot) => !lot.reached).length,
    comparing: comparison !== null,
  };
}

/** The innermost block whose pad holds the ground point: a nested block's pad picks its folder, not the block round it. */
export function blockAtGround(town: Pick<Town, "blocks" | "nested">, X: number, Y: number): Block | undefined {
  let found: Block | undefined;
  for (const block of [...town.blocks, ...town.nested]) {
    if (X < block.X0 || X > block.X1 || Y < block.Y0 || Y > block.Y1) continue;
    if (found === undefined || block.depth > found.depth) found = block;
  }
  return found;
}

/** Every block, top-level first and each nested one after the block it is in. */
export function allBlocks(town: Pick<Town, "blocks" | "nested">): Block[] {
  return [...town.blocks, ...town.nested];
}
