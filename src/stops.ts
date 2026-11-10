import type { Comparison, ContractMove } from "./compare.ts";
import { effectLabel } from "./effects.ts";
import { isCodeNode } from "./graph.ts";
import type { Graph, LineRange, ModuleNode, NodeId } from "./graph.ts";
import { ROLLUP_OVER, effectChip, effectParts } from "./review.ts";
import type { Stop } from "./tour.ts";

// Page-safe: the walkthrough panel bundles this module, so nothing here may import node:*.

/**
 * What was observed at a stop, the fourth column of the walkthrough. Nothing records a run yet,
 * so every stop is "not run"; recorded test results join this union.
 */
export type Observed = { readonly status: "not run" };

export const NOT_RUN: Observed = { status: "not run" };

/** A new effect edge at a stop. */
export interface StopEffect {
  /** As effectLabel writes it. */
  readonly label: string;
  /** The class, function or file that makes the call. */
  readonly owner: NodeId;
  /** The stop's own node the call is written in: the owner, or the nearest node around it. */
  readonly at: NodeId;
  readonly range: LineRange;
  /** The stop's narration names its literal target or its API. */
  readonly mentioned: boolean;
}

/** A contract move at a stop. */
export interface StopMove {
  readonly move: ContractMove;
  /** The qualified name of the class or function. */
  readonly label: string;
  /** The stop's narration names the class or function. */
  readonly mentioned: boolean;
}

export interface StopFacts {
  readonly effects: readonly StopEffect[];
  readonly moves: readonly StopMove[];
  /** One line per thing the narration never names, effects first. Derived, never the agent's. */
  readonly notes: readonly string[];
}

/** Whether `text` holds `needle` as a whole name, in any case: "git" is in "runs Git." and not in "digit". */
function names(text: string, needle: string): boolean {
  if (needle.trim() === "") return false;
  const word = "\\p{ID_Continue}$";
  return new RegExp(`(?<![${word}])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![${word}])`, "iu").test(text);
}

/**
 * The derived facts at one stop, and what its narration leaves out. A stop holds its own nodes
 * and all code written inside them, so a file holds its functions and a function its closures.
 *
 * Its effects are the comparison's added effect edges made there; its moves are the contract
 * moves of nodes there. An effect is mentioned when a sentence of the stop names its literal
 * target or its API's own name ("git", "execFileSync"). A move is mentioned when a sentence names
 * the class or function, and a move of the effect set alone also when every effect in it is
 * mentioned. Only kept sentences count, since only they are shown.
 *
 * Notes list what is not mentioned: effects once per resource and target, then moves by id. More
 * than ROLLUP_OVER unnamed added (or moved) exports are one note. `graph` is the picture's graph.
 */
export function stopFacts(stop: Stop, comparison: Comparison, graph: Graph, moves: readonly ContractMove[]): StopFacts {
  const nodes = new Map<NodeId, ModuleNode>(graph.nodes.map((node) => [node.id, node]));
  for (const change of comparison.changes) if (!nodes.has(change.node.id)) nodes.set(change.node.id, change.node);
  const at = new Set(stop.ids);
  const here = (start: NodeId): NodeId | undefined => {
    for (let id: NodeId | null | undefined = start; id !== null && id !== undefined; id = nodes.get(id)?.parent) {
      if (at.has(id)) return id;
    }
    return undefined;
  };
  const said = stop.sentences.map((sentence) => sentence.text).join("\n");
  const saysEffect = (label: string): boolean => {
    const { name, literal } = effectParts(label);
    return names(said, name) || (literal !== undefined && names(said, literal));
  };

  const effects: StopEffect[] = [];
  for (const change of comparison.effects) {
    const holder = change.kind === "added" ? here(change.edge.from) : undefined;
    if (holder === undefined) continue;
    const label = effectLabel(change.edge);
    effects.push({ label, owner: change.edge.from, at: holder, range: change.edge.range, mentioned: saysEffect(label) });
  }

  const found: StopMove[] = [];
  for (const move of moves) {
    const node = nodes.get(move.id);
    if (node === undefined || !isCodeNode(node) || here(move.id) === undefined) continue;
    const labels = [...(move.effects?.added ?? []), ...(move.effects?.removed ?? [])];
    const mentioned = names(said, node.name) || names(said, node.qualifiedName) || (move.kind === "effects" && labels.every(saysEffect));
    found.push({ move, label: node.qualifiedName, mentioned });
  }

  const calls = new Map<string, number>();
  for (const effect of effects) if (!effect.mentioned) calls.set(effectChip(effect.label), (calls.get(effectChip(effect.label)) ?? 0) + 1);
  const notes = [...calls].map(([chip, count]) => `agent did not mention: ${chip}${count === 1 ? "" : ` (${count} calls)`}`);
  const unsaid = found.filter((move) => !move.mentioned);
  const bulk = new Set<string>();
  for (const kind of ["added", "moved"] as const) {
    const count = unsaid.filter((move) => move.move.kind === kind).length;
    if (count > ROLLUP_OVER) bulk.add(kind);
  }
  for (const move of unsaid) if (!bulk.has(move.move.kind)) notes.push(`agent did not mention: contract ${move.move.kind} ${move.label}`);
  for (const kind of bulk) notes.push(`agent did not mention: ${unsaid.filter((move) => move.move.kind === kind).length} ${kind} exports`);
  return { effects, moves: found, notes };
}
