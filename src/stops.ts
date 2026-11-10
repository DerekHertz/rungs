import type { Comparison, ContractMove } from "./compare.ts";
import { effectLabel } from "./effects.ts";
import { isCodeNode } from "./graph.ts";
import type { Graph, LineRange, ModuleNode, NodeId } from "./graph.ts";
import { ROLLUP_OVER, effectChip, effectParts } from "./review.ts";
import type { Stop, Tour } from "./tour.ts";

// Page-safe: the walkthrough panel bundles this module, so nothing here may import node:*.

/**
 * What was observed at a stop, the fourth column of the walkthrough. Nothing records a run yet,
 * so every stop is "not run"; recorded test results join this union.
 */
export type Observed = { readonly status: "not run" };

export const NOT_RUN: Observed = { status: "not run" };

/** An effect edge that appeared or went away at a stop. */
export interface StopEffect {
  readonly kind: "added" | "removed";
  /** As effectLabel writes it. */
  readonly label: string;
  /** The class, function or file that makes the call. */
  readonly owner: NodeId;
  /** The stop's own node the call is written in: the owner, or the nearest node around it. */
  readonly at: NodeId;
  /** The call's lines: in the head for an added edge, in the base for a removed one. */
  readonly range: LineRange;
  /** The call is in a file whose role is tests. */
  readonly tests: boolean;
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
 * Its effects are the comparison's effect edges that appeared or went away there; its moves are
 * the contract moves of nodes there. An effect is mentioned when a sentence of the stop names its
 * literal target or its API's own name ("git", "execFileSync"), and only then: naming the function
 * that lost a call does not mention the call. A move is mentioned when a sentence names the class
 * or function, and a move of the effect set alone also when every effect in it is mentioned. Only
 * kept sentences count, since only they are shown.
 *
 * Notes list what is not mentioned: effects once per resource and target, added then removed,
 * then one line for all of those in test files, then moves by id. More than ROLLUP_OVER unnamed
 * added (or moved) exports are one note. `graph` is the picture's graph.
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

  const inTests = (owner: NodeId): boolean => {
    const path = nodes.get(owner)?.path;
    const file = path === undefined ? undefined : nodes.get(`file:${path}` as NodeId);
    return file?.level === "file" && file.role === "tests";
  };
  const effects: StopEffect[] = [];
  for (const { kind, edge } of comparison.effects) {
    const holder = here(edge.from);
    if (holder === undefined) continue;
    const label = effectLabel(edge);
    effects.push({ kind, label, owner: edge.from, at: holder, range: edge.range, tests: inTests(edge.from), mentioned: saysEffect(label) });
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
  const testFiles = new Set<string>();
  let testEdges = 0;
  for (const effect of [...effects].sort((x, y) => Number(x.kind === "removed") - Number(y.kind === "removed"))) {
    if (effect.mentioned) continue;
    if (effect.tests) {
      testEdges++;
      testFiles.add(nodes.get(effect.owner)!.path);
      continue;
    }
    const chip = `${effect.kind === "removed" ? "removed " : ""}${effectChip(effect.label)}`;
    calls.set(chip, (calls.get(chip) ?? 0) + 1);
  }
  const notes = [...calls].map(([chip, count]) => `agent did not mention: ${chip}${count === 1 ? "" : ` (${count} calls)`}`);
  if (testEdges > 0) {
    notes.push(`agent did not mention: ${testEdges} effect ${testEdges === 1 ? "edge" : "edges"} changed in ${testFiles.size} test ${testFiles.size === 1 ? "file" : "files"}`);
  }
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

/** How many of the changed files the tour's stops point at or into. A stop id that is no changed file's counts for nothing. */
export function tourCoverage(stops: readonly Stop[], comparison: Comparison): { readonly covered: number; readonly changed: number } {
  const pathOf = new Map<NodeId, string>(comparison.changes.map((change) => [change.node.id, change.node.path]));
  const files = new Set<string>();
  for (const change of comparison.changes) if (change.node.level === "file") files.add(change.node.path);
  const covered = new Set<string>();
  for (const stop of stops) {
    for (const id of stop.ids) {
      const path = pathOf.get(id);
      if (path !== undefined && files.has(path)) covered.add(path);
    }
  }
  return { covered: covered.size, changed: files.size };
}

/** How the tour was made, as /walkthrough.json says. */
export type WalkNote =
  | { readonly status: "off" }
  | { readonly status: "ok"; readonly model: string; readonly promptVersion: string; readonly dropped: Tour["dropped"]; readonly cached: boolean }
  | { readonly status: "failed"; readonly message: string };

/** One line on how the tour was made, or why there is none. */
export function walkSummary(note: WalkNote, stops: number): string {
  if (note.status === "failed") return `No walkthrough: ${note.message}.`;
  if (note.status === "off") return "No walkthrough; run with --walkthrough for an agent's tour of the change.";
  const d = note.dropped;
  return `${stops} ${stops === 1 ? "stop" : "stops"} by ${note.model}${note.cached ? ", cached" : ""} (prompt ${note.promptVersion}); dropped ${d.stops} stops, ${d.ids} unknown ids, ${d.claims} bad claim numbers and ${d.sentences} unanchored sentences, not shown.`;
}
