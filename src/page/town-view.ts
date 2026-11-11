import type { NodeId, ResourceKind } from "../graph.ts";
import { allBlocks, AXIS, blockAtGround, blockLabel, blockNamedAt, CRANE_AT, GATE_FRONT, LOT, MOVED_SIGN_AT, footpathAt, namesAt, project } from "../town.ts";
import { pickAt } from "../town-pick.ts";
import type { Placement, Plaque } from "../town-pick.ts";
import type { Block, Lot, Pier, Town } from "../town.ts";
import { EFFECT_COLOR } from "./palette.ts";

/*
 * Draws a Town on a 2D canvas from the sprite sheet: every thing standing in the picture is a
 * sprite placed by a fact (a file, a reached kind of resource). The camera looks from one fixed
 * isometric angle; it pans and zooms and never moves anything. Sprites land on whole pixels with
 * smoothing off.
 */

/** One sprite's size in the sheet and where its ground point is, in its own pixels (sprites.json). */
export interface SpriteSize {
  readonly w: number;
  readonly h: number;
  readonly ox: number;
  readonly oy: number;
}

export interface Sheet {
  readonly sizes: Readonly<Record<string, SpriteSize>>;
  readonly images: ReadonlyMap<string, HTMLImageElement>;
}

/** Fetches the town theme's sheet from the server. */
export async function loadSheet(): Promise<Sheet> {
  const sizes = (await (await fetch("/town/sprites.json")).json()) as Record<string, SpriteSize>;
  const images = new Map<string, HTMLImageElement>();
  await Promise.all(
    Object.keys(sizes).map(
      (name) =>
        new Promise<void>((done, fail) => {
          const image = new Image();
          image.onload = () => done();
          image.onerror = () => fail(new Error(`sprite ${name} did not load`));
          image.src = `/town/${name}.png`;
          images.set(name, image);
        }),
    ),
  );
  return { sizes, images };
}

interface Point {
  readonly x: number;
  readonly y: number;
}

/** What a double-click landed on: a building, the block under it, or an outside resource's structure. */
export type Hit =
  | { readonly kind: "building" | "district"; readonly id: NodeId }
  | { readonly kind: "resource"; readonly resource: ResourceKind };

export interface TownHandlers {
  /** The building under the pointer, or undefined; fires as the pointer or the camera moves. */
  hover(id: NodeId | undefined, at: Point): void;
  /** `clicks` is 1 for a single click and counts up with a double-click. */
  click(id: NodeId | undefined, clicks: number): void;
  /** A single click on a harbour structure. */
  resource(kind: ResourceKind): void;
  /** `hit` is undefined on empty ground. */
  doubleClick(hit: Hit | undefined): void;
}

export interface TownView {
  show(town: Town): void;
  select(id: NodeId | undefined): void;
  /** Outlines these buildings together; `chosen` lights that resource's structure and outlines them in its colour. */
  highlight(ids: readonly NodeId[], chosen?: ResourceKind): void;
  /** Frames the block holding this folder. */
  flyTo(id: NodeId): void;
  reset(): void;
}

const COLOUR = {
  sea: "#12304a", seaLight: "#1d4a6e", sand: "#5d6072", sandDark: "#3d4050", grass: "#2f5240",
  pad: "#3b674c", pads: ["#3b674c", "#467a58", "#508a64", "#5a9970"], innerKerb: "#a6b8a8", earth: "#6b5236", kerb: "#7d8494", wood: "#7a5a3a", woodDark: "#5a4028", quay: "#6b7080",
  name: "#f2f4f7", mark: "#ff8a2a", pill: "rgba(5,7,10,0.86)", pillEdge: "#39424e", pierEdge: "#7d8494", select: "#ffffff", hover: "#9aa6b5",
};
/** Screen pixels a metre of height rises in the sheet (see project). */
const RISE_UNIT = 48 * Math.cos(Math.PI / 6);
const ZOOM = { fitFill: 0.92, min: 0.5, max: 1.5 };
const CLICK_SLOP = 4;
const FLIGHT_MS = 260;

/** Which sprite of a lot this is: the building (or rubble), or a mark standing on it. */
type Part = "building" | "plinth" | "gate" | "scaffold" | "crane" | "moved-sign";

type Thing =
  | { readonly kind: "lot"; readonly lot: Lot; readonly part: Part; readonly sprite: string; readonly X: number; readonly Y: number; readonly Z: number; readonly key: number }
  /** A fence post or a block's sign: a fact about the block, not clickable. */
  | { readonly kind: "mark"; readonly sprite: string; readonly X: number; readonly Y: number; readonly Z: number; readonly key: number }
  | { readonly kind: "pier"; readonly pier: Pier; readonly sprite: string; readonly X: number; readonly Y: number; readonly Z: number; readonly key: number };

/** A block's name as drawn: picking it picks the block's folder. */
interface BlockName {
  readonly kind: "block";
  readonly block: Block;
}
/** Anything a pixel can pick. */
type Pick = Thing | BlockName;

interface Camera {
  zoom: number;
  /** The picture point (native sprite pixels) at the middle of the canvas. */
  cx: number;
  cy: number;
}

export function createTownView(host: HTMLElement, handlers: TownHandlers, sheet: Sheet): TownView {
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none";
  canvas.setAttribute("aria-label", "Town of the repository");
  host.prepend(canvas);
  const ctx = canvas.getContext("2d")!;

  let town: Town | undefined;
  let things: Thing[] = [];
  let bounds = { left: 0, right: 1, top: 0, bottom: 1 };
  let camera: Camera = { zoom: 1, cx: 0, cy: 0 };
  let flight: { from: Camera; to: Camera; start: number } | undefined;
  let selected: NodeId | undefined;
  let highlighted: ReadonlySet<NodeId> = new Set();
  let chosen: ResourceKind | undefined;
  let hovered: Pick | undefined;
  /** The block the camera was last sent to: its name is shown first and at any zoom. */
  let focused: NodeId | undefined;
  let dirty = true;
  let dpr = 1;

  // What a sprite's pixels say: which are drawn (for picking) and its outline in a colour.
  const masks = new Map<string, Uint8ClampedArray>();
  const outlines = new Map<string, HTMLCanvasElement>();
  function maskOf(name: string): Uint8ClampedArray | undefined {
    const known = masks.get(name);
    if (known !== undefined) return known;
    const image = sheet.images.get(name);
    const size = sheet.sizes[name];
    if (image === undefined || size === undefined) return undefined;
    const tile = document.createElement("canvas");
    tile.width = size.w;
    tile.height = size.h;
    const tileCtx = tile.getContext("2d", { willReadFrequently: true })!;
    tileCtx.drawImage(image, 0, 0);
    const mask = tileCtx.getImageData(0, 0, size.w, size.h).data;
    masks.set(name, mask);
    return mask;
  }
  function silhouetteOf(name: string, colour: string): HTMLCanvasElement | undefined {
    const key = `${name}|${colour}`;
    const known = outlines.get(key);
    if (known !== undefined) return known;
    const image = sheet.images.get(name);
    const size = sheet.sizes[name];
    if (image === undefined || size === undefined) return undefined;
    const tile = document.createElement("canvas");
    tile.width = size.w;
    tile.height = size.h;
    const tileCtx = tile.getContext("2d")!;
    tileCtx.drawImage(image, 0, 0);
    tileCtx.globalCompositeOperation = "source-in";
    tileCtx.fillStyle = colour;
    tileCtx.fillRect(0, 0, size.w, size.h);
    outlines.set(key, tile);
    return tile;
  }

  function fitCamera(): Camera {
    const width = bounds.right - bounds.left;
    const height = bounds.bottom - bounds.top;
    const zoom = Math.min((canvas.width * ZOOM.fitFill) / width, (canvas.height * ZOOM.fitFill) / height);
    return { zoom, cx: (bounds.left + bounds.right) / 2, cy: (bounds.top + bounds.bottom) / 2 };
  }
  const limits = (): { min: number; max: number } => {
    const fit = fitCamera().zoom;
    return { min: Math.min(fit, ZOOM.max) * ZOOM.min, max: Math.max(ZOOM.max, fit) };
  };

  function resize(): void {
    dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(host.clientWidth * dpr));
    const height = Math.max(1, Math.round(host.clientHeight * dpr));
    if (canvas.width === width && canvas.height === height) return;
    canvas.width = width;
    canvas.height = height;
    if (town !== undefined && flight === undefined && !touched) camera = fitCamera();
    dirty = true;
  }
  let touched = false;

  const screenOf = (x: number, y: number): { x: number; y: number } => ({
    x: Math.round((x - camera.cx) * camera.zoom + canvas.width / 2),
    y: Math.round((y - camera.cy) * camera.zoom + canvas.height / 2),
  });
  const groundScreen = (X: number, Y: number, Z = 0): { x: number; y: number } => {
    const at = project(X, Y, Z);
    return screenOf(at.x, at.y);
  };

  // A repeating fleck of lighter water, anchored to the picture so it pans with it.
  const seaTile = ((): HTMLCanvasElement => {
    const tile = document.createElement("canvas");
    tile.width = 256;
    tile.height = 128;
    const tileCtx = tile.getContext("2d")!;
    tileCtx.fillStyle = COLOUR.sea;
    tileCtx.fillRect(0, 0, 256, 128);
    tileCtx.fillStyle = COLOUR.seaLight;
    let seed = 7;
    for (let i = 0; i < 26; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const x = (seed >>> 8) % 128 * 2;
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const y = (seed >>> 8) % 64 * 2;
      tileCtx.fillRect(x, y, 6 + ((seed >>> 4) % 4) * 2, 2);
    }
    return tile;
  })();

  function polygon(points: readonly (readonly [number, number])[], fill: string | CanvasPattern, dy = 0): void {
    ctx.beginPath();
    points.forEach(([X, Y], index) => {
      const at = groundScreen(X, Y);
      if (index === 0) ctx.moveTo(at.x, at.y + dy);
      else ctx.lineTo(at.x, at.y + dy);
    });
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  }
  const rect = (X0: number, Y0: number, X1: number, Y1: number): [number, number][] => [[X0, Y0], [X1, Y0], [X1, Y1], [X0, Y1]];

  /** What the last frame drew, as drawn: picking reads these, never the camera, so rounding is inverted exactly. */
  let placements: Placement<Pick>[] = [];
  /** The building thing of each lot: what its name stands for when picked. */
  const buildingOf = new Map<Lot, Thing>();
  let plaques: Plaque<Pick>[] = [];
  function drawSprite(name: string, X: number, Y: number, line?: string, owner?: Pick, Z = 0): { x: number; y: number; w: number; h: number } | undefined {
    const image = sheet.images.get(name);
    const size = sheet.sizes[name];
    if (image === undefined || size === undefined) return undefined;
    const at = groundScreen(X, Y, Z);
    const box = {
      x: Math.round(at.x - size.ox * camera.zoom),
      y: Math.round(at.y - size.oy * camera.zoom),
      w: Math.max(1, Math.round(size.w * camera.zoom)),
      h: Math.max(1, Math.round(size.h * camera.zoom)),
    };
    if (box.x > canvas.width || box.y > canvas.height || box.x + box.w < 0 || box.y + box.h < 0) return box;
    if (owner !== undefined) placements.push({ thing: owner, box, cols: size.w, rows: size.h });
    if (line !== undefined) {
      const spread = Math.max(2, Math.round(2 * dpr));
      const tile = silhouetteOf(name, line);
      if (tile !== undefined) for (const [dx, dy] of [[spread, 0], [-spread, 0], [0, spread], [0, -spread]] as const) ctx.drawImage(tile, box.x + dx, box.y + dy, box.w, box.h);
    }
    ctx.drawImage(image, box.x, box.y, box.w, box.h);
    return box;
  }
  /** The colour a thing is outlined in: selected or highlighted, or pointed at. */
  function outlineOf(thing: Thing): string | undefined {
    if (thing.kind === "mark") return undefined;
    if (thing.kind === "pier") return thing.pier.kind === chosen ? COLOUR.select : thing === hovered ? COLOUR.hover : undefined;
    if (thing.part !== "building") return undefined;
    if (thing.lot.id === selected) return COLOUR.select;
    if (highlighted.has(thing.lot.id)) return chosen === undefined ? COLOUR.select : EFFECT_COLOR;
    return thing === hovered ? COLOUR.hover : undefined;
  }

  /** The boxes names already took this frame; a name that would cover one is left out, and shows when the camera is closer. */
  let taken: { left: number; top: number; right: number; bottom: number }[] = [];
  function pill(text: string, x: number, y: number, size: number, edge: string, maxWidth = Infinity, avoid = false, owner?: Pick): boolean {
    ctx.font = `600 ${size}px ui-monospace, Menlo, Consolas, monospace`;
    let shown = text;
    while (shown.length > 1 && ctx.measureText(shown).width + size * 0.8 > maxWidth) shown = `${shown.slice(0, -2)}…`;
    const w = Math.ceil(ctx.measureText(shown).width + size * 0.8);
    const h = Math.round(size * 1.5);
    const left = Math.round(x - w / 2);
    const top = Math.round(y - h / 2);
    const box = { left, top, right: left + w, bottom: top + h };
    if (avoid && taken.some((other) => box.left < other.right && other.left < box.right && box.top < other.bottom && other.top < box.bottom)) return false;
    taken.push(box);
    if (owner !== undefined) plaques.push({ thing: owner, box: { x: left, y: top, w, h } });
    ctx.fillStyle = COLOUR.pill;
    ctx.fillRect(left, top, w, h);
    ctx.lineWidth = Math.max(1, Math.round(size / 11));
    ctx.strokeStyle = edge;
    ctx.strokeRect(left + 0.5, top + 0.5, w - 1, h - 1);
    ctx.fillStyle = COLOUR.name;
    ctx.fillText(shown, Math.round(x), Math.round(y + 1));
    return true;
  }

  /** The new path of a moved file, written on the face of its sign's board and skewed to lie on it. */
  function boardText(path: string, X: number, Y: number): void {
    const BOARD = { w: 118, h: 44 };
    const k = camera.zoom / 100;
    // The board's face is on the -Y side of the post, 0.93 m up; the text's unit is a hundredth of a metre.
    const middle = groundScreen(X, Y - 0.085, 0.93);
    const slash = path.lastIndexOf("/");
    const lines = slash < 0 ? [path] : [path.slice(0, slash + 1), path.slice(slash + 1)];
    const size = lines.length === 1 ? 26 : 19;
    ctx.save();
    ctx.setTransform(AXIS * k, (AXIS / 2) * k, 0, RISE_UNIT * k, middle.x, middle.y);
    ctx.fillStyle = "#2b1d10";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const lineHeight = Math.min(size * 1.15, BOARD.h / lines.length);
    lines.forEach((line, index) => {
      // Shrink to fit down to a floor, then cut: the end of a path is what tells files apart, so a long one loses its start.
      ctx.font = `600 ${size}px ui-monospace, Menlo, Consolas, monospace`;
      const fitted = Math.max(11, Math.min(size, (size * BOARD.w) / Math.max(1, ctx.measureText(line).width)));
      ctx.font = `600 ${fitted}px ui-monospace, Menlo, Consolas, monospace`;
      let shown = line;
      while (shown.length > 2 && ctx.measureText(shown).width > BOARD.w) shown = `\u2026${shown.slice(2)}`;
      ctx.fillText(shown, 0, (index - (lines.length - 1) / 2) * lineHeight);
    });
    ctx.restore();
  }

  function draw(): void {
    ctx.imageSmoothingEnabled = false;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = COLOUR.sea;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (town === undefined) return;
    const sea = ctx.createPattern(seaTile, "repeat");
    if (sea !== null) {
      sea.setTransform(new DOMMatrix().translate(canvas.width / 2 - camera.cx * camera.zoom, canvas.height / 2 - camera.cy * camera.zoom).scale(camera.zoom));
      ctx.fillStyle = sea;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    const lift = Math.round(16 * camera.zoom);
    polygon(town.coast, COLOUR.sandDark, lift);
    polygon(town.coast, COLOUR.sand);
    polygon(town.lawn, COLOUR.grass);

    if (town.piers.length > 0) {
      const half = town.piers.length * 2.2 + 1;
      polygon(rect(town.quay.X - 2.6, -half, town.quay.X + 2.6, half), COLOUR.quay);
      for (const pier of town.piers) {
        polygon(rect(town.quay.X + 2.6, pier.Y - 1.3, town.quay.X + 9.5, pier.Y - 0.3), COLOUR.woodDark, Math.round(8 * camera.zoom));
        polygon(rect(town.quay.X + 2.6, pier.Y - 1.3, town.quay.X + 9.5, pier.Y - 0.3), COLOUR.wood);
      }
    }
    // Each block's pad is lighter than the one it is inside and has its own kerb, so blocks within blocks read as such.
    for (const block of allBlocks(town)) {
      const kerb = block.depth === 0 ? 0.18 : 0.12;
      polygon(rect(block.X0 - kerb, block.Y0 - kerb, block.X1 + kerb, block.Y1 + kerb), block.depth === 0 ? COLOUR.kerb : COLOUR.innerKerb);
      polygon(rect(block.X0, block.Y0, block.X1, block.Y1), COLOUR.pads[Math.min(block.depth, COLOUR.pads.length - 1)]!);
    }

    // Bare earth under a new file's building.
    for (const lot of town.lots) {
      if (lot.change === "added") polygon(rect(lot.X - LOT / 2 + 0.25, lot.Y - LOT / 2 + 0.25, lot.X + LOT / 2 - 0.25, lot.Y + LOT / 2 - 0.25), COLOUR.earth);
    }

    placements = [];
    plaques = [];
    // Footpaths lie on the ground, under everything that stands.
    for (const lot of town.lots) if (lot.reached && lot.change !== "removed" && lot.change !== "moved-away") drawSprite("footpath-y", footpathAt(lot).X, footpathAt(lot).Y);
    for (const thing of things) {
      drawSprite(thing.sprite, thing.X, thing.Y, outlineOf(thing), thing.kind === "mark" ? undefined : thing, thing.Z);
      if (thing.kind === "lot" && thing.part === "moved-sign" && thing.lot.movedTo !== null) boardText(thing.lot.movedTo.path, thing.X, thing.Y);
    }

    // Names go on top of everything, so a building never hides one. Far away only blocks are named, in
    // large type; close in the files are named too.
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    taken = [];
    // Every harbour structure is named; where far away they would stack on each other, each moves down
    // out of the previous one's way.
    let lowest = -Infinity;
    for (const pier of [...town.piers].reverse()) {
      const size = sheet.sizes[pier.sprite];
      const at = groundScreen(pier.X, pier.Y, 0);
      const owner = things.find((thing) => thing.kind === "pier" && thing.pier === pier);
      const height = Math.round(13 * dpr * 1.5);
      const y = Math.max(at.y - Math.round((size?.oy ?? 200) * camera.zoom) - Math.round(14 * dpr), lowest + height + 2);
      lowest = y;
      pill(pier.kind, at.x, y, Math.round(13 * dpr), COLOUR.pierEdge, Infinity, false, owner);
    }
    const files = namesAt(camera.zoom) === "files";
    // Changed blocks are named first, then the rest from the largest, so a crowded picture loses the quietest names.
    const touched = (block: Block): boolean => block.changes.added + block.changes.altered + block.changes.removed + block.changes.moved > 0;
    const named = allBlocks(town)
      .filter((block) => block.id === focused || blockNamedAt(camera.zoom, block.depth))
      .sort((a, b) => Number(b.id === focused) - Number(a.id === focused) || Number(touched(b)) - Number(touched(a)) || a.depth - b.depth);
    for (const block of named) {
      const text = blockLabel(block, town.comparing, !files);
      const edge = block.fence === null ? COLOUR.pillEdge : COLOUR.mark;
      const midX = (block.X0 + block.X1) / 2;
      const midY = (block.Y0 + block.Y1) / 2;
      const owner: BlockName = { kind: "block", block };
      // Far away a top-level name tries the middle, then each edge, then a smaller size, and the first free place takes it;
      // a nested name stands on its block's far edge, in the clear ground the block keeps there.
      const spots =
        block.depth > 0
          ? [
              groundScreen(midX, block.Y1 + 0.9, 0),
              groundScreen(midX, block.Y1 - 0.5, 0),
              groundScreen(midX, block.Y0, 0),
              groundScreen(block.X0, midY, 0),
              groundScreen(block.X1, midY, 0),
              groundScreen(block.X0, block.Y1, 0),
              groundScreen(block.X1, block.Y1, 0),
              groundScreen(block.X0, block.Y0, 0),
              groundScreen(block.X1, block.Y0, 0),
              groundScreen(midX, midY, 7),
            ]
          : files
            ? [groundScreen(midX, block.Y1 + 0.9, 0)]
            : [groundScreen(midX, midY, 7), groundScreen(midX, block.Y0, 0), groundScreen(block.X1, midY, 0), groundScreen(block.X0, midY, 0), groundScreen(midX, block.Y1, 0)];
      for (const size of block.depth > 0 ? [13, 11] : files ? [15] : [20, 15, 12]) {
        if (spots.some((spot) => pill(text, spot.x, spot.y, Math.round(size * dpr), edge, Infinity, true, owner))) break;
      }
      if (files && block.fence !== null) {
        const sign = groundScreen(block.fence.sign.X, block.fence.sign.Y, 3.7);
        pill(block.fence.text, sign.x, sign.y, Math.round(17 * dpr), COLOUR.mark, Infinity, true);
      }
    }
    if (files) {
      for (const lot of town.lots) {
        if (!lot.named) continue;
        // An altered file's name stands over its crane, where the change shows above the roofs.
        const at = lot.crane ? groundScreen(lot.X + CRANE_AT.X, lot.Y + CRANE_AT.Y, 8.9) : groundScreen(lot.X, lot.Y, 0);
        if (at.x < -200 || at.y < -100 || at.x > canvas.width + 200 || at.y > canvas.height + 200) continue;
        pill(lot.name, at.x, lot.crane ? at.y : at.y + Math.round(30 * camera.zoom), Math.round(11 * dpr), lot.change === "altered" ? COLOUR.mark : COLOUR.pillEdge, 2 * LOT * AXIS * camera.zoom * 0.9, false, buildingOf.get(lot));
      }
    }
  }

  // Picking: the topmost sprite whose drawn pixel lies under the pointer, else the lot's ground.
  function thingAt(clientX: number, clientY: number): Pick | undefined {
    const rectOf = canvas.getBoundingClientRect();
    const px = (clientX - rectOf.left) * dpr;
    const py = (clientY - rectOf.top) * dpr;
    if (dirty) {
      dirty = false;
      draw();
    }
    const found = pickAt(plaques, placements, px, py, (thing, column, row) => {
      if (thing.kind === "block") return false;
      const mask = maskOf(thing.sprite);
      const size = sheet.sizes[thing.sprite];
      return mask !== undefined && size !== undefined && mask[(row * size.w + column) * 4 + 3]! > 8;
    });
    if (found !== undefined) return found;
    // Empty ground in a lot: in the diamond of the lot.
    const ground = groundUnder(px, py);
    for (let i = things.length - 1; i >= 0; i--) {
      const thing = things[i]!;
      if (thing.kind === "lot" && thing.part === "building" && Math.abs(ground.X - thing.X) <= LOT / 2 && Math.abs(ground.Y - thing.Y) <= LOT / 2) return thing;
    }
    return undefined;
  }
  function blockAt(clientX: number, clientY: number): Block | undefined {
    const rectOf = canvas.getBoundingClientRect();
    const ground = groundUnder((clientX - rectOf.left) * dpr, (clientY - rectOf.top) * dpr);
    return town === undefined ? undefined : blockAtGround(town, ground.X, ground.Y);
  }
  /** The ground point under device pixel (px, py). */
  function groundUnder(px: number, py: number): { X: number; Y: number } {
    const x = (px - canvas.width / 2) / camera.zoom + camera.cx;
    const y = (py - canvas.height / 2) / camera.zoom + camera.cy;
    // x = (X + Y) * AXIS and y = (X - Y) * AXIS / 2
    return { X: (x / AXIS + (2 * y) / AXIS) / 2, Y: (x / AXIS - (2 * y) / AXIS) / 2 };
  }

  function clamp(next: Camera): Camera {
    const { min, max } = limits();
    const zoom = Math.min(max, Math.max(min, next.zoom));
    return { zoom, cx: Math.min(bounds.right, Math.max(bounds.left, next.cx)), cy: Math.min(bounds.bottom, Math.max(bounds.top, next.cy)) };
  }
  function flyTo(to: Camera): void {
    touched = true;
    flight = { from: camera, to: clamp(to), start: performance.now() };
    dirty = true;
  }
  function step(now: number): void {
    if (flight !== undefined) {
      const t = Math.min(1, (now - flight.start) / FLIGHT_MS);
      const eased = t * t * (3 - 2 * t);
      const { from, to } = flight;
      camera = { zoom: from.zoom + (to.zoom - from.zoom) * eased, cx: from.cx + (to.cx - from.cx) * eased, cy: from.cy + (to.cy - from.cy) * eased };
      if (t === 1) flight = undefined;
      dirty = true;
    }
    if (dirty) {
      dirty = false;
      draw();
    }
    requestAnimationFrame(step);
  }

  // Pointer handling: drag pans, wheel zooms about the pointer, a click that barely moved picks.
  const pressed = new Map<number, { x: number; y: number }>();
  let pressedAt = { x: 0, y: 0 };
  let travelled = 0;
  /** The file a thing stands for. The rubble a moved file left stands for the file at its new path. */
  const idOf = (thing: Pick | undefined): NodeId | undefined => (thing?.kind === "lot" ? (thing.lot.movedTo?.id ?? thing.lot.id) : undefined);
  function hover(clientX: number, clientY: number): void {
    const thing = thingAt(clientX, clientY);
    if (thing !== hovered) {
      hovered = thing;
      dirty = true;
    }
    handlers.hover(idOf(thing), { x: clientX, y: clientY });
  }
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  canvas.addEventListener("pointerdown", (event) => {
    canvas.setPointerCapture(event.pointerId);
    pressed.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pressed.size > 1) return;
    pressedAt = { x: event.clientX, y: event.clientY };
    travelled = 0;
    flight = undefined;
    canvas.style.cursor = "grabbing";
  });
  canvas.addEventListener("pointermove", (event) => {
    const last = pressed.get(event.pointerId);
    if (last === undefined) {
      hover(event.clientX, event.clientY);
      return;
    }
    pressed.set(event.pointerId, { x: event.clientX, y: event.clientY });
    travelled = Math.max(travelled, Math.hypot(event.clientX - pressedAt.x, event.clientY - pressedAt.y));
    if (pressed.size === 1 && travelled >= CLICK_SLOP) {
      touched = true;
      camera = clamp({ ...camera, cx: camera.cx - ((event.clientX - last.x) * dpr) / camera.zoom, cy: camera.cy - ((event.clientY - last.y) * dpr) / camera.zoom });
      dirty = true;
    }
  });
  const release = (event: PointerEvent): void => {
    pressed.delete(event.pointerId);
    if (pressed.size === 0) canvas.style.cursor = "";
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
  canvas.addEventListener("pointerleave", () => {
    if (pressed.size > 0) return;
    hovered = undefined;
    dirty = true;
    handlers.hover(undefined, { x: 0, y: 0 });
  });
  canvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      touched = true;
      const rectOf = canvas.getBoundingClientRect();
      const px = (event.clientX - rectOf.left) * dpr;
      const py = (event.clientY - rectOf.top) * dpr;
      const factor = Math.exp(-event.deltaY * (event.deltaMode === 0 ? 0.0015 : 0.05));
      const { min, max } = limits();
      const zoom = Math.min(max, Math.max(min, camera.zoom * factor));
      // Keep the picture point under the pointer where it is.
      const wx = (px - canvas.width / 2) / camera.zoom + camera.cx;
      const wy = (py - canvas.height / 2) / camera.zoom + camera.cy;
      flight = undefined;
      camera = clamp({ zoom, cx: wx - (px - canvas.width / 2) / zoom, cy: wy - (py - canvas.height / 2) / zoom });
      dirty = true;
    },
    { passive: false },
  );
  canvas.addEventListener("click", (event) => {
    if (travelled >= CLICK_SLOP) return;
    const thing = thingAt(event.clientX, event.clientY);
    if (thing?.kind === "pier") handlers.resource(thing.pier.kind);
    else handlers.click(idOf(thing), event.detail);
  });
  canvas.addEventListener("dblclick", (event) => {
    if (travelled >= CLICK_SLOP) return;
    const thing = thingAt(event.clientX, event.clientY);
    if (thing?.kind === "lot") handlers.doubleClick({ kind: "building", id: thing.lot.id });
    else if (thing?.kind === "pier") handlers.doubleClick({ kind: "resource", resource: thing.pier.kind });
    else {
      const block = thing?.kind === "block" ? thing.block : blockAt(event.clientX, event.clientY);
      handlers.doubleClick(block === undefined ? undefined : { kind: "district", id: block.id });
    }
  });
  new ResizeObserver(resize).observe(host);
  requestAnimationFrame(step);

  function frameBlock(block: Block): Camera {
    const corners = [project(block.X0, block.Y0), project(block.X1, block.Y0), project(block.X0, block.Y1), project(block.X1, block.Y1)];
    const left = Math.min(...corners.map((c) => c.x));
    const right = Math.max(...corners.map((c) => c.x));
    // Buildings stand above their ground: leave room for the tallest sprite on top.
    const top = Math.min(...corners.map((c) => c.y)) - 520;
    const bottom = Math.max(...corners.map((c) => c.y)) + 60;
    const zoom = Math.min((canvas.width * 0.86) / (right - left), (canvas.height * 0.86) / (bottom - top));
    return { zoom, cx: (left + right) / 2, cy: (top + bottom) / 2 };
  }

  return {
    show(next) {
      town = next;
      const marks = (lot: Lot): Thing[] => {
        const mark = (part: Part, sprite: string, X: number, Y: number, bias: number, Z = 0): Thing => ({ kind: "lot", lot, part, sprite, X, Y, Z, key: X - Y + bias });
        return [
          ...(lot.plinth === undefined ? [] : [mark("plinth", lot.plinth, lot.X, lot.Y, -0.05)]),
          mark("building", lot.sprite, lot.X, lot.Y, 0, lot.raise),
          ...(lot.overlay === null ? [] : [mark("scaffold", lot.overlay, lot.X, lot.Y, 0.01, lot.raise)]),
          ...(lot.gate ? [mark("gate", "gate", lot.X, lot.Y - GATE_FRONT, 0)] : []),
          ...(lot.crane ? [mark("crane", "crane", lot.X + CRANE_AT.X, lot.Y + CRANE_AT.Y, -0.2)] : []),
          ...(lot.movedTo === null ? [] : [mark("moved-sign", "sign-moved", lot.X + MOVED_SIGN_AT.X, lot.Y + MOVED_SIGN_AT.Y, 0)]),
        ];
      };
      const fences = (block: Block): Thing[] =>
        block.fence === null
          ? []
          : [...block.fence.posts.map((post) => ({ sprite: post.sprite, X: post.X, Y: post.Y })), { sprite: "sign", X: block.fence.sign.X, Y: block.fence.sign.Y }].map(
              (mark): Thing => ({ kind: "mark", ...mark, Z: 0, key: mark.X - mark.Y }),
            );
      things = [
        ...next.lots.flatMap(marks),
        ...allBlocks(next).flatMap(fences),
        ...next.piers.map((pier): Thing => ({ kind: "pier", pier, sprite: pier.sprite, X: pier.X, Y: pier.Y, Z: 0, key: pier.X - pier.Y })),
      ]
        .map((thing, index) => ({ thing, index }))
        .sort((a, b) => a.thing.key - b.thing.key || a.index - b.index)
        .map((entry) => entry.thing);
      buildingOf.clear();
      for (const thing of things) if (thing.kind === "lot" && thing.part === "building") buildingOf.set(thing.lot, thing);
      const shore = next.coast.map(([X, Y]) => project(X, Y));
      const wide = next.piers.length > 0 ? project(next.quay.X + 9.5, 0).x : -Infinity;
      bounds = {
        left: Math.min(...shore.map((p) => p.x)) - 200,
        right: Math.max(wide + 200, ...shore.map((p) => p.x)) + 200,
        top: Math.min(...shore.map((p) => p.y)) - 300,
        bottom: Math.max(...shore.map((p) => p.y)) + 100,
      };
      if (!Number.isFinite(bounds.left)) bounds = { left: 0, right: 1, top: 0, bottom: 1 };
      touched = false;
      focused = undefined;
      selected = undefined;
      highlighted = new Set();
      chosen = undefined;
      resize();
      camera = fitCamera();
      dirty = true;
    },
    select(id) {
      selected = id;
      dirty = true;
    },
    highlight(ids, kind) {
      highlighted = new Set(ids);
      chosen = kind;
      dirty = true;
    },
    flyTo(id) {
      // The smallest block holding the folder: a nested block's own pad when it is one.
      // The root frames the whole town: its synthetic block of loose files shares its id.
      const block = town === undefined || id === town.root ? undefined : allBlocks(town).filter((candidate) => candidate.id === id || candidate.folders.includes(id)).sort((a, b) => b.depth - a.depth)[0];
      focused = block?.id;
      if (block === undefined) flyTo(fitCamera());
      else flyTo(frameBlock(block));
    },
    reset() {
      touched = false;
      focused = undefined;
      flyTo(fitCamera());
    },
  };
}
