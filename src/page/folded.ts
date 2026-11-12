import { CLAIM_GATE_ID } from "../jev/claim-gate.ts";
import { folds } from "../judged-fold.ts";
import type { JudgedView } from "../judged-follow.ts";

/** Settled items, folded: one summary line with the count, and each item one line below it, one click away. Nothing is left out. No items, nothing to draw. */
export function foldedList(rows: readonly HTMLElement[]): HTMLElement[] {
  if (rows.length === 0) return [];
  const folded = document.createElement("details");
  folded.className = "review-context";
  const summary = document.createElement("summary");
  summary.className = "review-summary";
  summary.textContent = `Settled (${rows.length})`;
  const list = document.createElement("ul");
  list.className = "review-list";
  list.append(...rows);
  folded.append(summary, list);
  return [folded];
}

/** The claims that are folded now, as a key: when it changes, the Claims row is drawn again. */
export const foldedClaims = (claims: readonly { readonly index: number }[], view: JudgedView | null): string =>
  claims.filter((claim) => folds(view?.marks.get(claim.index), view?.adopted?.(CLAIM_GATE_ID) === true)).map((claim) => claim.index).join(",");
