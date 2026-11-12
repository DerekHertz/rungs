import { CLAIM_GATE_ID, QUESTION_LABELS as CLAIM_LABELS, describeThresholds as describeClaim } from "./claim-gate.ts";
import type { JevAnswer } from "./client.ts";
import type { Thresholds, Verdict } from "./gate.ts";
import { STANDARD_GATE_ID, STANDARD_QUESTION_LABELS, describeStandardThresholds, explainStandardVerdict } from "./standard-gate.ts";

/** The words the page puts on each gate's marks. No node imports: the page reads this. */

const LABELS: ReadonlyMap<string, Readonly<Record<string, string>>> = new Map([
  [CLAIM_GATE_ID, CLAIM_LABELS],
  [STANDARD_GATE_ID, STANDARD_QUESTION_LABELS],
]);

/** One short line for a question of a gate; the question's own name for a gate or question this page does not know. */
export function questionLabel(gate: string, question: string): string {
  return LABELS.get(gate)?.[question] ?? question;
}

/** The rule that turned a record's probabilities into its verdict, in words, from the thresholds the record carries. */
export function describeGateThresholds(gate: string, thresholds: Thresholds): string {
  if (gate === CLAIM_GATE_ID) return describeClaim(thresholds);
  if (gate === STANDARD_GATE_ID) return describeStandardThresholds(thresholds);
  return `Thresholds: ${Object.entries(thresholds).map(([name, value]) => `${name} ${Math.round(value * 100)}%`).join(", ")}.`;
}

/** Why a record has its verdict, for the gates that say; "" for the others. */
export function explainVerdict(gate: string, answers: Readonly<Record<string, JevAnswer>>, thresholds: Thresholds, verdict: Verdict): string {
  return gate === STANDARD_GATE_ID ? explainStandardVerdict(answers, thresholds, verdict) : "";
}
