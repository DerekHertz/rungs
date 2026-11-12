import { CLAIM_GATE_ID } from "./jev/claim-gate.ts";
import { STANDARD_GATE_ID } from "./jev/standard-gate.ts";
import { yesOf } from "./jev/gate.ts";
import type { JevAnswer } from "./jev/client.ts";
import type { Thresholds } from "./jev/gate.ts";
import type { JudgedRecord } from "./jev/judged-types.ts";
import type { JudgedMark } from "./judged-marks.ts";
import { tierPercent } from "./tier-table.ts";

/**
 * The kind of miss of an item no gate settled, decided by code from which check failed and how.
 * There is no extra Jev call: the answers a gate already recorded say it, so a record is classified
 * when it is read and nothing is stored that could go stale. No node imports: the page reads this.
 *
 * A kind is named only where Jev leans to it, at the gate's own flag line (50%): a probability in the
 * middle band, between a gate's settle limit and that line, is Jev being unsure, and code cannot make
 * a kind of it.
 *
 *   contradicted       a claim the gate flagged (contradicted at the flag line or above)
 *   ungrounded         a claim more likely not shown than shown (shown at or under 1 - the flag line),
 *                      when what Jev was shown was whole
 *   breaks a standard  a hunk the gate flagged, or one the base already broke that the changed lines
 *                      break at the flag line or above (not new, and says so)
 *   no miss found      every answer was read and passes the gate's own limits over a whole state;
 *                      only the tier is not cleared, so nothing is known to be wrong and a person looks
 *   unknown            the answers cannot say: not judged, still being asked, an answer that could
 *                      not be read or is missing, a probability in the middle band, evidence that was
 *                      cut, or a gate this page does not classify
 *
 * "Breaks something" (a change that breaks what rests on it, with no written rule behind it) is
 * not here: no gate asks that question yet, so code cannot know it. Unknown is never a kind.
 * A settled item has no miss, so no kind (null).
 */
export type MissKind = "contradicted" | "ungrounded" | "breaks a standard";

export type KindOfMiss = { readonly kind: MissKind | "no miss found" | "unknown"; readonly why: string };

const pct = (value: number): string => `${Math.round(value * 1000) / 10}%`;
const unknown = (why: string): KindOfMiss => ({ kind: "unknown", why });

/** The word on the page: the kind's name, "no miss found", or "kind unknown". */
export const kindText = (found: KindOfMiss): string => (found.kind === "unknown" ? "kind unknown" : found.kind);

/**
 * What the state a record was judged on left out, in words, or undefined when it was whole. "Not shown" and "nothing wrong
 * found" are claims about absence: over evidence that was cut, left out or not available they say nothing, so they are unknown.
 * A breach or a contradiction that was seen is seen however much else was cut. The markers are the ones the gates write into
 * their state (claim-gate.ts, standard-gate.ts); a test builds real states from the gates so a change there fails here.
 */
export function cutOf(state: Readonly<Record<string, string>>): string | undefined {
  const texts = Object.entries(state);
  if (texts.some(([key]) => key === "omitted")) return "some linked places were left out of what Jev was shown";
  const found = (pattern: RegExp): boolean => texts.some(([, text]) => pattern.test(text));
  if (found(/more changed lines were cut from this state|\[place cut to fit/)) return "some changed lines were cut from what Jev was shown";
  if (found(/changed lines: none shown \((?!(?:moved with )?no line changed\))/)) return "the changed lines of a place were not available to Jev";
  if (found(/\[cut: \d+ more characters of the rule|more lines were cut from this state|\[cut to fit the state budget/)) return "part of the rule or the lines was cut from what Jev was shown";
  return undefined;
}

/** The kind of one judged record, or null when its verdict is settled (no miss). */
export function kindOfRecord(record: JudgedRecord): KindOfMiss | null {
  if (record.verdict === "settled") return null;
  if (record.question.id === CLAIM_GATE_ID) return claimKind(record);
  if (record.question.id === STANDARD_GATE_ID) return standardKind(record);
  return unknown(`this page does not classify the ${record.question.id} check`);
}

/** The kind of one mark: its record's, "unknown" with the reason for a check with no answer, null for a settled one. */
export function kindOfMark(mark: JudgedMark): KindOfMiss | null {
  if (mark.kind === "judged") return kindOfRecord(mark.record);
  return unknown(mark.kind === "pending" ? "Jev is still checking this" : `not judged: ${mark.reason}`);
}

/** A probability that is missing, unreadable or not a number in 0..1 (a stored record can say anything) cannot place an item in a kind. */
const isChance = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value) && value >= 0 && value <= 1;
const unread = (answers: Readonly<Record<string, JevAnswer>>, ...names: string[]): string[] => names.filter((name) => !isChance(yesOf(answers, name)));

function claimKind(record: JudgedRecord): KindOfMiss {
  const { answers, thresholds } = record;
  const missing = unread(answers, "shown", "contradicted");
  if (missing.length > 0) return unknown(`the ${missing.join(" and ")} answer could not be read, so what kind of miss this is cannot be told`);
  const shown = yesOf(answers, "shown")!;
  const contradicted = yesOf(answers, "contradicted")!;
  const note = `shown ${pct(shown)}, contradicted ${pct(contradicted)}`;
  if (record.verdict === "flagged") return { kind: "contradicted", why: `the gate flagged it: ${note}` };
  const cut = cutOf(record.shown.state);
  // More likely not shown than shown: the gate has no flag for it, so it is the same line the gate flags a contradiction at.
  if (1 - shown >= (thresholds.flag ?? 0.5)) return cut === undefined ? { kind: "ungrounded", why: `it is more likely not shown than shown (${note})` } : unknown(`it is more likely not shown than shown (${note}), but ${cut}, so it cannot be told that it is ungrounded`);
  if (shown < (thresholds.shown ?? 0.9) || contradicted > (thresholds.contradicted ?? 0.1)) return unknown(`Jev is not sure either way (${note}): between the settle limit and the flag line, so no kind can be named`);
  return heldByTier(record.thresholds, note, cut);
}

function standardKind(record: JudgedRecord): KindOfMiss {
  const { answers, thresholds } = record;
  const breaks = yesOf(answers, "breaks");
  if (!isChance(breaks)) return unknown("the answer about the changed lines could not be read, so what kind of miss this is cannot be told");
  const given = yesOf(answers, "before");
  // A base answer that is not a probability is a missing one: never read as "the base did not already break it".
  const before = isChance(given) ? given : undefined;
  const already = before !== undefined && before >= (thresholds.already ?? 0.5);
  if (record.verdict === "flagged") return { kind: "breaks a standard", why: `the gate flagged it: the changed lines break the rule (${pct(breaks)}), ${before === undefined ? "and the base's answer is missing, so it is not hidden" : "a new violation"}` };
  if (breaks >= (thresholds.flag ?? 0.5)) return { kind: "breaks a standard", why: `the changed lines break the rule (${pct(breaks)}), but the base's lines already broke it, so it is not new` };
  if (breaks > (thresholds.clear ?? 0.1)) return unknown(`Jev is not sure the changed lines break the rule (${pct(breaks)}): between the settle limit and the flag line, so no kind can be named`);
  if (before === undefined) return unknown(`the changed lines look clean (${pct(breaks)}), but the base's answer is missing, so it cannot be settled`);
  if (already) return unknown(`the changed lines look clean (${pct(breaks)}), but the base's lines already broke the rule, so they may only have moved the breach`);
  return heldByTier(thresholds, `the changed lines break the rule at ${pct(breaks)}`, cutOf(record.shown.state));
}

/** Every answer passes the gate's own limits and the verdict is still not settled: only a tier can have held it, or the record is not one the gate would write. */
function heldByTier(thresholds: Thresholds, note: string, cut: string | undefined): KindOfMiss {
  if (cut !== undefined) return unknown(`${note}, but ${cut}, so it cannot be told that nothing is wrong`);
  if (thresholds.tier === undefined) return unknown(`${note}, and no check failed, yet nothing settled it`);
  return { kind: "no miss found", why: `${note}: no check failed its own limit; the tier of ${tierPercent(thresholds.tier)} asks for more, so a person looks` };
}
