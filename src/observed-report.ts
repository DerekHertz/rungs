import type { ChangeKind, Comparison } from "./compare.ts";
import type { Graph, NodeId } from "./graph.ts";
import type { Counts, ObservedDocument } from "./observed-types.ts";

export type RanDocument = Extract<ObservedDocument, { status: "ran" }>;

/**
 * A test file of the base and how main's tests in it went against the head, all zero when none of
 * them ran. A file the PR deleted or edited is the base's version that ran.
 */
export interface FileResults {
  readonly id: NodeId;
  readonly path: string;
  readonly change: ChangeKind;
  readonly counts: Counts;
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
}

export interface ObservedReport {
  /** Changed test files and deleted ones, or any with a result: failing first, then those with no result, then by path. */
  readonly files: readonly FileResults[];
  /** Base test files this PR deleted, which ran anyway; and those it edited, whose base versions ran. */
  readonly deleted: readonly string[];
  readonly edited: readonly string[];
  readonly written: WrittenReport | null;
  /** Attached ones in the order they ran, then the unattached. */
  readonly failing: readonly FailingTest[];
  /** The files holding a failing test, which the picture marks. */
  readonly failingFiles: ReadonlySet<NodeId>;
}

const fileId = (path: string) => `file:${path}` as NodeId;

/** What the panel and the picture show of one test run, beside the comparison it ran for. */
export function observedReport(document: RanDocument, graph: Graph, comparison: Comparison): ObservedReport {
  const paths = new Map(graph.nodes.map((node) => [node.id, node.path]));
  // The old path of a moved file (and its functions) is a place of the picture (rubble) that only the base had: its tests ran there.
  for (const change of comparison.changes) if (change.kind === "moved") paths.set(change.from.id, change.from.path);
  const counts = new Map<string, { pass: number; fail: number; skip: number }>();
  const tally = (path: string, outcome: keyof Counts) => {
    const count = counts.get(path) ?? { pass: 0, fail: 0, skip: 0 };
    count[outcome] += 1;
    counts.set(path, count);
  };
  const failing: FailingTest[] = [];
  for (const [id, results] of Object.entries(document.tests)) {
    const file = paths.get(id as NodeId) ?? "";
    for (const result of results) {
      tally(file, result.outcome);
      if (result.outcome === "fail") failing.push({ id: id as NodeId, file, name: result.name, ...(result.message ? { message: result.message } : {}) });
    }
  }
  for (const result of document.unmatched) {
    tally(result.file, result.outcome);
    if (result.outcome === "fail") {
      failing.push({ id: fileId(result.file), file: result.file, name: result.name, ...(result.message ? { message: result.message } : {}), why: result.why });
    }
  }
  const deleted = new Set(document.deleted);
  const files: FileResults[] = [];
  for (const change of comparison.changes) {
    const node = change.node;
    if (node.level !== "file" || (change.kind === "removed" && !deleted.has(node.path))) continue;
    const count = counts.get(node.path);
    if (count === undefined && node.role !== "tests") continue;
    files.push({ id: node.id, path: node.path, change: change.kind, counts: count ?? { pass: 0, fail: 0, skip: 0 } });
  }
  const rank = (file: FileResults) => (file.counts.fail > 0 ? 0 : file.counts.pass + file.counts.skip === 0 ? 1 : 2);
  files.sort((a, b) => rank(a) - rank(b) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const failingFiles = new Set(failing.map((test) => fileId(test.file)).filter((id) => paths.has(id)));
  return { files, deleted: document.deleted, edited: document.edited, written: writtenReport(document.written), failing, failingFiles };
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
