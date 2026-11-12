import type { Comparison, ContractMove } from "./compare.ts";
import { effectLabel } from "./effects.ts";
import { isCodeNode } from "./graph.ts";
import type { Graph, LineRange, ModuleNode, NodeId } from "./graph.ts";
import type { Outcome, ObservedDocument, Verdict } from "./observed-types.ts";
import { WITHHELD, promptTarget } from "./prompt-safe.ts";
import { ROLLUP_OVER, effectChip, effectParts } from "./review.ts";
import type { TestChanges } from "./test-changes-types.ts";
import type { Stop, Tour } from "./tour.ts";

// Page-safe: the walkthrough panel bundles this module, so nothing here may import node:*.

/** One recorded test result, as it is shown at a stop. */
export interface StopTest {
  readonly file: string;
  readonly name: string;
  readonly outcome: Outcome;
  readonly message?: string;
  /** Why the result is attached to the file and not to a test function, when it is. */
  readonly why?: string;
  /** Against the control run: only a regression is the PR's doing. Absent when there is no control run. */
  readonly verdict?: Verdict;
}

/**
 * What was observed at a stop, the fourth column of the walkthrough. "not run" until a run is
 * recorded. A run that did not give results is its state and why. A run that did holds main's
 * results of the tests attached to the stop's modules, the results of tests the PR wrote
 * (claimed), and what the PR did to the stop's tests. With none of them, no test is attached.
 */
export type Observed =
  | { readonly status: "not run"; readonly changes: readonly string[] }
  /** The run is still going: nothing is known yet, and nothing is counted as passing or failing. */
  | { readonly status: "running"; readonly stage: "tests" | "control"; readonly changes: readonly string[] }
  | { readonly status: "refused" | "unsupported" | "stopped" | "failed" | "unreliable"; readonly why: string; readonly unsandboxed: boolean; readonly changes: readonly string[] }
  | {
      readonly status: "ran";
      readonly unsandboxed: boolean;
      /** Why the control run gave no results, so the failures here are the head run's, not known to be the PR's doing. */
      readonly noControl?: string;
      readonly results: readonly StopTest[];
      readonly written: readonly StopTest[];
      /** The PR's own tests covering this stop gave no results: claimed, with why. */
      readonly writtenProblem?: { readonly status: "failed" | "unreliable"; readonly why: string };
      readonly changes: readonly string[];
    };

export const NOT_RUN: Observed = { status: "not run", changes: [] };

const asResult = ({ file, name, outcome, message, why, verdict }: StopTest): StopTest => ({
  file,
  name,
  outcome,
  ...(message ? { message } : {}),
  ...(why ? { why } : {}),
  ...(verdict ? { verdict } : {}),
});

/**
 * What a run recorded at one stop. A test attaches to a stop when its test function is a node of
 * the stop, or inside one (a stop at a test file holds its functions); results no single test
 * function matched attach by file. Nothing is inferred from what a test imports. Tests the PR
 * wrote and what it did to the tests (`changes`, from /test-changes.json) attach by file.
 */
export function observedAt(stop: Stop, graph: Graph, comparison: Comparison, document: ObservedDocument | null, testChanges: TestChanges): Observed {
  const nodes = new Map<NodeId, ModuleNode>(graph.nodes.map((node) => [node.id, node]));
  for (const change of comparison.changes) if (!nodes.has(change.node.id)) nodes.set(change.node.id, change.node);
  const at = new Set(stop.ids);
  const here = (start: NodeId): boolean => {
    for (let id: NodeId | null | undefined = start; id !== null && id !== undefined; id = nodes.get(id)?.parent) if (at.has(id)) return true;
    return false;
  };
  const files = new Set<string>();
  for (const id of stop.ids) {
    const node = nodes.get(id);
    if (node?.level === "file") files.add(node.path);
  }

  const changes: string[] = [];
  for (const file of testChanges.deletedFiles) {
    if (!files.has(file.path) && !(file.movedTo !== undefined && files.has(file.movedTo))) continue;
    const count = `${file.tests} ${file.tests === 1 ? "test" : "tests"}`;
    changes.push(file.movedTo === undefined ? `test file deleted: ${file.path} (${count})` : `test file moved: ${file.path} to ${file.movedTo} (${count})`);
  }
  for (const test of testChanges.removedTests) if (files.has(test.file)) changes.push(`test removed: ${test.name}`);
  for (const test of testChanges.markers) if (files.has(test.file)) changes.push(`${test.name} marked ${test.marker}`);
  for (const test of testChanges.weakened) if (files.has(test.file)) changes.push(`${test.name} weakened: ${test.why}`);

  if (document === null) return { status: "not run", changes };
  if (document.status === "running") return { status: "running", stage: document.stage, changes };
  if (!("sandbox" in document)) return { status: document.status, why: document.why, unsandboxed: false, changes };
  const unsandboxed = document.sandbox === "unsandboxed";
  if (document.status !== "ran") return { status: document.status, why: document.why, unsandboxed, changes };

  const results: StopTest[] = [];
  for (const [id, tests] of Object.entries(document.tests)) {
    if (!here(id as NodeId)) continue;
    const file = nodes.get(id as NodeId)?.path ?? "";
    for (const test of tests) results.push(asResult({ ...test, file }));
  }
  for (const test of document.unmatched) if (files.has(test.file)) results.push(asResult(test));
  const run = document.written;
  const written = run?.status === "ran" ? run.tests.filter((test) => files.has(test.file)).map(asResult) : [];
  const covered = run !== null && run.status !== "ran" && run.files.some((file) => files.has(file));
  return {
    status: "ran",
    unsandboxed,
    ...(document.control.status === "ran" ? {} : { noControl: document.control.why }),
    results,
    written,
    ...(covered ? { writtenProblem: { status: run.status, why: run.why } } : {}),
    changes,
  };
}

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
    const { resource, name, literal } = effectParts(label);
    // The agent was shown only the safe form of the target (a host, a command or a file name), so naming that counts too.
    const shown = literal === undefined ? undefined : promptTarget(resource, literal);
    return names(said, name) || (literal !== undefined && names(said, literal)) || (shown !== undefined && shown !== WITHHELD && (names(said, shown) || names(said, shown.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ""))));
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

/** The footer's short status before the tour starts: the stop count, or why there is none. The diagnostics stay in walkSummary, for "About this run". */
export function walkStatus(note: WalkNote, stops: number): string {
  return note.status === "ok" ? `${stops} ${stops === 1 ? "stop" : "stops"}` : walkSummary(note, stops);
}

/** One line on how much of the change the tour covers. */
export function coverageLine(coverage: { readonly covered: number; readonly changed: number }): string {
  return `The tour covers ${coverage.covered} of ${coverage.changed} changed ${coverage.changed === 1 ? "file" : "files"}.`;
}
