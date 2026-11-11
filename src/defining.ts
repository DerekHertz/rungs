import { contractsMoved } from "./compare.ts";
import type { Comparison, ContractMove } from "./compare.ts";
import { effectLabel } from "./effects.ts";
import { isCodeNode } from "./graph.ts";
import type { CodeNode, Graph, LineRange, ModuleNode, NodeId } from "./graph.ts";
import { exportNamesOf, exportRadiusOf, importanceOf } from "./importance.ts";
import { effectParts, isAnonymous, labelOf } from "./review.ts";

/*
 * A selected file says why it matters before its lines (SPEC, Review: Risks), all derived.
 *
 * "Most dependents" does not rank blocks: the graph has import edges between files and effect
 * edges from blocks, but no call edge from one block to another (calls are lazy, SPEC rule 4), so
 * a block has no dependents of its own, and every block of a file would share the file's count.
 * Blocks are ranked by the facts that are per block: a contract moved, an effect gained or
 * changed, exported. A block is defining when it has any of them.
 */

export interface Why {
  /** The contract moves in this file (an export only added is not one: nothing rests on it yet), one line each. */
  readonly contracts: readonly string[];
  /** The files resting on this one through imports, directly or not, sorted. */
  readonly dependents: readonly string[];
  /** New and changed effects in this file, one line each, sorted. */
  readonly effects: readonly string[];
  /** The test files that reach this one through import edges, sorted. */
  readonly testReaches: readonly string[];
  /** True when the file is itself a test file, so "a test reaches it" does not apply. */
  readonly isTest: boolean;
}

export interface Block {
  readonly id: NodeId;
  readonly level: "class" | "function" | "constant";
  readonly label: string;
  readonly range: LineRange;
  /** Why it is defining, most important first; empty for another changed block. */
  readonly reasons: readonly string[];
  /** The unnamed callbacks inside it that changed, folded under it. */
  readonly folded: readonly NodeId[];
  /**
   * Only for an exported block: the files that rest on the names it is exported under, sorted:
   * those whose imports take the name (or all of the file), directly or through re-exports, and
   * the files resting on them. Never fewer than the truth: a use the extractor cannot name counts.
   */
  readonly rests?: readonly string[];
}

export interface FileWhy {
  readonly id: NodeId;
  readonly why: Why;
  readonly defining: readonly Block[];
  readonly other: readonly Block[];
  /** Changed unnamed callbacks with no named holder, and changed imports: folded under the file. */
  readonly foldedLoose: { readonly callbacks: number; readonly imports: number };
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const WORD: Record<ContractMove["kind"], string> = {
  changed: "signature changed",
  effects: "effects changed",
  added: "newly added",
  removed: "removed",
  unexported: "no longer exported",
  exposed: "newly exported",
  moved: "moved",
};

/**
 * The why-line and the block list of the file `fileId`, or undefined when the head has no such
 * file. `head` and `base` are the graphs `comparison` was made from; `isTest` is the test-file
 * predicate (isTestFile), passed in so this module stays free of node:*.
 */
export function fileWhy(fileId: NodeId, comparison: Comparison, base: Graph, head: Graph, isTest: (path: string) => boolean): FileWhy | undefined {
  const file = head.nodes.find((node) => node.id === fileId);
  if (file === undefined || file.level !== "file") return undefined;
  const nodes = new Map<NodeId, ModuleNode>(head.nodes.map((node) => [node.id, node]));
  const path = file.path;

  /** The named block an owner stands in: itself if named, else the nearest named holder. */
  const holderOf = (id: NodeId): CodeNode | undefined => {
    for (let at = nodes.get(id); at !== undefined && isCodeNode(at); at = nodes.get(at.parent)) {
      if (!isAnonymous(at)) return at;
    }
    return undefined;
  };

  const moves = contractsMoved(comparison, base, head).filter(
    (move) => move.kind !== "added" && (nodes.get(move.id) ?? base.nodes.find((node) => node.id === move.id))?.path === path,
  );
  const effectLines = new Map<NodeId, Set<string>>();
  const effects = new Set<string>();
  const noteEffect = (owner: NodeId, line: string): void => {
    effects.add(line);
    const holder = holderOf(owner);
    if (holder !== undefined) effectLines.set(holder.id, (effectLines.get(holder.id) ?? new Set()).add(line));
  };
  for (const change of comparison.effects) {
    if (change.kind === "added" && nodes.get(change.edge.from)?.path === path) noteEffect(change.edge.from, `new ${effectLabel(change.edge)}`);
  }
  for (const change of comparison.changedEffects) {
    // Module resolution is recorded beside effects but names no resource.
    if (effectParts(change.label).resource !== undefined && nodes.get(change.owner)?.path === path) noteEffect(change.owner, `changed ${change.label}`);
  }

  const moveBy = new Map<NodeId, ContractMove>(moves.map((move) => [move.id, move]));
  const folds = new Map<NodeId, NodeId[]>();
  let loose = 0;
  for (const change of comparison.changes) {
    const node = change.node;
    if (change.kind === "removed" || !isCodeNode(node) || node.path !== path || !isAnonymous(node)) continue;
    const holder = holderOf(node.id);
    if (holder === undefined) loose += 1;
    else folds.set(holder.id, [...(folds.get(holder.id) ?? []), node.id]);
  }
  const blocks: Block[] = [];
  const radius = exportRadiusOf(head);
  const restsOf = (node: CodeNode): readonly string[] | undefined => {
    if (!node.exported) return undefined;
    const was = base.nodes.find((candidate) => candidate.id === (moveBy.get(node.id)?.from ?? node.id));
    return radius(file.id, exportNamesOf(was === undefined ? [node] : [node, was])).map((id) => nodes.get(id)?.path ?? id).sort(byText);
  };
  const changedIds = new Set<NodeId>(comparison.changes.filter((change) => change.kind === "altered" || change.kind === "added").map((change) => change.node.id));
  // A block is listed when its text changed, or when a contract moved or an effect arrived at it with the text the same (an import now points elsewhere).
  for (const node of head.nodes) {
    if (!isCodeNode(node) || node.path !== path || isAnonymous(node)) continue;
    const move = moveBy.get(node.id);
    if (!changedIds.has(node.id) && move === undefined && !effectLines.has(node.id)) continue;
    const reasons = [...(move === undefined ? [] : [`contract ${WORD[move.kind]}`]), ...[...(effectLines.get(node.id) ?? [])].sort(byText), ...(node.exported ? ["exported"] : [])];
    const rests = restsOf(node);
    blocks.push({ id: node.id, level: node.level, label: labelOf(node), range: node.range, reasons, folded: (folds.get(node.id) ?? []).sort(byText), ...(rests === undefined ? {} : { rests }) });
  }
  // A moved contract first, then an effect, then exported; within a rank, in source order.
  const rank = (block: Block): number =>
    block.reasons.some((reason) => reason.startsWith("contract ")) ? 0 : block.reasons.some((reason) => reason !== "exported") ? 1 : block.reasons.length > 0 ? 2 : 3;
  blocks.sort((a, b) => rank(a) - rank(b) || a.range.start - b.range.start || byText(a.id, b.id));

  const rests = (importanceOf(head).get(file.id) ?? []).map((id) => nodes.get(id)?.path ?? id).sort(byText);
  const nameOf = (id: NodeId): string => {
    const node = nodes.get(id) ?? base.nodes.find((candidate) => candidate.id === id);
    return node !== undefined && isCodeNode(node) ? node.qualifiedName : (node?.path ?? id);
  };
  return {
    id: file.id,
    why: {
      contracts: moves.map((move) => `${move.type?.name ?? nameOf(move.id)} ${WORD[move.kind]}`).sort(byText),
      dependents: rests,
      effects: [...effects].sort(byText),
      testReaches: rests.filter(isTest),
      isTest: isTest(path),
    },
    defining: blocks.filter((block) => block.reasons.length > 0),
    other: blocks.filter((block) => block.reasons.length === 0),
    foldedLoose: { callbacks: loose, imports: comparison.imports.filter((change) => nodes.get(change.edge.from)?.path === path).length },
  };
}

/** One step of a block's neighbours. `unresolved` is shown as that, never guessed (SPEC rule 5). */
export interface Step {
  readonly label: string;
  /** A file the step can open one step further from. */
  readonly open?: NodeId;
  readonly unresolved?: true;
}

/**
 * The first step of what a block calls: its outside calls, named by their target (an unknown
 * target is unresolved). Calls from one block to another are not in the graph, so they are
 * listed as unresolved rather than guessed.
 */
export function calleesOf(graph: Graph, blockId: NodeId): Step[] {
  const nodes = new Map<NodeId, ModuleNode>(graph.nodes.map((node) => [node.id, node]));
  const inside = (owner: NodeId): boolean => {
    for (let at = nodes.get(owner); at !== undefined; at = isCodeNode(at) ? nodes.get(at.parent) : undefined) if (at.id === blockId) return true;
    return false;
  };
  const steps = new Map<string, Step>();
  for (const edge of graph.edges) {
    if (!inside(edge.from)) continue;
    const text = effectLabel(edge);
    if (edge.target === "unknown") steps.set(`${text}: target unresolved`, { label: `${text}: target unresolved`, unresolved: true });
    else steps.set(text, { label: text });
  }
  const others: Step = { label: "calls to other functions", unresolved: true };
  return [...steps.values(), others].sort(
    (a, b) => Number(a.label === "calls to other functions") - Number(b.label === "calls to other functions") || byText(a.label, b.label),
  );
}

/**
 * The first step of what calls a block: the files that import its file directly. An import edge
 * names the file, not the export it uses, so which block of it each file calls is unresolved, and
 * so is a caller inside the same file. Each file opens one step further, through `importersOf`.
 */
export function callersOf(graph: Graph, blockId: NodeId): Step[] {
  const block = graph.nodes.find((node) => node.id === blockId);
  if (block === undefined) return [{ label: "callers", unresolved: true }];
  return [...importersOf(graph, `file:${block.path}` as NodeId), { label: "callers of this block", unresolved: true }];
}

/** The files that import `fileId` directly, sorted by path; each can open one step further. */
export function importersOf(graph: Graph, fileId: NodeId): Step[] {
  const from = new Set<NodeId>();
  for (const edge of graph.imports) if ("file" in edge.target && edge.target.file === fileId && edge.from !== fileId) from.add(edge.from);
  const names = new Map<NodeId, string>(graph.nodes.map((node) => [node.id, node.path]));
  return [...from].map((id): Step => ({ label: `${names.get(id) ?? id} imports this file (calls not resolved)`, open: id })).sort((a, b) => byText(a.label, b.label));
}

export const count = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** New and changed effects counted apart: each line from `fileWhy` starts with "new " or "changed ". */
function effectsText(effects: readonly string[]): string {
  const added = effects.filter((line) => line.startsWith("new ")).length;
  const changed = effects.length - added;
  if (effects.length === 0) return "no new or changed effect";
  return [added > 0 ? count(added, "new effect") : "", changed > 0 ? count(changed, "changed effect") : ""].filter((part) => part !== "").join(" · ");
}

/** The one line that says why the file matters: derived facts only, each a number or a name. */
export function whyLine(found: FileWhy): string {
  const { why } = found;
  const parts = [
    why.contracts.length === 0 ? "no contract moved" : `${count(why.contracts.length, "contract")} moved`,
    why.dependents.length === 0 ? "no file rests on it" : `${count(why.dependents.length, "file")} rest on it`,
    effectsText(why.effects),
    why.isTest ? "is a test file" : why.testReaches.length === 0 ? "no test reaches it" : `${count(why.testReaches.length, "test file")} reach it`,
  ];
  return parts.join(" · ");
}

