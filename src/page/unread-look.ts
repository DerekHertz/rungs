import type { UnreadFile } from "../compare.ts";
import type { FileNode } from "../graph.ts";
import type { Lot } from "../town.ts";

/** The edge of the name plate on a building that could not be fully read: a warning yellow, apart from the changed orange. */
export const UNREAD_EDGE = "#ffd21f";

/** How the building of a file that could not be fully read is painted: its colour drained, so it is plainly not the same as a read one. */
export const UNREAD_FILTER = "grayscale(1) brightness(0.8)";

/** Draws `paint` in the unread look when `unread`, and restores the canvas either way. */
export function paintUnread(ctx: CanvasRenderingContext2D, unread: boolean, paint: () => void): void {
  if (!unread) {
    paint();
    return;
  }
  const before = ctx.filter;
  ctx.filter = UNREAD_FILTER;
  paint();
  ctx.filter = before;
}

const WHICH = { head: "the file as the change leaves it", base: "the file as it was before the change", both: "the file before and after the change" } as const;

/** The last lines of a file's hover card: what the adapter read, or exactly that it did not. `sides` says which version failed under a comparison. */
export function unreadFacts(file: FileNode, lot: Pick<Lot, "functions" | "classes">, sides: ReadonlyMap<string, UnreadFile["side"]>): string[] {
  if (file.analysis === "analysed") return [`functions: ${lot.functions}   classes: ${lot.classes}`];
  if (file.analysis === "not analysed") return ["not analysed"];
  const side = sides.get(file.path);
  return [
    "could not fully read: syntax errors",
    ...(side === undefined ? [] : [`syntax errors in ${WHICH[side]}`]),
    "functions, classes, contract and calls: not read",
    ...(side === undefined ? [] : ["nothing in it is compared"]),
  ];
}

/** The dashed outline that says a plinth is "at least this tall": pale, over a dark line, so it reads on stone, grass and any building behind it. */
export const AT_LEAST_EDGE = "#f6f3ea";
const AT_LEAST_SHADOW = "#1b1712";

/**
 * Draws the dashed footprint of a plinth whose height is only a floor: a file that could not be
 * read may import the file, so more may rest on it than the stone shows. `corners` are the four
 * corners of the stone's top, in screen pixels, in order around it; `unit` is one line width in
 * screen pixels. Only an outline: no height is drawn for the unknown part.
 */
export function paintAtLeast(ctx: CanvasRenderingContext2D, corners: readonly { x: number; y: number }[], unit: number): void {
  const path = (): void => {
    ctx.beginPath();
    corners.forEach((c, index) => (index === 0 ? ctx.moveTo(c.x, c.y) : ctx.lineTo(c.x, c.y)));
    ctx.closePath();
  };
  ctx.save();
  ctx.lineJoin = "miter";
  path();
  ctx.setLineDash([]);
  ctx.strokeStyle = AT_LEAST_SHADOW;
  ctx.lineWidth = unit * 2.5;
  ctx.stroke();
  path();
  ctx.setLineDash([unit * 3, unit * 2]);
  ctx.strokeStyle = AT_LEAST_EDGE;
  ctx.lineWidth = unit;
  ctx.stroke();
  ctx.restore();
}
