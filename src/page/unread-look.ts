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
