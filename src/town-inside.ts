import { isCodeNode, targetText } from "./graph.ts";
import type { CodeNode, EffectEdge, Graph, LineRange, ModuleNode, NodeId, ResourceKind } from "./graph.ts";
import { resourceKindOf } from "./effects.ts";
import type { Comparison, Overlay } from "./compare.ts";
import type { CallbackLines } from "./test-changes-types.ts";
import { AXIS } from "./town.ts";

/*
 * A file's inside, walls down: a pure function from the graph (and the names of the sprites the
 * sheet has) to tiles on the ground and the sprite each fact picks (SPEC, The picture: Inside a
 * file). Every function is a room, an exported function's room has a door to the outside, and each
 * outside call is an object in the room of the function that makes it. Nothing here reads the
 * window or a clock. The page only projects and draws it.
 *
 * Ground coordinates are the town's (see town.ts), one unit a tile: a tile's middle is a whole
 * number, a wall stands on a tile's edge, at a half. The near side is the low-Y wall, so a door
 * stands there and opens to the low-Y side.
 */

/** Interior tiles a room has on a side, by the lines of its function: the first step that holds them. */
export const ROOM_STEPS: readonly { readonly lines: number; readonly side: number }[] = [
  { lines: 10, side: 3 },
  { lines: 30, side: 4 },
  { lines: 80, side: 5 },
  { lines: Infinity, side: 6 },
];
/** Clear ground between rows of rooms, in tiles, where the doors open. */
export const STREET = 2;

/** Names of rooms appear once a tile is this many pixels wide on screen. */
export const ROOM_NAMES_FROM_TILE_PX = 44;

/** What is named at `zoom` (screen pixels per native sprite pixel): rooms only close in. */
export function roomNamesAt(zoom: number): boolean {
  return 2 * AXIS * zoom >= ROOM_NAMES_FROM_TILE_PX;
}

/** The room side a function of `lines` lines gets before objects are fitted in. */
export function sideOfLines(lines: number): number {
  return ROOM_STEPS.find((step) => lines <= step.lines)!.side;
}

/** The sprite an outside call's kind picks, by sheet name. Code loaded at run time is `dynamic-load`. */
export function objectSpriteName(kind: string): string {
  return `object-${kind === "code loaded at run time" ? "dynamic-load" : kind.replaceAll(" ", "-")}`;
}

/**
 * What a comparison says about one file, read from the comparison alone: which functions changed,
 * which outside calls are new or altered, and whether the file already existed (a call is named
 * only in a file that did; SPEC, Review: Comparison).
 */
export interface InsideMarks {
  readonly existed: boolean;
  /** Functions of the file that were altered or are new. */
  readonly changed: ReadonlySet<NodeId>;
  /** True for a call that is new, or whose arguments changed. */
  readonly altered: (edge: EffectEdge) => boolean;
  /** Callback lines of the tests of a changed test file that the change weakened or newly skipped: their rooms are marked. */
  readonly tests?: readonly CallbackLines[] | undefined;
}

/** The marks of the file `fileId` under `comparison`; `overlay` is the picture's. */
export function marksOf(comparison: Comparison, overlay: Overlay, fileId: NodeId, path: string): InsideMarks {
  const changed = new Set<NodeId>();
  for (const change of comparison.changes) {
    if (change.node.level === "function" && change.node.path === path && (change.kind === "altered" || change.kind === "added")) changed.add(change.node.id);
  }
  return {
    existed: overlay.entry(fileId)?.kind !== "added",
    changed,
    altered: (edge) => overlay.freshEdge(edge) || overlay.changedEdge(edge),
  };
}

export interface RoomObject {
  readonly kind: ResourceKind;
  readonly sprite: string;
  /** The call as the source writes it: its operation. */
  readonly operation: string;
  /** The call's target as text (`"git"`), or null when the source names none. */
  readonly target: string | null;
  readonly range: LineRange;
  /** The function the call is in, which can be one written inside the room's. */
  readonly owner: NodeId;
  /** New or altered under a comparison: it gets a ring. */
  readonly altered: boolean;
  /** The name shown beside a ringed object: the call's target (or, with none, its operation), only in a file that already existed. */
  readonly name: string | null;
  readonly X: number;
  readonly Y: number;
}

export interface Room {
  /** The function (or method) the room stands for, or the file for calls made at its top level. */
  readonly id: NodeId;
  readonly name: string;
  readonly topLevel: boolean;
  readonly range: LineRange | null;
  readonly exported: boolean;
  readonly changed: boolean;
  /** The room of a test the change weakened or newly skipped. */
  readonly testMarked: boolean;
  /** Interior tiles on a side. */
  readonly side: number;
  /** The interior's tiles run from (X0, Y0) to (X0 + side - 1, Y0 + side - 1), middles on whole numbers. */
  readonly X0: number;
  readonly Y0: number;
  readonly objects: readonly RoomObject[];
}

export interface Tile {
  readonly sprite: string;
  readonly X: number;
  readonly Y: number;
  readonly room: NodeId;
}

export interface Inside {
  readonly file: NodeId;
  readonly path: string;
  readonly rooms: readonly Room[];
  readonly floors: readonly Tile[];
  /** Walls and doors, one to a tile edge. */
  readonly walls: readonly Tile[];
  /** Tiles that stand in a room to mark it: cones for a changed function, a sign for a weakened or newly skipped test. */
  readonly cones: readonly Tile[];
  /** Outside calls whose kind the sheet has no object for yet: nothing is drawn for them. */
  readonly unpictured: readonly ResourceKind[];
  /** The ground the building stands on: X0 to X1, Y0 to Y1, edge to edge. */
  readonly ground: { readonly X0: number; readonly X1: number; readonly Y0: number; readonly Y1: number };
}

function byCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The inside of the file `fileId`. Rooms are all of the file's functions (methods and functions
 * written inside others included) in source order, plus one "top level" room when a call is made
 * outside any function. Each call is in the room of the innermost function holding it. Rooms fill rows left to right in source order, and a row starts when the
 * next room would pass a width set by the file's total area; doors open onto the street between
 * rows. A room's side steps with its function's line count and grows only until its objects fit.
 */
export function insideOf(graph: Graph, fileId: NodeId, sprites: ReadonlySet<string>, marks: InsideMarks | null = null): Inside | undefined {
  const file = graph.nodes.find((node) => node.id === fileId);
  if (file === undefined || file.level !== "file") return undefined;
  const nodes = new Map<NodeId, ModuleNode>(graph.nodes.map((node) => [node.id, node]));
  const code = graph.nodes
    .filter((node): node is CodeNode => isCodeNode(node) && node.path === file.path)
    .sort((a, b) => a.range.start - b.range.start || a.range.end - b.range.end || byCodeUnits(a.id, b.id));

  /** Every function has a room of its own, a method or a function written inside another included. */
  const hasRoom = (node: ModuleNode): node is CodeNode => node.level === "function";
  /** A call is in the room of the innermost function that holds it; one made in a class body or at the top is the top level's. */
  const roomOf = (id: NodeId): NodeId => {
    for (let at = nodes.get(id); at !== undefined; at = nodes.get(at.parent as NodeId)) {
      if (hasRoom(at)) return at.id;
      if (at.level === "file") break;
    }
    return file.id;
  };

  const callsByRoom = new Map<NodeId, EffectEdge[]>();
  const unpictured = new Set<ResourceKind>();
  for (const edge of graph.edges) {
    const owner = nodes.get(edge.from);
    if (owner === undefined || owner.path !== file.path) continue;
    const kind = resourceKindOf(edge);
    if (!sprites.has(objectSpriteName(kind))) {
      unpictured.add(kind);
      continue;
    }
    const room = roomOf(edge.from);
    callsByRoom.set(room, [...(callsByRoom.get(room) ?? []), edge]);
  }
  for (const calls of callsByRoom.values()) calls.sort((a, b) => a.range.start - b.range.start || a.range.end - b.range.end || byCodeUnits(a.operation, b.operation));

  // A test is found by the lines of its callback, and only when one function holds exactly those lines.
  const holders = new Map<string, number>();
  for (const node of code) if (hasRoom(node)) holders.set(`${node.range.start}-${node.range.end}`, (holders.get(`${node.range.start}-${node.range.end}`) ?? 0) + 1);
  const testMarked = (node: CodeNode | undefined): boolean =>
    node !== undefined && marks?.tests?.some((lines) => lines.start === node.range.start && lines.end === node.range.end && holders.get(`${lines.start}-${lines.end}`) === 1) === true;

  interface Plan {
    readonly id: NodeId;
    readonly node: CodeNode | undefined;
    readonly marked: boolean;
    readonly name: string;
    readonly calls: readonly EffectEdge[];
    readonly side: number;
  }
  const plans: Plan[] = code.filter(hasRoom).map((node) => ({ id: node.id, node, marked: testMarked(node), name: node.qualifiedName, calls: callsByRoom.get(node.id) ?? [], side: 0 }));
  const top = callsByRoom.get(file.id);
  if (top !== undefined) plans.push({ id: file.id, node: undefined, marked: false, name: "top level", calls: top, side: 0 });
  const sized = plans.map((plan): Plan => {
    const exported = plan.node?.exported === true;
    const changed = plan.node !== undefined && marks?.changed.has(plan.id) === true;
    const needed = plan.calls.length + (exported ? 1 : 0) + (changed ? 2 : 0) + (plan.marked ? 1 : 0);
    let side = plan.node === undefined ? 3 : sideOfLines(plan.node.range.end - plan.node.range.start + 1);
    while (side * side < needed) side++;
    return { ...plan, side };
  });

  // Rows of rooms in source order, wrapped at a width taken from the total area.
  const area = sized.reduce((sum, plan) => sum + plan.side * plan.side, 0);
  const widest = Math.max(0, ...sized.map((plan) => plan.side));
  const limit = Math.max(widest, Math.ceil(Math.sqrt(area) * 1.4));
  const rows: { plan: Plan; x: number }[][] = [];
  let x = 0;
  for (const plan of sized) {
    if (rows.length === 0 || (x > 0 && x + plan.side > limit)) {
      rows.push([]);
      x = 0;
    }
    rows[rows.length - 1]!.push({ plan, x });
    x += plan.side;
  }
  const rowHeights = rows.map((row) => Math.max(...row.map((entry) => entry.plan.side)));
  const width = Math.max(0, ...rows.map((row) => row.reduce((sum, entry) => sum + entry.plan.side, 0)));
  const depth = rowHeights.reduce((sum, height) => sum + height, 0) + Math.max(0, rows.length - 1) * STREET;

  const rooms: Room[] = [];
  const floors: Tile[] = [];
  const walls = new Map<string, Tile>();
  const cones: Tile[] = [];
  const wall = (sprite: string, X: number, Y: number, room: NodeId): void => {
    const key = `${sprite === "wall-y" ? "y" : "x"}|${X}|${Y}`;
    const known = walls.get(key);
    // A door wins over the wall of the same edge.
    if (known === undefined || sprite === "door-outside") walls.set(key, { sprite, X, Y, room });
  };

  // The plan runs x across and the first row at the far (high Y) end; a room sits on the near edge of its row.
  let zTop = 0;
  rows.forEach((row, rowIndex) => {
    const height = rowHeights[rowIndex]!;
    for (const { plan, x: px } of row) {
      const side = plan.side;
      const X0 = px - width / 2 + 0.5;
      const Y0 = depth / 2 - (zTop + height) + 0.5;
      const exported = plan.node?.exported === true;
      const changed = plan.node !== undefined && marks?.changed.has(plan.id) === true;
      const doorAt = Math.floor(side / 2);
      for (let a = 0; a < side; a++) {
        for (let b = 0; b < side; b++) floors.push({ sprite: plan.marked && sprites.has("floor-test") ? "floor-test" : changed && sprites.has("floor-changed") ? "floor-changed" : "floor", X: X0 + a, Y: Y0 + b, room: plan.id });
      }
      for (let a = 0; a < side; a++) {
        wall(exported && a === doorAt && sprites.has("door-outside") ? "door-outside" : "wall-x", X0 + a, Y0 - 0.5, plan.id);
        wall("wall-x", X0 + a, Y0 + side - 0.5, plan.id);
      }
      for (let b = 0; b < side; b++) {
        wall("wall-y", X0 - 0.5, Y0 + b, plan.id);
        wall("wall-y", X0 + side - 0.5, Y0 + b, plan.id);
      }
      // Corners of the near wall carry the cones; the door's tile and the cones' tiles hold no object.
      const reserved = new Set<string>();
      if (exported) reserved.add(`${doorAt},0`);
      if (changed && sprites.has("cone")) {
        for (const [a, b] of [[side - 1, 0], [0, side - 1]] as const) {
          reserved.add(`${a},${b}`);
          cones.push({ sprite: "cone", X: X0 + a, Y: Y0 + b, room: plan.id });
        }
      }
      if (plan.marked && sprites.has("sign-test")) {
        reserved.add("0,0");
        cones.push({ sprite: "sign-test", X: X0, Y: Y0, room: plan.id });
      }
      const free: [number, number][] = [];
      for (let b = side - 1; b >= 0; b--) for (let a = 0; a < side; a++) if (!reserved.has(`${a},${b}`)) free.push([a, b]);
      const objects = plan.calls.map((edge, index): RoomObject => {
        const [a, b] = free[index]!;
        const kind = resourceKindOf(edge);
        const altered = marks?.altered(edge) === true;
        const target = edge.target === "none" ? null : targetText(edge.target);
        return {
          kind,
          sprite: objectSpriteName(kind),
          operation: edge.operation,
          target,
          range: edge.range,
          owner: edge.from,
          altered,
          name: altered && marks?.existed === true ? (typeof edge.target === "object" ? edge.target.literal : edge.operation) : null,
          X: X0 + a,
          Y: Y0 + b,
        };
      });
      rooms.push({ id: plan.id, name: plan.name, topLevel: plan.node === undefined, range: plan.node?.range ?? null, exported, changed, testMarked: plan.marked, side, X0, Y0, objects });
    }
    zTop += height + STREET;
  });

  const ground = { X0: -width / 2 - 1.5, X1: width / 2 + 1.5, Y0: -depth / 2 - 1.5, Y1: depth / 2 + 1.5 };
  return { file: file.id, path: file.path, rooms, floors, walls: [...walls.values()], cones, unpictured: [...unpictured].sort(), ground };
}
