import type { Verdict } from "./jev/gate.ts";
import type { JudgedDocument, JudgedRecord } from "./jev/judged-types.ts";
import { CLAIM_GATE_ID } from "./jev/claim-gate.ts";

/**
 * What the Claims row shows beside each claim, from /judged.json alone: the claim's judged
 * verdict, or "not judged" with why. Kept apart from the claimed text and the derived facts; a
 * mark never changes either.
 */
export type JudgedMark =
  | { readonly kind: "judged"; readonly verdict: Verdict; readonly record: JudgedRecord }
  | { readonly kind: "not judged"; readonly reason: string };

/** The word a mark reads as. */
export const markWord = (mark: JudgedMark): string => (mark.kind === "judged" ? mark.verdict : "not judged");

/**
 * One mark per claim, or null when there is no judged document to read (the page is then today's
 * page). With judging off every claim reads "not judged" with the document's reason; on, a claim
 * has its record, or the reason its check has no answer, or why it was never asked.
 */
export function claimMarks(document: JudgedDocument | null, claims: readonly { readonly index: number; readonly ids: readonly string[] }[], linked: boolean): Map<number, JudgedMark> | null {
  if (document === null) return null;
  const marks = new Map<number, JudgedMark>();
  const records = new Map<number, JudgedRecord>();
  for (const set of document.sets) {
    if (set.question.id !== CLAIM_GATE_ID) continue;
    for (const record of set.records) if ("claim" in record.about) records.set(record.about.claim, record);
  }
  const failed = new Map<number, string>();
  for (const entry of document.notJudged) if (entry.gate === CLAIM_GATE_ID && "claim" in entry.about) failed.set(entry.about.claim, entry.reason);
  for (const claim of claims) {
    const record = records.get(claim.index);
    if (document.status === "off") marks.set(claim.index, { kind: "not judged", reason: document.reason });
    else if (record !== undefined) marks.set(claim.index, { kind: "judged", verdict: record.verdict, record });
    else if (claim.ids.length === 0) marks.set(claim.index, { kind: "not judged", reason: linked ? "no changed place is linked to this claim, so there is nothing to judge it against" : "claims are not linked to places (run with --link), so there is nothing to judge them against" });
    else marks.set(claim.index, { kind: "not judged", reason: failed.get(claim.index) ?? "no answer was recorded for this claim" });
  }
  return marks;
}

export interface MarkCounts {
  readonly settled: number;
  readonly flagged: number;
  readonly undecided: number;
  readonly notJudged: number;
}

export function countMarks(marks: Iterable<JudgedMark>): MarkCounts {
  const counts = { settled: 0, flagged: 0, undecided: 0, notJudged: 0 };
  for (const mark of marks) {
    if (mark.kind === "not judged") counts.notJudged++;
    else counts[mark.verdict]++;
  }
  return counts;
}

/** "2 settled, 1 flagged, 1 not judged": the number first, zero counts left out. */
export function countsText(counts: MarkCounts): string {
  return [
    counts.settled === 0 ? "" : `${counts.settled} settled`,
    counts.flagged === 0 ? "" : `${counts.flagged} flagged`,
    counts.undecided === 0 ? "" : `${counts.undecided} undecided`,
    counts.notJudged === 0 ? "" : `${counts.notJudged} not judged`,
  ]
    .filter((part) => part !== "")
    .join(", ");
}

/** What the Claims row's summary adds to its own: empty with no document and with judging off, so that page reads as before. */
export function judgedSummary(document: JudgedDocument | null, marks: ReadonlyMap<number, JudgedMark> | null): string {
  if (document === null || document.status === "off" || marks === null || marks.size === 0) return "";
  return countsText(countMarks(marks.values()));
}

export const percent = (probability: number): string => `${Math.round(probability * 100)}%`;

/** A call's cost in dollars; "unknown" when the service did not report a valid count, never zero. */
export function costText(record: Pick<JudgedRecord, "inputTokens" | "usd">): string {
  if (record.usd === null || record.inputTokens === null) return "cost unknown";
  return `${record.inputTokens.toLocaleString("en-US")} input tokens, $${record.usd.toFixed(6)}`;
}
