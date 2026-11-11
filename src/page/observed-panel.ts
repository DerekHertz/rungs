import type { NodeId } from "../graph.ts";
import { EVIDENCE_LINE, UNSANDBOXED_LINE } from "../observed-types.ts";
import type { Counts, ObservedDocument, UnmatchedTest } from "../observed-types.ts";
import { unreliableText } from "../observed-report.ts";
import type { FailingTest, FileResults, ObservedReport, WrittenReport } from "../observed-report.ts";
import { element, section } from "./review-panel.ts";

export interface ObservedInput {
  readonly document: ObservedDocument;
  /** Present when the tests ran under a comparison. */
  readonly report: ObservedReport | null;
}

const countsText = (counts: Counts): string =>
  counts.pass + counts.fail + counts.skip === 0
    ? "no results"
    : [counts.fail > 0 ? `${counts.fail} fail` : "", `${counts.pass} pass`, counts.skip > 0 ? `${counts.skip} skip` : ""].filter((part) => part !== "").join(" · ");

/** The Observed section: main's tests run against the head's code, or why there was no run. User text goes in as text. */
export function observedSection(observed: ObservedInput, pickNode: (id: NodeId) => void): HTMLElement {
  const [wrap, body] = section("Observed", "observed");
  const { document, report } = observed;
  if (document.status !== "ran" && document.status !== "failed" && document.status !== "unreliable") {
    body.append(element("p", "review-warning", `Tests not run: ${document.why}.`));
    return wrap;
  }
  body.append(element("p", "review-summary observed-trust", EVIDENCE_LINE));
  if (document.sandbox === "unsandboxed") body.append(element("p", "review-warning", `Tests ${UNSANDBOXED_LINE}.`));
  if (document.status === "unreliable") {
    body.append(element("p", "review-warning", unreliableText(document)));
    return wrap;
  }
  if (document.status !== "ran") {
    body.append(element("p", "review-warning", `The node --test run failed after ${document.seconds}s: ${document.why}.`));
    body.append(element("pre", "observed-output", document.output));
    return wrap;
  }
  const { pass, fail, skip } = document.counts;
  const where = document.sandbox === "bwrap" ? "in a sandbox with no network" : "unsandboxed";
  body.append(
    element("p", "review-summary", `${pass + fail + skip} of main's tests ran once against this PR's code with node --test ${where}, in ${document.seconds}s: ${fail} fail, ${pass} pass, ${skip} skip.`),
  );
  if (report === null) return wrap;

  body.append(element("h3", "review-subtitle", `Test files this PR changed, with main's results (${report.files.length})`));
  if (report.files.length === 0) body.append(element("p", "review-empty", "No changed file is a test file or had a result."));
  body.append(list(report.files.map((file) => fileRow(file, report, pickNode))));

  body.append(element("h3", "review-subtitle", `Failing (${report.failing.length})`));
  if (report.failing.length === 0) body.append(element("p", "review-empty", "No test failed."));
  body.append(list(report.failing.map((test) => failingRow(test, pickNode))));

  if (document.unmatched.length > 0) {
    const more = element("details", "observed-unmatched");
    more.append(element("summary", "review-subtitle", `Not attached to a test function (${document.unmatched.length})`));
    more.append(list(document.unmatched.map(unmatchedRow)));
    body.append(more);
  }
  if (report.written !== null) body.append(writtenBlock(report.written));
  return wrap;
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
  const state = file.counts.fail > 0 ? "fail" : file.counts.pass + file.counts.skip === 0 ? "none" : "pass";
  pick.append(
    element("span", `review-mark observed-${state}`, state === "fail" ? "✗" : state === "pass" ? "✓" : "·"),
    element("span", "review-label", file.path),
    ...(report.deleted.includes(file.path) ? [element("span", "review-flag", "deleted by this PR")] : report.edited.includes(file.path) ? [element("span", "review-flag", "edited by this PR")] : []),
    element("span", "review-size", countsText(file.counts)),
  );
  item.append(pick);
  return item;
}

function failingRow(test: FailingTest, pickNode: (id: NodeId) => void): HTMLElement {
  const item = element("li", "review-row");
  const pick = pickButton(() => pickNode(test.id));
  const text = element("span", "contract-text");
  text.append(element("span", "review-label", test.name), element("span", "contract-where", test.why === undefined ? test.file : `${test.file} · ${test.why}`));
  if (test.message !== undefined) text.append(element("span", "observed-message", test.message.split("\n")[0] ?? ""));
  pick.append(element("span", "review-mark observed-fail", "✗"), text);
  if (test.message !== undefined) pick.title = test.message;
  item.append(pick);
  return item;
}

function unmatchedRow(test: UnmatchedTest): HTMLElement {
  const item = element("li", "review-row observed-loose");
  const text = element("span", "contract-text");
  text.append(element("span", "review-label", test.name || "(the whole file)"), element("span", "contract-where", `${test.file} · ${test.why}`));
  item.append(element("span", `review-mark observed-${test.outcome}`, test.outcome === "fail" ? "✗" : test.outcome === "pass" ? "✓" : "·"), text);
  return item;
}
