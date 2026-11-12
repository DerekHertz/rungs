import type { ContractMove } from "../compare.ts";
import { effectLabel } from "../effects.ts";
import { diffText } from "../diff.ts";
import { isCodeNode } from "../graph.ts";
import type { Graph, NodeId } from "../graph.ts";
import { isBinary } from "../lines.ts";
import { CLAIM_THRESHOLDS, MAX_CHANGED_LINES, MAX_FACTS, MAX_LINE_CHARS, MAX_PLACES, claimGate } from "./claim-gate.ts";
import type { ClaimInput, PlaceFacts } from "./claim-gate.ts";
import type { GateContext, GateRunner } from "./source.ts";
import { judgeItems } from "./store.ts";
import type { Item } from "./store.ts";
import type { JudgeSubject, Owners } from "./subject.ts";

/** The owning file and name of every node of `graph`, read from the nodes themselves. */
export function ownersOf(graph: Graph): Owners {
  return new Map(graph.nodes.map((node) => [node.id, { path: node.path, name: isCodeNode(node) ? node.qualifiedName : "" }]));
}
const clip = (text: string): string => (text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}...` : text);

/** What one linked file is shown as: derived facts from the comparison, and its changed lines from a line diff of the two trees. */
function placeOf(id: NodeId, subject: JudgeSubject): PlaceFacts | undefined {
  const { comparison, contracts, baseTree, headTree } = subject;
  const inHead = (id: NodeId, file: string): boolean => subject.head.get(id)?.path === file;
  const inBase = (id: NodeId, file: string): boolean => subject.base.get(id)?.path === file;
  const change = comparison.changes.find((found) => found.node.id === id);
  if (change === undefined) return undefined;
  const path = change.node.path;
  const basePath = change.kind === "moved" ? change.from.path : change.kind === "removed" ? change.node.path : path;
  const label = change.kind === "moved" ? `moved ${change.from.path} to ${path}` : `${change.kind} ${path}`;

  const facts: string[] = [];
  for (const other of comparison.changes) {
    if (other.node.path !== path || !isCodeNode(other.node)) continue;
    const signature = other.kind === "altered" && isCodeNode(other.before) && other.before.signature !== other.node.signature ? `: ${clip(other.before.signature)} -> ${clip(other.node.signature)}` : "";
    facts.push(`${other.kind} ${other.node.level} ${other.node.qualifiedName}${signature}`);
  }
  // A move names the head node (the base node for a removed one, the old id too for a moved one); the owning file comes from the graph's node.
  const inFile = (move: ContractMove): boolean => inHead(move.id, path) || inBase(move.id, basePath) || (move.from !== undefined && inBase(move.from, basePath));
  for (const move of contracts.filter(inFile)) {
    const name = move.type?.name ?? move.exportName ?? subject.head.get(move.id)?.name ?? subject.base.get(move.id)?.name ?? "";
    facts.push(`contract ${move.kind} ${name}: ${move.before === null ? "(none)" : clip(move.before)} -> ${move.after === null ? "(none)" : clip(move.after)}`);
    for (const effect of move.effects?.added ?? []) facts.push(`  effect gained by ${name}: ${effect}`);
    for (const effect of move.effects?.removed ?? []) facts.push(`  effect lost by ${name}: ${effect}`);
  }
  for (const effect of comparison.effects) {
    if (effect.kind === "added" ? inHead(effect.edge.from, path) : inBase(effect.edge.from, basePath)) facts.push(`effect call ${effect.kind}: ${effectLabel(effect.edge)}`);
  }
  // Calls that stay but take other arguments, worded as the page words them: "+" what the head gained, "−" what it lost.
  for (const changed of comparison.changedEffects) {
    if (!inHead(changed.owner, path)) continue;
    const count = changed.count > 1 ? ` x${changed.count}` : "";
    facts.push(`effect call changed: ${changed.label}${count}: ${[...changed.added.map((token) => `+ ${token}`), ...changed.removed.map((token) => `− ${token}`)].join(" ")}`);
  }
  const shownFacts = facts.slice(0, MAX_FACTS);
  if (facts.length > shownFacts.length) shownFacts.push(`[${facts.length - shownFacts.length} more facts were cut]`);

  const before = change.kind === "added" ? "" : baseTree.get(basePath);
  const after = change.kind === "removed" ? "" : headTree.get(path);
  if (before === undefined || after === undefined) return { label, facts: shownFacts, lines: [], cutLines: 0, noLines: "the file's text is not in the tree" };
  if (isBinary(before) || isBinary(after)) return { label, facts: shownFacts, lines: [], cutLines: 0, noLines: "binary file" };
  let ops;
  try {
    ops = diffText(before, after);
  } catch {
    ops = undefined;
  }
  if (ops === undefined) return { label, facts: shownFacts, lines: [], cutLines: 0, noLines: "too large to diff" };
  const changed = ops.flatMap((op) => (op.kind === "added" ? [`+${op.head}: ${clip(op.text)}`] : op.kind === "removed" ? [`-${op.base}: ${clip(op.text)}`] : []));
  if (changed.length === 0) return { label, facts: shownFacts, lines: [], cutLines: 0, noLines: change.kind === "moved" ? "moved with no line changed" : "no line changed" };
  return { label, facts: shownFacts, lines: changed.slice(0, MAX_CHANGED_LINES), cutLines: Math.max(0, changed.length - MAX_CHANGED_LINES) };
}

/** One item per claim that has links: its sentence, and the facts and changed lines of its linked places. Unlinked claims are not judged. */
export function claimItems(subject: JudgeSubject): Item<ClaimInput>[] {
  return subject.claims
    .filter((claim) => claim.ids.length > 0)
    .map((claim) => {
      const places = claim.ids.flatMap((id) => placeOf(id, subject) ?? []);
      const input: ClaimInput = { claim: claim.text, places: places.slice(0, MAX_PLACES), omittedPlaces: Math.max(0, places.length - MAX_PLACES) };
      return { key: `claim:${claim.index}`, about: { claim: claim.index }, input };
    });
}

/** The claim gate's runner: judges each linked claim once per comparison, through the judged store. */
export const claimRunner: GateRunner = (context: GateContext) =>
  judgeItems({
    gate: claimGate,
    items: claimItems(context.subject),
    thresholds: CLAIM_THRESHOLDS,
    client: context.client,
    base: context.base,
    head: context.head,
    cacheDir: context.cacheDir,
  });
