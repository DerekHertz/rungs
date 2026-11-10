/** A point or box on the screen, in pixels with y down; a box's x and y are its top-left. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** A name drawn over the picture, wanting the room of `box`. */
export interface Name {
  readonly id: string;
  readonly box: Box;
  /** The plan area of what it names; when two names collide the bigger area keeps its name. */
  readonly weight: number;
  /** The width on screen of what it names; Infinity for a name that is never too wide for it. */
  readonly region: number;
}

/** A name wider than this many times its region's width on screen is dropped. */
export const WIDE = 1.7;
/** Names keep at least this many pixels between them. */
export const NAME_GAP = 4;
/** Outlines that overlap by fewer pixels than this only touch. */
export const OVERLAP_SLOP = 3;

function overlaps(a: Box, b: Box, gap: number): boolean {
  return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
}

/**
 * Which of `names` to draw: those inside the viewport and not much wider than their region, where
 * of two that collide the one for the bigger area stays. A name that loses never hides another.
 * Ties go to the one listed first.
 */
export function visibleNames(names: readonly Name[], viewport: Box): Set<string> {
  const fitting = names.filter((name) => name.box.w <= WIDE * name.region && overlaps(name.box, viewport, 0));
  const ranked = fitting.map((name, order) => ({ name, order })).sort((a, b) => b.name.weight - a.name.weight || a.order - b.order);
  const kept: Name[] = [];
  for (const { name } of ranked) {
    if (kept.every((other) => !overlaps(name.box, other.box, NAME_GAP))) kept.push(name);
  }
  return new Set(kept.map((name) => name.id));
}

/** A building seen from the camera: its eight corners on screen, and how far it is from the camera. */
export interface Projected {
  readonly id: string;
  readonly corners: readonly Point[];
  /** Smaller is nearer. */
  readonly depth: number;
}

function cross(origin: Point, a: Point, b: Point): number {
  return (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x);
}

/** The convex outline of `points`, counter-clockwise on a y-up plane. */
export function hullOf(points: readonly Point[]): Point[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const chain = (ordered: readonly Point[]): Point[] => {
    const half: Point[] = [];
    for (const point of ordered) {
      while (half.length >= 2 && cross(half[half.length - 2]!, half[half.length - 1]!, point) <= 0) half.pop();
      half.push(point);
    }
    half.pop();
    return half;
  };
  return [...chain(sorted), ...chain([...sorted].reverse())];
}

function span(outline: readonly Point[], axis: Point): [number, number] {
  let low = Infinity;
  let high = -Infinity;
  for (const point of outline) {
    const along = point.x * axis.x + point.y * axis.y;
    low = Math.min(low, along);
    high = Math.max(high, along);
  }
  return [low, high];
}

/** Whether two convex outlines overlap by more than `slop` pixels along every edge normal. */
function overlap(a: readonly Point[], b: readonly Point[], slop: number): boolean {
  for (const outline of [a, b]) {
    for (let i = 0; i < outline.length; i++) {
      const from = outline[i]!;
      const to = outline[(i + 1) % outline.length]!;
      const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
      const axis = { x: (from.y - to.y) / length, y: (to.x - from.x) / length };
      const [aLow, aHigh] = span(a, axis);
      const [bLow, bHigh] = span(b, axis);
      if (Math.min(aHigh, bHigh) - Math.max(aLow, bLow) < slop) return false;
    }
  }
  return true;
}

function boundsOf(points: readonly Point[]): Box {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const point of points) {
    left = Math.min(left, point.x);
    top = Math.min(top, point.y);
    right = Math.max(right, point.x);
    bottom = Math.max(bottom, point.y);
  }
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/**
 * The ids of the buildings in `others` that stand between the camera and `target`: nearer to the
 * camera, and drawn over it by more than a few pixels. Overlap is tested on the buildings'
 * outlines, not their bounding boxes, so a neighbour that only shares a corner of the box stays.
 */
export function occluders(target: Projected, others: readonly Projected[]): string[] {
  const hull = hullOf(target.corners);
  const bounds = boundsOf(target.corners);
  const ids: string[] = [];
  for (const other of others) {
    if (other.id === target.id || other.depth >= target.depth) continue;
    if (!overlaps(bounds, boundsOf(other.corners), -OVERLAP_SLOP)) continue;
    if (overlap(hull, hullOf(other.corners), OVERLAP_SLOP)) ids.push(other.id);
  }
  return ids;
}
