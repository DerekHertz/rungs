import { contractsMoved } from "../compare.ts";
import { readableComparison } from "../readable.ts";
import type { FileTree } from "../graph.ts";
import { collectStandards } from "../standards.ts";
import { unknownTier } from "../tier-table.ts";
import { ownersOf } from "./claim-source.ts";
import type { StandardInput } from "./standard-gate.ts";
import { standardItems } from "./standard-source.ts";
import type { JudgeSubject } from "./subject.ts";

/** Which rule and which changed file a stored case is about. */
export interface StandardPick {
  /** The rule file in the base tree, "AGENTS.md" by default. */
  readonly rulePath?: string;
  /** The rule section's heading as written. */
  readonly heading: string;
  /** The changed file whose hunk is judged; the only changed file when left out. */
  readonly file?: string;
}

/**
 * Builds what the standard gate judges for one stored case, the way the running page builds it:
 * the two trees are extracted and compared, the rules are collected from the base, and
 * `standardItems` (the function the runner uses) cuts the changed files into hunks. Exactly one
 * hunk of one rule must match the pick, or this throws, naming how many did.
 */
export function standardInputFor(baseTree: FileTree, headTree: FileTree, pick: StandardPick): StandardInput {
  const { baseGraph, graph, comparison } = readableComparison(baseTree, headTree);
  const subject: JudgeSubject = {
    comparison,
    contracts: contractsMoved(comparison, baseGraph, graph),
    claims: [],
    baseTree,
    headTree,
    head: ownersOf(graph),
    base: ownersOf(baseGraph),
    standards: collectStandards({ graph: baseGraph, tree: baseTree }, headTree),
    // A bench case is judged at the gate's own thresholds: the input is all it takes from the item, and the tier is never read.
    tiers: unknownTier,
  };
  const found = standardItems(subject).items.filter((item) => item.input.rule.path === (pick.rulePath ?? "AGENTS.md") && item.input.rule.heading === pick.heading && (pick.file === undefined || item.input.hunk.path === pick.file));
  if (found.length !== 1) throw new Error(`${found.length} hunks match rule "${pick.heading}"${pick.file === undefined ? "" : ` in ${pick.file}`}; need exactly one`);
  return found[0]!.input;
}
