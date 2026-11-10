import type { ChangeKind, Comparison } from "./compare.ts";
import type { Graph, NodeId } from "./graph.ts";
import type { Counts, ObservedDocument } from "./observed-types.ts";

export type RanDocument = Extract<ObservedDocument, { status: "ran" }>;

/** A changed test file and how its tests went, all zero when none of them ran. */
export interface FileResults {
  readonly id: NodeId;
  readonly path: string;
  readonly change: ChangeKind;
  readonly counts: Counts;
}

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
  /** Changed files that are tests or had a result: failing first, then those with no result, then by path. */
  readonly files: readonly FileResults[];
  /** Attached ones in the order they ran, then the unattached. */
  readonly failing: readonly FailingTest[];
  /** The files holding a failing test, which the picture marks. */
  readonly failingFiles: ReadonlySet<NodeId>;
}

const fileId = (path: string) => `file:${path}` as NodeId;

/** What the panel and the picture show of one test run, beside the comparison it ran for. */
export function observedReport(document: RanDocument, graph: Graph, comparison: Comparison): ObservedReport {
  const paths = new Map(graph.nodes.map((node) => [node.id, node.path]));
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
  const files: FileResults[] = [];
  for (const change of comparison.changes) {
    const node = change.node;
    if (node.level !== "file" || change.kind === "removed") continue;
    const count = counts.get(node.path);
    if (count === undefined && node.role !== "tests") continue;
    files.push({ id: node.id, path: node.path, change: change.kind, counts: count ?? { pass: 0, fail: 0, skip: 0 } });
  }
  const rank = (file: FileResults) => (file.counts.fail > 0 ? 0 : file.counts.pass + file.counts.skip === 0 ? 1 : 2);
  files.sort((a, b) => rank(a) - rank(b) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const failingFiles = new Set(failing.map((test) => fileId(test.file)).filter((id) => paths.has(id)));
  return { files, failing, failingFiles };
}
