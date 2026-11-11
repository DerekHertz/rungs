import type { Comparison } from "./compare.ts";
import { resourcesOf } from "./graph.ts";
import type { ContainerNode, FileNode, Graph, ModuleNode, NodeId, ResourceKind, Role } from "./graph.ts";

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
  /** True under a comparison: names, marks and counts follow the change. */
  readonly comparing: boolean;
}

/** The harbour structure a kind of resource picks, by sheet name. */
export function pierSpriteName(kind: ResourceKind): string {
  return `port-${kind.replaceAll(" ", "-")}`;
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
 * and its files lots of one size in a grid in path order; blocks are packed in rows, largest
 * first. Every lot is a fact (a file), and so is every harbour structure (a reached kind of
 * resource): empty ground has nothing on it.
 *
 * Under a comparison the lots of the files the base had and the head lacks stay (a removed file,
 * and the old path of a moved one), as rubble, and each lot and block carries the marks the change
 * picks (SPEC, Review): decided here from the graph and the comparison alone.
 */
export function townOf(head: Graph, sprites: ReadonlySet<string>, comparison: Comparison | null = null): Town {
  const { graph, ghosts } = comparison === null ? { graph: head, ghosts: new Set<NodeId>() } : withGhosts(head, comparison);
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
  const measured = [...filesByBlock.values()].flat().filter((file) => file.level === "file" && file.role !== "generated" && !ghosts.has(file.id)).map((file) => countOf(file.path));
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
    const changes = { added: 0, altered: 0, removed: 0, moved: 0 };
    let present = 0;
    for (const file of block.files) {
      if (ghosts.has(file.id)) {
        if (kinds.get(file.id) === "removed") changes.removed++;
        continue;
      }
      present++;
      const kind = kinds.get(file.id);
      if (kind !== undefined) changes[kind]++;
    }
    const pad = { name: block.name, X0, X1, Y0, Y1 };
    blocks.push({ id: block.id, name: block.name, folders: foldersByBlock.get(block.id) ?? [], files: block.files.length, cols: block.cols, rows: block.rows, X0, X1, Y0, Y1, changes, fence: comparison !== null && mostlyNew(changes.added, present) ? fenceOf(pad, changes.added) : null });
    block.files.forEach((file, index) => {
      if (file.level !== "file") return;
      const [X, Y] = ground(at.x + PAD + (index % block.cols) * LOT + LOT / 2, at.z + PAD + Math.floor(index / block.cols) * LOT + LOT / 2);
      const kind = kindOfRole(file.role);
      const gone = ghosts.has(file.id);
      const change: LotChange = comparison === null ? "unchanged" : gone ? (movedTo.has(file.id) ? "moved-away" : "removed") : (kinds.get(file.id) as LotChange | undefined) ?? "unchanged";
      const steps = stepsOf(kind, sprites);
      // A generated file keeps the smallest size so it never crowds out written code (SPEC: The graph).
      const step = file.role === "generated" ? 1 : stepOf(countOf(file.path), fewest, most, steps);
      lots.push({
        id: file.id,
        name: file.name,
        path: file.path,
        block: block.id,
        role: file.role,
        kind,
        step,
        sprite: gone ? "rubble" : sprites.has(`${kind}-${step}`) ? `${kind}-${step}` : kind,
        classes: classes.get(file.path) ?? 0,
        functions: functions.get(file.path) ?? 0,
        change,
        overlay: change === "altered" ? scaffoldOf(sprites.has(`${kind}-${step}`) ? `${kind}-${step}` : kind, sprites) : null,
        crane: change === "altered" && sprites.has("crane"),
        named: comparison === null || change === "altered",
        movedTo: movedTo.get(file.id) ?? null,
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
    comparing: comparison !== null,
  };
}
