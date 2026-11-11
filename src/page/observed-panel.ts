import type { NodeId } from "../graph.ts";
import { EVIDENCE_LINE, UNSANDBOXED_LINE } from "../observed-types.ts";
import type { Counts, ObservedDocument, UnmatchedTest } from "../observed-types.ts";
import { unreliableText } from "../observed-report.ts";
import type { FailingTest, FileResults, ObservedReport, WrittenReport } from "../observed-report.ts";
import { element } from "./review-panel.ts";

export interface ObservedInput {
  readonly document: ObservedDocument;
  /** Present when the tests ran under a comparison. */
  readonly report: ObservedReport | null;
}

const countsText = (counts: Counts): string =>
  counts.pass + counts.fail + counts.skip === 0
    ? "no results"
    : [counts.fail > 0 ? `${counts.fail} fail` : "", `${counts.pass} pass`, counts.skip > 0 ? `${counts.skip} skip` : ""].filter((part) => part !== "").join(" · ");

/** The caveat that sits one hover or click from the Tests row. */
export function observedNote(document: ObservedDocument): string {
  const sandboxed = (document.status === "ran" || document.status === "failed" || document.status === "unreliable") && document.sandbox === "unsandboxed";
  return `${EVIDENCE_LINE}${sandboxed ? ` Tests ${UNSANDBOXED_LINE}.` : ""}`;
}

/** What the run was, for "About this run": the runner, the sandbox, the time, the counts. */
export function observedAbout(observed: ObservedInput): [string, string][] {
  const { document } = observed;
  const notes: [string, string][] = [];
  if (document.status === "ran") {
    const { pass, fail, skip } = document.counts;
    const where = document.sandbox === "bwrap" ? "in a sandbox with no network" : "unsandboxed";
    notes.push(["Tests", `${pass + fail + skip} of main's tests ran once against this PR's code with node --test ${where}, in ${document.seconds}s: ${fail} fail, ${pass} pass, ${skip} skip. ${observedNote(document)}`]);
  } else if (document.status === "failed") notes.push(["Tests", `The node --test run failed after ${document.seconds}s: ${document.why}. ${observedNote(document)}`]);
  else if (document.status === "unreliable") notes.push(["Tests", `${unreliableText(document)} ${observedNote(document)}`]);
  else notes.push(["Tests", `Tests not run: ${document.why}.`]);
  return notes;
}

/** The Tests row's body: what failed, then the test files the PR touched. User text goes in as text. */
export function observedBody(observed: ObservedInput, pickNode: (id: NodeId) => void): HTMLElement[] {
  const { document, report } = observed;
  const out: HTMLElement[] = [];
  if (document.status !== "ran" && document.status !== "failed" && document.status !== "unreliable") {
    out.push(element("p", "review-warning", `Tests not run: ${document.why}.`));
    return out;
  }
  if (document.sandbox === "unsandboxed") out.push(element("p", "review-warning", `Tests ${UNSANDBOXED_LINE}.`));
  if (document.status === "unreliable") {
    out.push(element("p", "review-warning", unreliableText(document)));
    return out;
  }
  if (document.status !== "ran") {
    out.push(element("p", "review-warning", `The node --test run failed after ${document.seconds}s: ${document.why}.`), element("pre", "observed-output", document.output));
    return out;
  }
  if (report === null) return out;

  out.push(element("h3", "review-subtitle", `Failing (${report.failing.length})`));
  if (report.failing.length === 0) out.push(element("p", "review-empty", "No test failed."));
  out.push(list(report.failing.map((test) => failingRow(test, pickNode))));

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
          item.append(element("span", "review-mark observed-fail", "✗"), text);
          return item;
        }),
      ),
    );
  }
  return wrap;
}

function list(items: readonly HTMLElement[]): HTMLElement {
  const made = element("ul", "review-list");
  made.append(...items);
  return made;
}

function pickButton(onClick: () => void): HTMLButtonElement {
  const pick = element("button", "review-pick");
  pick.type = "button";
  pick.addEventListener("click", onClick);
  return pick;
}

function fileRow(file: FileResults, report: ObservedReport, pickNode: (id: NodeId) => void): HTMLElement {
  const item = element("li", "review-row");
  const pick = pickButton(() => pickNode(file.id));
  pick.title = file.path;
  const state = file.counts.fail > 0 ? "fail" : file.counts.pass + file.counts.skip === 0 ? "none" : "pass";
  pick.append(
    element("span", `review-mark observed-${state}`, state === "fail" ? "✗" : state === "pass" ? "✓" : "·"),
    element("span", "review-label rv-ellipsis", file.path),
    ...(report.deleted.includes(file.path) ? [element("span", "review-flag", "deleted by this PR")] : report.edited.includes(file.path) ? [element("span", "review-flag", "edited by this PR")] : []),
    element("span", "review-size", countsText(file.counts)),
  );
  item.append(pick);
  return item;
}

function failingRow(test: FailingTest, pickNode: (id: NodeId) => void): HTMLElement {
  const item = element("li", "review-row");
  const detail = element("div", "rv-detail contract-text");
  detail.hidden = true;
  detail.append(element("span", "contract-where", test.why === undefined ? test.file : `${test.file} · ${test.why}`));
  if (test.message !== undefined) detail.append(element("span", "observed-message", test.message.split("\n")[0] ?? ""));
  const pick = pickButton(() => {
    for (const other of item.parentElement?.querySelectorAll<HTMLElement>(".rv-detail") ?? []) other.hidden = true;
    detail.hidden = false;
    pickNode(test.id);
  });
  pick.title = test.message === undefined ? `${test.name} (${test.file})` : `${test.name} (${test.file}): ${test.message}`;
  pick.append(element("span", "review-mark observed-fail", "✗"), element("span", "review-label rv-ellipsis", test.name));
  item.append(pick, detail);
  return item;
}

function unmatchedRow(test: UnmatchedTest): HTMLElement {
  const item = element("li", "review-row observed-loose");
  const text = element("span", "contract-text");
  text.append(element("span", "review-label", test.name || "(the whole file)"), element("span", "contract-where", `${test.file} · ${test.why}`));
  item.append(element("span", `review-mark observed-${test.outcome}`, test.outcome === "fail" ? "✗" : test.outcome === "pass" ? "✓" : "·"), text);
  return item;
}
