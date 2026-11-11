/** A rectangle in device pixels, exactly as it was drawn: already rounded. */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** A sprite as drawn: its box on the canvas and its size in the sheet's own pixels. */
export interface Placement<T> {
  readonly thing: T;
  readonly box: Box;
  readonly cols: number;
  readonly rows: number;
}

/** A name as drawn. */
export interface Plaque<T> {
  readonly thing: T;
  readonly box: Box;
}

const within = (box: Box, px: number, py: number): boolean => px >= box.x && py >= box.y && px < box.x + box.w && py < box.y + box.h;

/**
 * What the pixel (px, py) shows: a name first, since names are drawn over everything, then the
 * sprites from the front-most, the first whose drawn pixel is opaque. Both lists are in drawing
 * order, and the boxes are the ones the drawing used, so picking inverts exactly what was drawn,
 * rounding included.
 */
export function pickAt<T>(
  plaques: readonly Plaque<T>[],
  placements: readonly Placement<T>[],
  px: number,
  py: number,
  opaque: (thing: T, column: number, row: number) => boolean,
): T | undefined {
  for (let i = plaques.length - 1; i >= 0; i--) {
    if (within(plaques[i]!.box, px, py)) return plaques[i]!.thing;
  }
  for (let i = placements.length - 1; i >= 0; i--) {
    const { thing, box, cols, rows } = placements[i]!;
    if (!within(box, px, py)) continue;
    const column = Math.min(cols - 1, Math.floor(((px - box.x) * cols) / box.w));
    const row = Math.min(rows - 1, Math.floor(((py - box.y) * rows) / box.h));
    if (opaque(thing, column, row)) return thing;
  }
  return undefined;
}
