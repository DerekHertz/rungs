/** The words a screen reader says for the marks the lists draw as one glyph. */

export type Outcome = "fail" | "pass" | "skip" | "none";

export const OUTCOME_GLYPH: Record<Outcome, string> = { fail: "✗", pass: "✓", skip: "·", none: "·" };
export const OUTCOME_WORD: Record<Outcome, string> = { fail: "failed", pass: "passed", skip: "skipped", none: "no result" };

export type ChangeWord = "added" | "altered" | "removed" | "moved";
export const CHANGE_WORD: Record<ChangeWord, string> = { added: "added", altered: "altered", removed: "removed", moved: "moved" };

export type ContractKind = "changed" | "effects" | "added" | "removed" | "exposed" | "unexported" | "moved";
export const CONTRACT_WORD: Record<ContractKind, string> = {
  changed: "signature changed",
  effects: "effects changed",
  added: "added",
  removed: "removed",
  exposed: "now exported",
  unexported: "no longer exported",
  moved: "moved",
};
