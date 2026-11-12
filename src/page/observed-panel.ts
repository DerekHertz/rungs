import type { NodeId } from "../graph.ts";
import { UNSANDBOXED_LINE, UNSANDBOXED_SHARED_LINE, VERDICT_WORD, runningText } from "../observed-types.ts";
import type { ControlDocument, Counts, ObservedDocument, UnmatchedTest } from "../observed-types.ts";
import { failingHeading } from "../arrival.ts";
import { fileMark, rowOutcome, unreliableText } from "../observed-report.ts";
import { controlText, leftoverSentence } from "../observed-text.ts";
import { leftoverWarns } from "../leftover.ts";
import type { FailingTest, FileResults, ObservedReport, WrittenReport } from "../observed-report.ts";
import { element, markPick, markSpan } from "./review-panel.ts";
import { OUTCOME_GLYPH, OUTCOME_WORD } from "../mark-text.ts";
import type { Outcome } from "../mark-text.ts";

export interface ObservedInput {
  readonly document: ObservedDocument;
  /** Present when the tests ran under a comparison. */
  readonly report: ObservedReport | null;
}

const countsText = (counts: Counts, environment = 0, fixed = 0, notCompared = 0): string =>
  counts.pass + counts.fail + counts.skip + environment + fixed + notCompared === 0
    ? "no results"
    : [
        counts.fail > 0 ? `${counts.fail} fail` : "",
        `${counts.pass} pass`,
        counts.skip > 0 ? `${counts.skip} skip` : "",
        environment > 0 ? `${environment} environment` : "",
        fixed > 0 ? `${fixed} fixed` : "",
        notCompared > 0 ? `${notCompared} not compared` : "",
      ]
        .filter((part) => part !== "")
        .join(" · ");

/** The Tests row's body: what failed, then the test files the PR touched. User text goes in as text. */
export function observedBody(observed: ObservedInput, pickNode: (id: NodeId) => void): HTMLElement[] {
  const { document, report } = observed;
  const out: HTMLElement[] = [];
  if (document.status === "running") return [element("p", "review-empty", runningText(document.stage))];
  if (document.status !== "ran" && document.status !== "failed" && document.status !== "unreliable") {
    out.push(element("p", "review-warning", `Tests not run: ${document.why}.`));
    return out;
  }
  if (document.sandbox === "unsandboxed") out.push(element("p", "review-warning", `Tests ${UNSANDBOXED_LINE}. ${UNSANDBOXED_SHARED_LINE}.`));
  // A process that may still be running, or leftovers nobody looked for, is a warning; one that was killed is only said.
  if (document.leftover !== undefined) out.push(element("p", leftoverWarns(document.leftover) ? "review-warning" : "review-empty", leftoverSentence(document.leftover)));
  if (document.status === "unreliable") {
    out.push(element("p", "review-warning", unreliableText(document)));
    return out;
  }
  if (document.status !== "ran") {
    out.push(element("p", "review-warning", `The node --test run failed after ${document.seconds}s: ${document.why}.`), element("pre", "observed-output", document.output));
    return out;
  }
  if (report === null) return out;

  if (document.control.status !== "ran") out.push(element("p", "review-warning", controlText(document.control)));
  out.push(element("h3", "review-subtitle", failingHeading(report.failing.length, document.control.status === "ran")));
  out.push(list(report.failing.map((test) => failingRow(test, pickNode))));
  if (document.control.status === "ran") out.push(...otherResults(report, document.control, pickNode));

  out.push(element("h3", "review-subtitle", `Test files this PR changed, with main's results (${report.files.length})`));
  if (report.files.length === 0) out.push(element("p", "review-empty", "No changed file is a test file or had a result."));
  out.push(list(report.files.map((file) => fileRow(file, report, pickNode))));

  if (document.unmatched.length > 0) {
    const more = element("details", "observed-unmatched");
    more.append(element("summary", "review-subtitle", `Not attached to a test function (${document.unmatched.length})`));
    more.append(list(document.unmatched.map(unmatchedRow)));
    out.push(more);
  }
  if (report.written !== null) out.push(writtenBlock(report.written));
  return out;
}

/** The full list's rest, apart from the regressions: environment failures dimmed with their reason, fixed tests, and tests only one run reported or that were skipped. */
function otherResults(report: ObservedReport, control: Extract<ControlDocument, { status: "ran" }>, pickNode: (id: NodeId) => void): HTMLElement[] {
  const total = report.others.length + control.baseOnly.length;
  if (total === 0) return [];
  const more = element("details", "observed-unmatched");
  more.append(element("summary", "review-subtitle", `Not this PR's doing, or not compared (${total}): environment, fixed, skipped, one-sided`));
  more.append(
    list([
      ...report.others.map((test) => failingRow(test, pickNode, true)),
      ...control.baseOnly.map((test) => {
        const item = element("li", "review-row observed-loose observed-dim");
        const text = element("span", "contract-text");
        text.append(element("span", "review-label", test.name || "(the whole file)"), element("span", "contract-where", `${test.file} · ${VERDICT_WORD["base only"]}`));
        item.append(outcomeMark(test.outcome), text);
        return item;
      }),
    ]),
  );
  return [more];
}

/** What the tests this PR wrote or edited did. Claimed, never evidence: their author is the PR. */
function writtenBlock(written: WrittenReport): HTMLElement {
  const wrap = element("div", "observed-written");
  const head = element("h3", "review-subtitle", `Written by this PR (${written.files.length} ${written.files.length === 1 ? "file" : "files"})`);
  head.append(element("span", "review-tag claimed", "claimed"));
  wrap.append(head, element("p", "review-empty", "Not evidence: the PR wrote these tests, so it decides whether they pass."));
  if (written.status !== "ran") {
    wrap.append(element("p", "review-warning", `These tests did not give results (${written.status}): ${written.why}.`));
    return wrap;
  }
  wrap.append(
    list(
      written.files.map((file) => {
        const item = element("li", "review-row observed-loose");
        item.append(element("span", "review-label", file.path), element("span", "review-size", countsText(file.counts)));
        return item;
      }),
    ),
  );
  if (written.failing.length > 0) {
    wrap.append(
      list(
        written.failing.map((test) => {
          const item = element("li", "review-row observed-loose");
          const text = element("span", "contract-text");
          text.append(element("span", "review-label", test.name), element("span", "contract-where", test.file));
          item.append(outcomeMark("fail"), text);
          return item;
        }),
      ),
    );
  }
  return wrap;
}

/** A test's mark: the glyph for the eye, the word for a screen reader. */
export function outcomeMark(outcome: Outcome): HTMLElement {
  return markSpan(`review-mark observed-${outcome}`, OUTCOME_GLYPH[outcome], OUTCOME_WORD[outcome]);
}

function list(items: readonly HTMLElement[]): HTMLElement {
  const made = element("ul", "review-list");
  made.append(...items);
  return made;
}

function pickButton(onClick: () => void): HTMLButtonElement {
  const pick = element("button", "review-pick");
  pick.type = "button";
  pick.addEventListener("click", () => {
    markPick(pick);
    onClick();
  });
  return pick;
}

function fileRow(file: FileResults, report: ObservedReport, pickNode: (id: NodeId) => void): HTMLElement {
  const item = element("li", "review-row");
  const pick = pickButton(() => pickNode(file.id));
  pick.title = file.path;
  pick.classList.add("observed-file");
  const mark = outcomeMark(fileMark(file));
  // An environment failure alone is not this PR's doing: its cross is dimmed.
  if (file.counts.fail === 0 && (file.environment ?? 0) > 0) mark.classList.add("observed-dim");
  pick.append(
    mark,
    element("span", "review-label", file.path),
    ...(report.deleted.includes(file.path) ? [element("span", "review-flag", "deleted by this PR")] : report.edited.includes(file.path) ? [element("span", "review-flag", "edited by this PR")] : []),
    element("span", "review-size", countsText(file.counts, file.environment, file.fixed, file.notCompared)),
  );
  item.append(pick);
  return item;
}

function failingRow(test: FailingTest, pickNode: (id: NodeId) => void, dim = false): HTMLElement {
  const item = element("li", dim ? "review-row observed-dim" : "review-row");
  const detail = element("div", "rv-detail contract-text");
  detail.hidden = true;
  if (test.verdict !== undefined) detail.append(element("span", "contract-where", VERDICT_WORD[test.verdict]));
  if (test.why !== undefined) detail.append(element("span", "contract-where", test.why));
  if (test.message !== undefined) detail.append(element("span", "observed-message", test.message.split("\n")[0] ?? ""));
  const pick = pickButton(() => {
    for (const other of item.parentElement?.querySelectorAll<HTMLElement>(".rv-detail") ?? []) other.hidden = true;
    detail.hidden = false;
    pickNode(test.id);
  });
  // The whole name wraps in the row, so reading it needs neither hover nor touch; the title repeats it with the message.
  pick.title = test.message === undefined ? `${test.name} (${test.file})` : `${test.name} (${test.file}): ${test.message}`;
  const text = element("span", "contract-text");
  text.append(element("span", "review-label", test.name), element("span", "contract-where", test.file));
  // A row of the other results says what it is and why, without a click.
  if (dim && test.verdict !== undefined) text.append(element("span", "contract-where", VERDICT_WORD[test.verdict]));
  if (dim && test.message !== undefined) text.append(element("span", "observed-message", test.message.split("\n")[0] ?? ""));
  pick.append(outcomeMark(rowOutcome(test)), text);
  item.append(pick);
  if (detail.childElementCount > 0) item.append(detail);
  return item;
}

function unmatchedRow(test: UnmatchedTest): HTMLElement {
  const item = element("li", "review-row observed-loose");
  const text = element("span", "contract-text");
  text.append(element("span", "review-label", test.name || "(the whole file)"), element("span", "contract-where", `${test.file} · ${test.why}`));
  item.append(outcomeMark(test.outcome), text);
  return item;
}
