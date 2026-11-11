import type { LineRange, NodeId } from "../graph.ts";
import { AXIS, project } from "../town.ts";
import { pickAt } from "../town-pick.ts";
import type { Placement, Plaque } from "../town-pick.ts";
import { roomNamesAt } from "../town-inside.ts";
import type { Inside, Room, RoomObject } from "../town-inside.ts";
import { EFFECT_COLOR } from "./palette.ts";
import type { Sheet } from "./town-view.ts";

/*
 * Draws one file's inside (src/town-inside.ts) over the town, walls down, from the same sprite
 * sheet and the same fixed isometric angle. It owns a canvas that covers the stage while a file is
 * open; closing it hands the stage back to the town untouched.
 */

export interface InsideCallbacks {
  /** A click on a room (its function, or the file for the top-level room) or on an object, with the call's lines for an object. */
  pick(id: NodeId, lines?: LineRange): void;
  /** What the pointer is over, as words, and where the pointer is (client pixels); undefined text when over nothing. */
  hover(text: string | undefined, at?: { x: number; y: number }): void;
}

export interface TownInsideView {
  open(inside: Inside): void;
  close(): void;
  readonly isOpen: boolean;
  /** Outlines this room (a function id) as the selected one. */
  select(id: NodeId | undefined): void;
}

const COLOUR = {
  ground: "#2b3a33", edge: "#3d4050", name: "#f2f4f7", pill: "rgba(5,7,10,0.86)", pillEdge: "#39424e",
  select: "#ffffff", sea: "#12304a",
};
const ZOOM = { fitFill: 0.9, fitMax: 1.6, min: 0.5, max: 2.5 };
const CLICK_SLOP = 4;
const HALF = AXIS / 2;

type Piece =
  | { readonly kind: "wall"; readonly sprite: string; readonly X: number; readonly Y: number; readonly room: NodeId }
  | { readonly kind: "cone"; readonly sprite: string; readonly X: number; readonly Y: number; readonly room: NodeId }
  | { readonly kind: "object"; readonly sprite: string; readonly X: number; readonly Y: number; readonly room: NodeId; readonly object: RoomObject };

/** What a click can land on: an object, or a room by its name. */
type Target = { readonly kind: "object"; readonly piece: Piece & { readonly kind: "object" } } | { readonly kind: "room"; readonly room: Room; /** The sprite drawn, when a wall, cone or floor tile stands for its room. */ readonly sprite?: string };

interface Camera {
  zoom: number;
  cx: number;
  cy: number;
}

export function createTownInsideView(host: HTMLElement, callbacks: InsideCallbacks, sheet: Sheet): TownInsideView {
  const canvas = document.createElement("canvas");
  canvas.style.cssText = `position:absolute;inset:0;width:100%;height:100%;display:none;touch-action:none;background:${COLOUR.sea}`;
  canvas.setAttribute("aria-label", "Inside of a file");
  // Just above the town's canvas and below the page's own controls.
  if (host.firstElementChild === null) host.prepend(canvas);
  else host.firstElementChild.after(canvas);
  const ctx = canvas.getContext("2d")!;

  let inside: Inside | undefined;
  let pieces: Piece[] = [];
  let roomsById = new Map<NodeId, Room>();
  let bounds = { left: 0, right: 1, top: 0, bottom: 1 };
  let camera: Camera = { zoom: 1, cx: 0, cy: 0 };
  let selected: NodeId | undefined;
  let touched = false;
  let dirty = true;
  let dpr = 1;

  const masks = new Map<string, Uint8ClampedArray>();
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

  function fitCamera(): Camera {
    const width = bounds.right - bounds.left;
    const height = bounds.bottom - bounds.top;
    const zoom = Math.min(ZOOM.fitMax, (canvas.width * ZOOM.fitFill) / width, (canvas.height * ZOOM.fitFill) / height);
    return { zoom, cx: (bounds.left + bounds.right) / 2, cy: (bounds.top + bounds.bottom) / 2 };
  }
  const limits = (): { min: number; max: number } => {
    const fit = fitCamera().zoom;
    return { min: fit * ZOOM.min, max: Math.max(ZOOM.max, fit) };
  };
  function clamp(next: Camera): Camera {
    const { min, max } = limits();
    return { zoom: Math.min(max, Math.max(min, next.zoom)), cx: Math.min(bounds.right, Math.max(bounds.left, next.cx)), cy: Math.min(bounds.bottom, Math.max(bounds.top, next.cy)) };
  }
  function resize(): void {
    dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(host.clientWidth * dpr));
    const height = Math.max(1, Math.round(host.clientHeight * dpr));
    if (canvas.width === width && canvas.height === height) return;
    canvas.width = width;
    canvas.height = height;
    if (inside !== undefined && !touched) camera = fitCamera();
    dirty = true;
  }

  const groundScreen = (X: number, Y: number, Z = 0): { x: number; y: number } => {
    const at = project(X, Y, Z);
    return { x: Math.round((at.x - camera.cx) * camera.zoom + canvas.width / 2), y: Math.round((at.y - camera.cy) * camera.zoom + canvas.height / 2) };
  };
  function groundUnder(px: number, py: number): { X: number; Y: number } {
    const x = (px - canvas.width / 2) / camera.zoom + camera.cx;
    const y = (py - canvas.height / 2) / camera.zoom + camera.cy;
    return { X: (x / AXIS + (2 * y) / AXIS) / 2, Y: (x / AXIS - (2 * y) / AXIS) / 2 };
  }

  /** What the last frame drew, as drawn: picking reads these, never the camera, so rounding is inverted exactly. */
  let placements: Placement<Target>[] = [];
  let plaques: Plaque<Target>[] = [];
  function drawSprite(name: string, X: number, Y: number, owner?: Target): void {
    const image = sheet.images.get(name);
    const size = sheet.sizes[name];
    if (image === undefined || size === undefined) return;
    const at = groundScreen(X, Y);
    const x = Math.round(at.x - size.ox * camera.zoom);
    const y = Math.round(at.y - size.oy * camera.zoom);
    const w = Math.max(1, Math.round(size.w * camera.zoom));
    const h = Math.max(1, Math.round(size.h * camera.zoom));
    if (owner !== undefined) placements.push({ thing: owner, box: { x, y, w, h }, cols: size.w, rows: size.h });
    if (x > canvas.width || y > canvas.height || x + w < 0 || y + h < 0) return;
    ctx.drawImage(image, x, y, w, h);
  }

  function diamond(X0: number, Y0: number, X1: number, Y1: number, fill?: string, line?: string, width = 1): void {
    ctx.beginPath();
    [[X0, Y0], [X1, Y0], [X1, Y1], [X0, Y1]].forEach(([X, Y], index) => {
      const at = groundScreen(X!, Y!);
      if (index === 0) ctx.moveTo(at.x, at.y);
      else ctx.lineTo(at.x, at.y);
    });
    ctx.closePath();
    if (fill !== undefined) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (line !== undefined) {
      ctx.lineWidth = width;
      ctx.strokeStyle = line;
      ctx.stroke();
    }
  }

  let taken: { left: number; top: number; right: number; bottom: number }[] = [];
  function pill(text: string, x: number, y: number, size: number, edge: string, avoid: boolean, owner?: Target): void {
    ctx.font = `600 ${size}px ui-monospace, Menlo, Consolas, monospace`;
    const w = Math.ceil(ctx.measureText(text).width + size * 0.8);
    const h = Math.round(size * 1.5);
    const left = Math.round(x - w / 2);
    const top = Math.round(y - h / 2);
    const box = { left, top, right: left + w, bottom: top + h };
    if (avoid && taken.some((other) => box.left < other.right && other.left < box.right && box.top < other.bottom && other.top < box.bottom)) return;
    taken.push(box);
    if (owner !== undefined) plaques.push({ thing: owner, box: { x: left, y: top, w, h } });
    ctx.fillStyle = COLOUR.pill;
    ctx.fillRect(left, top, w, h);
    ctx.lineWidth = Math.max(1, Math.round(size / 11));
    ctx.strokeStyle = edge;
    ctx.strokeRect(left + 0.5, top + 0.5, w - 1, h - 1);
    ctx.fillStyle = COLOUR.name;
    ctx.fillText(text, Math.round(x), Math.round(y + 1));
  }

  function draw(): void {
    ctx.imageSmoothingEnabled = false;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = COLOUR.sea;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    placements = [];
    plaques = [];
    if (inside === undefined) return;
    const g = inside.ground;
    diamond(g.X0, g.Y0, g.X1, g.Y1, COLOUR.ground, COLOUR.edge, Math.max(2, Math.round(3 * camera.zoom)));
    for (const tile of inside.floors) {
      const room = roomsById.get(tile.room);
      drawSprite(tile.sprite, tile.X, tile.Y, room === undefined ? undefined : { kind: "room", room, sprite: tile.sprite });
    }
    for (const piece of pieces) {
      if (piece.kind === "object" && piece.object.altered) {
        const at = groundScreen(piece.X, piece.Y);
        ctx.beginPath();
        ctx.ellipse(at.x, at.y, 0.72 * AXIS * camera.zoom, 0.72 * HALF * camera.zoom, 0, 0, Math.PI * 2);
        ctx.lineWidth = Math.max(3, Math.round(6 * camera.zoom));
        ctx.strokeStyle = EFFECT_COLOR;
        ctx.stroke();
      }
      const room = roomsById.get(piece.room);
      // Everything drawn is a target in draw order, so a wall hides what stands behind it: it selects its room.
      drawSprite(piece.sprite, piece.X, piece.Y, piece.kind === "object" ? { kind: "object", piece } : room === undefined ? undefined : { kind: "room", room, sprite: piece.sprite });
    }
    const chosen = selected === undefined ? undefined : roomsById.get(selected);
    if (chosen !== undefined) diamond(chosen.X0 - 0.5, chosen.Y0 - 0.5, chosen.X0 + chosen.side - 0.5, chosen.Y0 + chosen.side - 0.5, undefined, COLOUR.select, Math.max(2, Math.round(2.5 * dpr)));

    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    taken = [];
    const top = groundScreen((g.X0 + g.X1) / 2, g.Y1);
    pill(inside.path, top.x, top.y - Math.round(16 * dpr), Math.round(16 * dpr), COLOUR.pillEdge, true);
    for (const room of inside.rooms) {
      for (const object of room.objects) {
        if (object.name === null) continue;
        const size = sheet.sizes[object.sprite];
        const at = groundScreen(object.X, object.Y);
        const piece = pieces.find((candidate) => candidate.kind === "object" && candidate.object === object);
        pill(object.name, at.x, at.y - Math.round((size?.oy ?? 60) * camera.zoom) - Math.round(10 * dpr), Math.round(12 * dpr), EFFECT_COLOR, true, piece?.kind === "object" ? { kind: "object", piece } : undefined);
      }
    }
    if (roomNamesAt(camera.zoom)) {
      for (const room of inside.rooms) {
        const at = groundScreen(room.X0 + (room.side - 1) / 2, room.Y0 - 0.5);
        pill(room.name, at.x, at.y + Math.round(16 * dpr), Math.round(12 * dpr), room.changed ? EFFECT_COLOR : COLOUR.pillEdge, true, { kind: "room", room });
      }
    }
  }

  function roomAt(clientX: number, clientY: number): Room | undefined {
    const rectOf = canvas.getBoundingClientRect();
    const ground = groundUnder((clientX - rectOf.left) * dpr, (clientY - rectOf.top) * dpr);
    return inside?.rooms.find(
      (room) => ground.X >= room.X0 - 0.5 && ground.X <= room.X0 + room.side - 0.5 && ground.Y >= room.Y0 - 0.5 && ground.Y <= room.Y0 + room.side - 0.5,
    );
  }
  /** What the pointer is over as drawn: a name or an object first, else the room whose ground it is on. */
  function targetAt(clientX: number, clientY: number): Target | undefined {
    const rectOf = canvas.getBoundingClientRect();
    const px = (clientX - rectOf.left) * dpr;
    const py = (clientY - rectOf.top) * dpr;
    if (dirty) {
      dirty = false;
      draw();
    }
    const found = pickAt(plaques, placements, px, py, (target, column, row) => {
      const sprite = target.kind === "object" ? target.piece.sprite : target.sprite;
      if (sprite === undefined) return false;
      const mask = maskOf(sprite);
      const size = sheet.sizes[sprite];
      return mask !== undefined && size !== undefined && mask[(row * size.w + column) * 4 + 3]! > 8;
    });
    if (found !== undefined) return found;
    const room = roomAt(clientX, clientY);
    return room === undefined ? undefined : { kind: "room", room };
  }
  const describe = (target: Target | undefined): string | undefined => {
    if (target?.kind === "object") {
      const o = target.piece.object;
      return `${o.kind} · ${o.operation}${o.target === null ? "" : ` ${o.target}`}${o.altered ? " · new or changed" : ""}`;
    }
    if (target === undefined) return undefined;
    const room = target.room;
    return `${room.name}${room.exported ? " · exported" : ""}${room.changed ? " · changed" : ""}`;
  };

  const pressed = new Map<number, { x: number; y: number }>();
  let pressedAt = { x: 0, y: 0 };
  let travelled = 0;
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  canvas.addEventListener("pointerdown", (event) => {
    canvas.setPointerCapture(event.pointerId);
    pressed.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pressed.size > 1) return;
    pressedAt = { x: event.clientX, y: event.clientY };
    travelled = 0;
    canvas.style.cursor = "grabbing";
  });
  canvas.addEventListener("pointermove", (event) => {
    const last = pressed.get(event.pointerId);
    if (last === undefined) {
      callbacks.hover(describe(targetAt(event.clientX, event.clientY)), { x: event.clientX, y: event.clientY });
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
    callbacks.hover(undefined);
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
      const wx = (px - canvas.width / 2) / camera.zoom + camera.cx;
      const wy = (py - canvas.height / 2) / camera.zoom + camera.cy;
      camera = clamp({ zoom, cx: wx - (px - canvas.width / 2) / zoom, cy: wy - (py - canvas.height / 2) / zoom });
      dirty = true;
    },
    { passive: false },
  );
  canvas.addEventListener("click", (event) => {
    if (travelled >= CLICK_SLOP) return;
    const target = targetAt(event.clientX, event.clientY);
    if (target?.kind === "object") callbacks.pick(target.piece.object.owner, target.piece.object.range);
    else if (target?.kind === "room") callbacks.pick(target.room.id);
  });

  new ResizeObserver(resize).observe(host);
  const step = (): void => {
    if (dirty && inside !== undefined) {
      dirty = false;
      draw();
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);

  return {
    open(next) {
      inside = next;
      roomsById = new Map(next.rooms.map((room) => [room.id, room]));
      pieces = [
        ...next.walls.map((wall): Piece => ({ kind: "wall", sprite: wall.sprite, X: wall.X, Y: wall.Y, room: wall.room })),
        ...next.cones.map((cone): Piece => ({ kind: "cone", sprite: cone.sprite, X: cone.X, Y: cone.Y, room: cone.room })),
        ...next.rooms.flatMap((room) => room.objects.map((object): Piece => ({ kind: "object", sprite: object.sprite, X: object.X, Y: object.Y, room: room.id, object }))),
      ]
        .map((piece, index) => ({ piece, index }))
        .sort((a, b) => a.piece.X - a.piece.Y - (b.piece.X - b.piece.Y) || a.index - b.index)
        .map((entry) => entry.piece);
      const g = next.ground;
      const corners = [project(g.X0, g.Y0), project(g.X1, g.Y0), project(g.X0, g.Y1), project(g.X1, g.Y1)];
      bounds = {
        left: Math.min(...corners.map((c) => c.x)) - 60,
        right: Math.max(...corners.map((c) => c.x)) + 60,
        top: Math.min(...corners.map((c) => c.y)) - 120,
        bottom: Math.max(...corners.map((c) => c.y)) + 60,
      };
      selected = undefined;
      touched = false;
      canvas.style.display = "block";
      resize();
      camera = fitCamera();
      dirty = true;
    },
    close() {
      inside = undefined;
      pieces = [];
      canvas.style.display = "none";
      callbacks.hover(undefined);
    },
    get isOpen() {
      return inside !== undefined;
    },
    select(id) {
      selected = id;
      dirty = true;
    },
  };
}
