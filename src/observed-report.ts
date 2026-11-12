import type { ChangeKind, Comparison } from "./compare.ts";
import type { Graph, NodeId } from "./graph.ts";
import { countsAsFailing } from "./observed-types.ts";
import type { Counts, ObservedDocument, ObservedTest, Outcome, RanObserved, Verdict } from "./observed-types.ts";

export type RanDocument = RanObserved;

/**
 * A test file of the base and how main's tests in it went against the head, all zero when none of
 * them ran. A file the PR deleted or edited is the base's version that ran.
 */
export interface FileResults {
  readonly id: NodeId;
  readonly path: string;
  readonly change: ChangeKind;
  readonly counts: Counts;
  /** Failures that also happen on main's code (environment), when there are any: not counted in `counts.fail`. */
  readonly environment?: number;
  /** With a control run, tests that failed on main and pass now. `counts.pass` is then only what passed on both. */
  readonly fixed?: number;
  /** With a control run, tests skipped on a side, reported by one run only, or named twice: neither passes nor regressions. */
  readonly notCompared?: number;
}

/**
 * A file's mark: a tick only when everything compared passed on both sides. A regression and an
 * environment failure are both a cross (the page dims the environment one); tests not compared or
 * fixed leave it neutral; no result is none.
 */
export function fileMark(file: FileResults): Outcome | "none" {
  if (file.counts.fail > 0 || (file.environment ?? 0) > 0) return "fail";
  if ((file.notCompared ?? 0) > 0 || (file.fixed ?? 0) > 0) return "skip";
  return file.counts.pass + file.counts.skip === 0 ? "none" : "pass";
}

/** What the tests this PR wrote or edited came to. They are the PR's claim, never evidence. */
export type WrittenReport =
  | { readonly status: "failed" | "unreliable"; readonly files: readonly string[]; readonly why: string }
  | { readonly status: "ran"; readonly files: readonly { readonly path: string; readonly counts: Counts }[]; readonly counts: Counts; readonly failing: readonly { readonly file: string; readonly name: string; readonly message?: string }[] };

export interface FailingTest {
  /** The test function, or its file when no single test function matched. */
  readonly id: NodeId;
  readonly file: string;
  readonly name: string;
  readonly message?: string;
  /** Why the test is not attached to a test function, when it is not. */
  readonly why?: string;
  readonly outcome: Outcome;
  /** Against the control run; absent when there is none. */
  readonly verdict?: Verdict;
}

/** The mark of a row of the lists: a fixed test passes now, every other row is what the PR's run made of it. */
export function rowOutcome(test: { readonly outcome: Outcome; readonly verdict?: Verdict }): Outcome {
  return test.verdict === "fixed" ? "pass" : test.outcome;
}

export interface ObservedReport {
  /** Changed test files and deleted ones, or any with a result: failing first, then those with no result, then by path. */
  readonly files: readonly FileResults[];
  /** Base test files this PR deleted, which ran anyway; and those it edited, whose base versions ran. */
  readonly deleted: readonly string[];
  readonly edited: readonly string[];
  readonly written: WrittenReport | null;
  /** The failures held against the PR: regressions when the control run gave results, else every failure of the head run. Attached ones in the order they ran, then the unattached. */
  readonly failing: readonly FailingTest[];
  /** What else the head run reported that is not a pass: environment failures, fixed, skipped and one-sided tests. Empty without a control run. The full list is `failing` and these. */
  readonly others: readonly FailingTest[];
  /** Whether the control run gave results; else why not, and `failing` is the head run's failures labelled so. */
  readonly control: { readonly status: "ran" } | { readonly status: string; readonly why: string };
  /** The files holding a failing test, which the picture marks. */
  readonly failingFiles: ReadonlySet<NodeId>;
}

const fileId = (path: string) => `file:${path}` as NodeId;

/** What the panel and the picture show of one test run, beside the comparison it ran for. */
export function observedReport(document: RanDocument, graph: Graph, comparison: Comparison): ObservedReport {
  const paths = new Map(graph.nodes.map((node) => [node.id, node.path]));
  // The old path of a moved file (and its functions) is a place of the picture (rubble) that only the base had: its tests ran there.
  for (const change of comparison.changes) if (change.kind === "moved") paths.set(change.from.id, change.from.path);
  const counts = new Map<string, { pass: number; fail: number; skip: number; environment: number; fixed: number; notCompared: number }>();
  const { control } = document;
  const tally = (path: string, test: ObservedTest) => {
    const count = counts.get(path) ?? { pass: 0, fail: 0, skip: 0, environment: 0, fixed: 0, notCompared: 0 };
    if (control.status !== "ran") count[test.outcome] += 1;
    // With a control run the counts are the verdicts': a pass is a pass on both sides.
    else if (test.verdict === "regression") count.fail += 1;
    else if (test.verdict === "environment") count.environment += 1;
    else if (test.verdict === "passes") count.pass += 1;
    else if (test.verdict === "fixed") count.fixed += 1;
    else count.notCompared += 1;
    counts.set(path, count);
  };
  if (control.status === "ran") {
    for (const test of control.baseOnly) {
      const count = counts.get(test.file) ?? { pass: 0, fail: 0, skip: 0, environment: 0, fixed: 0, notCompared: 0 };
      count.notCompared += 1;
      counts.set(test.file, count);
    }
  }
  const failing: FailingTest[] = [];
  const others: FailingTest[] = [];
  const sort = (test: ObservedTest, row: FailingTest) => {
    if (countsAsFailing(control, test)) failing.push(row);
    else if (test.outcome === "fail" || (test.verdict !== undefined && test.verdict !== "passes")) others.push(row);
  };
  for (const [id, results] of Object.entries(document.tests)) {
    const file = paths.get(id as NodeId) ?? "";
    for (const result of results) {
      tally(file, result);
      sort(result, { id: id as NodeId, file, name: result.name, outcome: result.outcome, ...(result.message ? { message: result.message } : {}), ...(result.verdict ? { verdict: result.verdict } : {}) });
    }
  }
  for (const result of document.unmatched) {
    tally(result.file, result);
    sort(result, { id: fileId(result.file), file: result.file, name: result.name, outcome: result.outcome, ...(result.message ? { message: result.message } : {}), why: result.why, ...(result.verdict ? { verdict: result.verdict } : {}) });
  }
  const deleted = new Set(document.deleted);
  const files: FileResults[] = [];
  for (const change of comparison.changes) {
    const node = change.node;
    if (node.level !== "file" || (change.kind === "removed" && !deleted.has(node.path))) continue;
    const count = counts.get(node.path);
    if (count === undefined && node.role !== "tests") continue;
    const { environment, fixed, notCompared, ...own } = count ?? { pass: 0, fail: 0, skip: 0, environment: 0, fixed: 0, notCompared: 0 };
    files.push({
      id: node.id,
      path: node.path,
      change: change.kind,
      counts: own,
      ...(environment > 0 ? { environment } : {}),
      ...(fixed > 0 ? { fixed } : {}),
      ...(notCompared > 0 ? { notCompared } : {}),
    });
  }
  const rank = (file: FileResults) => (file.counts.fail > 0 ? 0 : file.counts.pass + file.counts.skip === 0 ? 1 : 2);
  files.sort((a, b) => rank(a) - rank(b) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const failingFiles = new Set(failing.map((test) => fileId(test.file)).filter((id) => paths.has(id)));
  const how = control.status === "ran" ? ({ status: "ran" } as const) : { status: control.status, why: control.why };
  return { files, deleted: document.deleted, edited: document.edited, written: writtenReport(document.written), failing, others, control: how, failingFiles };
}

function writtenReport(written: RanDocument["written"]): WrittenReport | null {
  if (written === null) return null;
  if (written.status !== "ran") return { status: written.status, files: written.files, why: written.why };
  const byFile = new Map<string, { pass: number; fail: number; skip: number }>(written.files.map((path) => [path, { pass: 0, fail: 0, skip: 0 }]));
  for (const test of written.tests) {
    const count = byFile.get(test.file) ?? { pass: 0, fail: 0, skip: 0 };
    count[test.outcome] += 1;
    byFile.set(test.file, count);
  }
  const failing = written.tests.filter((test) => test.outcome === "fail").map((test) => ({ file: test.file, name: test.name, ...(test.message ? { message: test.message } : {}) }));
  return { status: "ran", files: [...byFile].map(([path, counts]) => ({ path, counts })), counts: written.counts, failing };
}

/** What the page says of a run whose results contradict the runner or each other. */
export function unreliableText(document: Extract<ObservedDocument, { status: "unreliable" }>): string {
  return `Results unreliable: ${document.why}. The node --test run (exit ${document.exitCode}, ${document.seconds}s) is not shown, because its results cannot be told from ones the tests wrote themselves.`;
}
