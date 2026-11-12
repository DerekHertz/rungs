import { contractsMoved } from "../compare.ts";
import { readableComparison } from "../readable.ts";
import { collectStandards } from "../standards.ts";
import type { FileTree, NodeId } from "../graph.ts";
import type { ClaimInput } from "./claim-gate.ts";
import { claimItems, ownersOf } from "./claim-source.ts";
import type { JudgeSubject } from "./subject.ts";

/**
 * Builds what the claim gate judges for one stored case, the way the running page builds it: the
 * two trees are extracted and compared, each linked file's derived facts and changed lines come
 * from `claimItems`, the same function the claim runner uses. `files` names the changed files the
 * claim is linked to (the reviewer's linker picks these on a real run); left out, every changed
 * file is linked. Files that are not a changed file of the comparison are ignored.
 */
export function claimInputFor(baseTree: FileTree, headTree: FileTree, claim: string, files?: readonly string[]): ClaimInput {
  const { baseGraph, graph, comparison } = readableComparison(baseTree, headTree);
  const ids: NodeId[] = [];
  for (const change of comparison.changes) {
    if (change.node.level !== "file") continue;
    if (files === undefined || files.includes(change.node.path)) ids.push(change.node.id);
  }
  const subject: JudgeSubject = {
    comparison,
    contracts: contractsMoved(comparison, baseGraph, graph),
    claims: [{ index: 0, text: claim, ids }],
    baseTree,
    headTree,
    head: ownersOf(graph),
    base: ownersOf(baseGraph),
    standards: collectStandards({ graph: baseGraph, tree: baseTree }, headTree),
  };
  const item = claimItems(subject)[0];
  return item?.input ?? { claim, places: [], omittedPlaces: 0 };
}
