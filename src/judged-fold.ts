import type { JudgedMark } from "./judged-marks.ts";
import { tierText } from "./tier-table.ts";

/**
 * Which items of a judged row fold to one line, and the tier words on a mark. No node imports: the
 * page reads this.
 *
 * An item folds when its judged check settled it, and the gate is one that has met its bar (a settle
 * from a gate that has not is not evidence, so it stays open). A folded item is still in its row's
 * count and still one click away: nothing is hidden, and nothing judged removes or reorders what code
 * derived. Every other item (flagged, undecided, not judged, judging) stays open, in its own order.
 */
export const folds = (mark: JudgedMark | undefined, adopted: boolean): boolean => mark?.kind === "judged" && mark.verdict === "settled" && adopted;

/** The items split into those that stay open and those that fold, each keeping the order it came in. Together they are all of the items. */
export function splitSettled<T>(items: readonly T[], folded: (item: T) => boolean): { readonly open: T[]; readonly folded: T[] } {
  const open: T[] = [];
  const shut: T[] = [];
  for (const item of items) (folded(item) ? shut : open).push(item);
  return { open, folded: shut };
}

/** "99.9%": the tier a judged mark was picked, or "" for a mark with none (a record from before tiers, or a check not yet answered). */
export const markTier = (mark: JudgedMark): string => (mark.kind === "judged" && mark.record.pick !== undefined ? `${mark.record.pick.percent}%` : "");

/** "tier 99.9%: effects reached: 2 kinds of call out", or "" when the mark has no tier. */
export const markTierWhy = (mark: JudgedMark): string => (mark.kind === "judged" && mark.record.pick !== undefined ? tierText(mark.record.pick) : "");
