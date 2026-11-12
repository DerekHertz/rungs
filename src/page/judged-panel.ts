import { QUESTION_LABELS, describeThresholds } from "../jev/claim-gate.ts";
import { NOT_MEASURED, ratesOf } from "../jev/rate.ts";
import type { GateRate } from "../jev/rate.ts";
import type { JudgedDocument } from "../jev/judged-types.ts";
import { costText, markWord, percent } from "../judged-marks.ts";
import { followJudging, updateOf } from "../judged-follow.ts";
import type { Claim, JudgedUpdate, JudgedView } from "../judged-follow.ts";

export type { JudgedUpdate, JudgedView } from "../judged-follow.ts";
import type { JudgedMark } from "../judged-marks.ts";
import { element } from "./review-panel.ts";

/** The word on a settled mark of a gate that is not adopted: it says what the classifier answered, and that nothing stands behind it yet. */
export const UNADOPTED_WORD = "settled, gate not adopted";

const GLYPH: Record<string, string> = { settled: "✓", flagged: "⚑", undecided: "?", "not judged": "–", "judging…": "…" };

/**
 * The mark beside a claim. Drawn as a filled pill with a glyph and its word, apart from the
 * outlined tier tags (derived, observed, claimed): it says what a classifier answered.
 */
export function markButton(mark: JudgedMark, onClick: () => void, adopted: boolean = true): HTMLButtonElement {
  const word = markWord(mark);
  // A settled answer from a gate that has not met its bar must not read as trusted: it keeps the verdict and says so.
  const untrusted = mark.kind === "judged" && mark.verdict === "settled" && !adopted;
  const button = element("button", `review-judged ${mark.kind === "pending" ? "judging" : word.replace(" ", "-")}${untrusted ? " unadopted" : ""}`);
  button.type = "button";
  const glyph = element("span", "", untrusted ? "\u25cb" : GLYPH[word]);
  glyph.setAttribute("aria-hidden", "true");
  button.append(glyph, element("span", "", untrusted ? UNADOPTED_WORD : word));
  button.title = mark.kind === "judged" ? `judged ${word} by Jev${untrusted ? ", but the claim gate has not met its bar and stays off, so this is not evidence" : ""}; click to see what it was shown` : mark.kind === "pending" ? "Jev is still checking this claim" : mark.reason;
  button.setAttribute("aria-label", mark.kind === "judged" ? `Judged ${word}${untrusted ? " by a gate that is not adopted" : ""}: show the check` : mark.kind === "pending" ? "Judging: Jev is still checking this claim" : `Not judged: ${mark.reason}`);
  button.addEventListener("click", onClick);
  return button;
}

/** The click-through of a mark: the questions, what Jev was shown, both answers, the threshold, the model and the cost. Everything goes in as text. */
export function judgedDetail(mark: JudgedMark, view: JudgedView): HTMLDetailsElement {
  const detail = element("details", "judged-detail");
  detail.append(element("summary", "review-summary", `Jev's check: ${markWord(mark)}`));
  const body = element("div", "judged-body");
  if (mark.kind !== "judged") {
    body.append(element("p", "judged-line", mark.kind === "pending" ? "Jev is still checking this claim; the mark fills in when it answers." : `Not judged: ${mark.reason}`));
    detail.append(body);
    return detail;
  }
  const { record } = mark;
  for (const name of Object.keys(record.shown.questions)) {
    const answer = record.answers[name];
    const line = element("p", "judged-line");
    const label = QUESTION_LABELS[name] ?? name;
    if (answer?.type === "yes-no") line.append(element("strong", "", `${label} ${percent(answer.yes)} yes`), element("span", "judged-exact", ` (${answer.yes})`));
    else if (answer?.type === "unreadable") line.append(element("strong", "", `${label} unreadable`), element("span", "judged-exact", ` ${answer.why}; Jev returned ${answer.raw}`));
    else line.append(element("strong", "", `${label} no answer`));
    body.append(line);
  }
  body.append(element("p", "judged-line", describeThresholds(record.thresholds)));
  const unreadable = Object.values(record.answers).some((answer) => answer.type === "unreadable");
  body.append(element("p", "judged-line", `Verdict: ${record.verdict}${unreadable ? ", because an answer could not be read (an answer that cannot be read never settles a claim)" : ""}.`));
  body.append(element("p", "judged-line", `Model ${record.model} · question ${record.question.id} ${record.question.version} · ${costText(record)}`));
  body.append(element("p", "judged-line", view.rate?.(record.question.id) ?? NOT_MEASURED));
  const shown = element("details", "judged-shown");
  shown.append(element("summary", "review-summary", "What Jev was shown"));
  for (const [name, question] of Object.entries(record.shown.questions)) {
    shown.append(element("h4", "judged-key", `question: ${name}`), element("pre", "judged-text", `${question.instructions}\n${Object.entries(question.criteria).map(([answer, text]) => `${answer}: ${text}`).join("\n")}`));
  }
  for (const [key, text] of Object.entries(record.shown.state)) {
    shown.append(element("h4", "judged-key", key), element("pre", "judged-text", text));
  }
  body.append(shown);
  detail.append(body);
  return detail;
}

async function readJudged(): Promise<JudgedDocument | null> {
  try {
    const response = await fetch("/judged.json");
    return response.ok ? ((await response.json()) as JudgedDocument) : null;
  } catch {
    return null;
  }
}

/**
 * Reads /judged.json and gives the review panel its judged input: the marks, and the summary's
 * counts. A page that cannot read the document (an older server) is today's page. While the
 * server is still judging, the claims being asked read "judging…"; this polls (1s, easing out to
 * 5s, stopping at the finished document) and hands each new state to `show`. Polling, not
 * server-sent events: the existing server answers plain GETs from one document, and one document
 * that is pending and then final needs no second channel, no open connection to close and no
 * reconnect rule. If it cannot be read five times in a row, the marks still asked become "not judged".
 */
export async function judgedInput(claims: readonly Claim[], linked: boolean, show: (update: JudgedUpdate) => void): Promise<JudgedUpdate> {
  const first = await readJudged();
  const rates = await gateRates();
  const update = (document: JudgedDocument | null): JudgedUpdate => updateOf(document, claims, linked, rates);
  if (first?.status === "pending") void followJudging(first, readJudged, (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)), update, show);
  return update(first);
}

/** Reads /gate-rates.json: the newest committed result of each gate. A page that cannot read it has no rates, and its gates read as not adopted. */
async function gateRates(): Promise<ReadonlyMap<string, GateRate>> {
  try {
    const response = await fetch("/gate-rates.json");
    return response.ok ? ratesOf(await response.json()) : new Map();
  } catch {
    return new Map();
  }
}
