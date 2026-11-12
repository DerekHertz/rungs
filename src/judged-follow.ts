import type { JudgedDocument } from "./jev/judged-types.ts";
import { claimMarks, judgedSummary } from "./judged-marks.ts";
import type { JudgedMark } from "./judged-marks.ts";
import { CLAIM_GATE_ID } from "./jev/claim-gate.ts";
import { rateText } from "./jev/rate.ts";
import type { GateRate } from "./jev/rate.ts";

/**
 * What the Claims row needs to draw judged marks. `marks` is null when there is no judged
 * document, and the row is then today's row. `rate` is the gate's measured rate of wrong passes
 * on its labelled cases, from the committed results; until it answers for a gate the detail says
 * the rate is not measured yet. `adopted` says whether the gate met its bar: a gate that did not,
 * or has no result, stays off, and its settled marks are drawn as not trusted.
 */
export interface JudgedView {
  readonly marks: ReadonlyMap<number, JudgedMark>;
  /** The gate's measured rate of wrong passes, as one line of text, or undefined while none is measured. */
  readonly rate?: (gate: string) => string | undefined;
  /** True only when the gate's committed result meets its bar; false or undefined (not measured) otherwise. */
  readonly adopted?: (gate: string) => boolean | undefined;
}

/** What a page that follows judging is given: the view and summary to show now. */
export interface JudgedUpdate {
  readonly judged: JudgedView | null;
  readonly judgedSummary: string;
}

/** How long the page waits between reads of a pending /judged.json: from a second, easing out to five. */
export const POLL_FIRST_MS = 1000;
export const POLL_LAST_MS = 5000;
const POLL_GIVE_UP = 5;

export type Claim = { readonly index: number; readonly ids: readonly string[] };

/** The view and summary for one document, with the gates' committed rates: a settled mark of a gate that is not adopted says so, however it arrived. */
export const updateOf = (document: JudgedDocument | null, claims: readonly Claim[], linked: boolean, rates: ReadonlyMap<string, GateRate>): JudgedUpdate => {
  const marks = claimMarks(document, claims, linked);
  const summary = judgedSummary(document, marks);
  if (marks === null) return { judged: null, judgedSummary: summary };
  const adopted = (gate: string): boolean => rates.get(gate)?.adopted === true;
  const settled = [...marks.values()].some((mark) => mark.kind === "judged" && mark.verdict === "settled");
  return {
    judged: { marks, rate: (gate) => { const rate = rates.get(gate); return rate === undefined ? undefined : rateText(rate); }, adopted },
    judgedSummary: settled && !adopted(CLAIM_GATE_ID) ? `${summary} (claim gate not adopted)` : summary,
  };
};

/**
 * The polling loop, with its reader and clock handed in. `last` starts as the first (pending)
 * document, so giving up after five failed reads always has the pending list: what was answered
 * stays, and every check still pending becomes "not judged" with why. No mark is left "judging…".
 */
export async function followJudging(first: JudgedDocument, read: () => Promise<JudgedDocument | null>, sleep: (ms: number) => Promise<void>, update: (document: JudgedDocument | null) => JudgedUpdate, show: (update: JudgedUpdate) => void): Promise<void> {
  let wait = POLL_FIRST_MS;
  let failures = 0;
  let last: JudgedDocument = first;
  for (;;) {
    await sleep(wait);
    wait = Math.min(POLL_LAST_MS, Math.round(wait * 1.5));
    const document = await read();
    if (document === null) {
      failures += 1;
      if (failures < POLL_GIVE_UP) continue;
      const reason = "the page could not read the server's judging progress";
      const kept = last.status === "pending" ? last : null;
      show(update(kept === null ? last : { ...kept, status: "on", runFailed: reason, notJudged: [...kept.notJudged, ...kept.pending.map((item) => ({ ...item, reason }))] }));
      return;
    }
    failures = 0;
    last = document;
    show(update(document));
    if (document.status !== "pending") return;
  }
}
