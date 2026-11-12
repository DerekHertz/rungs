import { QUESTION_LABELS, describeThresholds } from "../jev/claim-gate.ts";
import type { JudgedDocument } from "../jev/judged-types.ts";
import { claimMarks, costText, judgedSummary, markWord, percent } from "../judged-marks.ts";
import type { JudgedMark } from "../judged-marks.ts";
import { element } from "./review-panel.ts";

/**
 * What the Claims row needs to draw judged marks. `marks` is null when there is no judged
 * document, and the row is then today's row. `rate` is the hook for the rate of wrong passes
 * shown beside a gate's answer (the labelled cases and their measured rate); until it answers
 * for a gate the detail says the rate is not measured yet.
 */
export interface JudgedView {
  readonly marks: ReadonlyMap<number, JudgedMark>;
  /** The gate's measured rate of wrong passes, as one line of text, or undefined while none is measured. */
  readonly rate?: (gate: string) => string | undefined;
}

const GLYPH: Record<string, string> = { settled: "✓", flagged: "⚑", undecided: "?", "not judged": "–" };

/**
 * The mark beside a claim. Drawn as a filled pill with a glyph and its word, apart from the
 * outlined tier tags (derived, observed, claimed): it says what a classifier answered.
 */
export function markButton(mark: JudgedMark, onClick: () => void): HTMLButtonElement {
  const word = markWord(mark);
  const button = element("button", `review-judged ${word.replace(" ", "-")}`);
  button.type = "button";
  const glyph = element("span", "", GLYPH[word]);
  glyph.setAttribute("aria-hidden", "true");
  button.append(glyph, element("span", "", word));
  button.title = mark.kind === "judged" ? `judged ${word} by Jev; click to see what it was shown` : mark.reason;
  button.setAttribute("aria-label", mark.kind === "judged" ? `Judged ${word}: show the check` : `Not judged: ${mark.reason}`);
  button.addEventListener("click", onClick);
  return button;
}

/** The click-through of a mark: the questions, what Jev was shown, both answers, the threshold, the model and the cost. Everything goes in as text. */
export function judgedDetail(mark: JudgedMark, view: JudgedView): HTMLDetailsElement {
  const detail = element("details", "judged-detail");
  detail.append(element("summary", "review-summary", `Jev's check: ${markWord(mark)}`));
  const body = element("div", "judged-body");
  if (mark.kind === "not judged") {
    body.append(element("p", "judged-line", `Not judged: ${mark.reason}`));
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
  body.append(element("p", "judged-line", view.rate?.(record.question.id) ?? "Rate of wrong passes: not measured yet."));
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

/**
 * Reads /judged.json and gives the review panel its judged input: the marks, and the summary's
 * counts. A page that cannot read the document (an older server) is today's page.
 */
export async function judgedInput(claims: readonly { readonly index: number; readonly ids: readonly string[] }[], linked: boolean): Promise<{ judged: JudgedView | null; judgedSummary: string }> {
  let document: JudgedDocument | null = null;
  try {
    const response = await fetch("/judged.json");
    if (response.ok) document = (await response.json()) as JudgedDocument;
  } catch {
    document = null;
  }
  const marks = claimMarks(document, claims, linked);
  return { judged: marks === null ? null : { marks }, judgedSummary: judgedSummary(document, marks) };
}
