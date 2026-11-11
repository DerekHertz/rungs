import { contractsMoved } from "./compare.ts";
import type { Comparison, ContractMove } from "./compare.ts";
import { declarationText } from "./dependencies.ts";
import { resourceKindOf } from "./effects.ts";
import { isCodeNode, targetText } from "./graph.ts";
import type { Graph, ModuleNode, NodeId, ResourceKind } from "./graph.ts";
import { importanceOf } from "./importance.ts";
import { effectParts } from "./review.ts";
import type { TestChanges } from "./test-changes-types.ts";

/*
 * Risks (SPEC, Review): what could break, ranked, all derived. Blast radius is per FILE, not per
 * export: an import edge in the graph names the file imported, not which of its exports the
 * importer uses, so a contract's radius is the files resting on its file (importanceOf, the
 * plinth's own relation). Every export of one file therefore shares one radius.
 */

export type RiskKind = "contract" | "effect" | "test" | "dependency";

/** The order the kinds are listed in. */
export const RISK_KINDS: readonly RiskKind[] = ["contract", "effect", "test", "dependency"];

export interface Blast {
  readonly count: number;
  /** The paths of the files that rest on the file, sorted. */
  readonly files: readonly string[];
}

export interface RiskItem {
  readonly kind: RiskKind;
  /** One line. */
  readonly label: string;
  /** Shown when selected. */
  readonly detail: string;
  /** The file the item is about; sorts after blast radius. */
  readonly path: string;
  readonly blast: Blast;
  /** Calls in test or generated files: kept, but ranked after the rest of their kind. */
  readonly demoted?: boolean;
  /** The places the item selects. */
  readonly ids: readonly NodeId[];
}

const EFFECT_RESOURCES: ReadonlySet<ResourceKind> = new Set(["process", "file system", "network"]);

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const CONTRACT_WORD: Record<Exclude<ContractMove["kind"], "added">, string> = {
  changed: "signature changed",
  effects: "effects changed",
  removed: "removed",
  unexported: "no longer exported",
  exposed: "newly exported",
  moved: "moved",
};

function contractDetail(move: ContractMove): string {
  const parts = [move.before === null ? "" : `before: ${move.before}`, move.after === null ? "" : `after: ${move.after}`];
  if (move.effects !== undefined) parts.push(...move.effects.added.map((label) => `+ ${label}`), ...move.effects.removed.map((label) => `− ${label}`));
  return parts.filter((part) => part !== "").join("\n");
}

/**
 * The ranked risks of a comparison: contracts moved (an export that is only added is not one:
 * nothing rests on it yet), new or changed effects reaching a process, the file system or the
 * network, tests weakened, removed, skipped or edited, and dependency changes, in that order.
 * Within a kind, larger blast radius first, then path, then label. `head` and `base` are the two
 * graphs `comparison` was made from; `isTest` is the test-file predicate the test run uses (isTestFile),
 * passed in so this module stays free of node:*.
 */
export function risksOf(comparison: Comparison, base: Graph, head: Graph, tests: TestChanges, isTest: (path: string) => boolean): RiskItem[] {
  const headRests = importanceOf(head);
  const baseRests = importanceOf(base);
  const headNodes = new Map<NodeId, ModuleNode>(head.nodes.map((node) => [node.id, node]));
  const baseNodes = new Map<NodeId, ModuleNode>(base.nodes.map((node) => [node.id, node]));

  /** The files resting on the files at `paths`, by the head's edges, or the base's for a file the head no longer has. */
  const blastOf = (paths: readonly string[], basePaths: readonly string[] = []): Blast => {
    const found = new Set<string>();
    const add = (path: string, rests: ReadonlyMap<NodeId, readonly NodeId[]>, names: ReadonlyMap<NodeId, ModuleNode>): void => {
      const id = `file:${path}` as NodeId;
      if (names.has(id)) for (const rest of rests.get(id) ?? []) found.add(names.get(rest)?.path ?? rest);
    };
    for (const path of paths) {
      add(path, headRests, headNodes);
      // A file the head no longer has at that path keeps the dependents the base gave it.
      if (!headNodes.has(`file:${path}` as NodeId)) add(path, baseRests, baseNodes);
    }
    // A moved file's old place: the files that rested on it there still do, or are broken by it.
    for (const path of basePaths) add(path, baseRests, baseNodes);
    const files = [...found].sort(byText);
    return { count: files.length, files };
  };
  const fileOf = (owner: ModuleNode | undefined): ModuleNode | undefined => (owner === undefined ? undefined : headNodes.get(`file:${owner.path}` as NodeId));
  const demotes = (file: ModuleNode | undefined): boolean => file?.level === "file" && (file.role === "tests" || file.role === "generated");

  const items: RiskItem[] = [];

  for (const move of contractsMoved(comparison, base, head)) {
    if (move.kind === "added") continue;
    const node = headNodes.get(move.id) ?? baseNodes.get(move.id);
    if (node === undefined) continue;
    const name = move.type?.name ?? (isCodeNode(node) ? node.qualifiedName : node.path);
    const was = move.from === undefined ? undefined : baseNodes.get(move.from);
    items.push({ kind: "contract", label: `${name} ${CONTRACT_WORD[move.kind]}`, detail: contractDetail(move), path: node.path, blast: blastOf([node.path], was === undefined ? [] : [was.path]), ids: [move.id] });
  }

  const groups = new Map<string, { demoted: boolean; resource: ResourceKind; target: string; operations: Set<string>; owners: Set<NodeId>; paths: Set<string> }>();
  for (const change of comparison.effects) {
    if (change.kind !== "added") continue;
    const resource = resourceKindOf(change.edge);
    const owner = headNodes.get(change.edge.from);
    if (!EFFECT_RESOURCES.has(resource) || owner === undefined) continue;
    const demoted = demotes(fileOf(owner));
    const target = targetText(change.edge.target);
    const key = `${demoted}\0${resource}\0${target}`;
    const group = groups.get(key) ?? { demoted, resource, target, operations: new Set(), owners: new Set(), paths: new Set() };
    group.operations.add(change.edge.operation);
    group.owners.add(owner.id);
    group.paths.add(owner.path);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const paths = [...group.paths].sort(byText);
    items.push({
      kind: "effect",
      label: `new ${group.resource} call ${group.target}`,
      ...(group.demoted ? { demoted: true } : {}),
      detail: `${[...group.operations].sort(byText).join(", ")} in ${paths.join(", ")}`,
      path: paths[0]!,
      blast: blastOf(paths),
      ids: [...group.owners].sort(),
    });
  }
  for (const change of comparison.changedEffects) {
    const resource = effectParts(change.label).resource;
    const owner = headNodes.get(change.owner);
    if (resource === undefined || !EFFECT_RESOURCES.has(resource) || owner === undefined) continue;
    const edits = [...change.added.map((token) => `+ ${token}`), ...change.removed.map((token) => `− ${token}`)].join("  ");
    items.push({ kind: "effect", label: `changed ${change.label}`, detail: `${edits} in ${owner.path}`, path: owner.path, blast: blastOf([owner.path]), ...(demotes(fileOf(owner)) ? { demoted: true } : {}), ids: [owner.id] });
  }

  const testItem = (path: string, label: string, detail: string): RiskItem => ({ kind: "test", label, detail, path, blast: blastOf([path]), ids: [`file:${path}` as NodeId] });
  for (const file of tests.deletedFiles) {
    items.push(testItem(file.path, `${file.path} no longer runs`, file.movedTo === undefined ? `test file deleted; ${file.tests} tests` : `removed from the test run, now ${file.movedTo}; ${file.tests} tests`));
  }
  for (const test of tests.removedTests) items.push(testItem(test.file, `${test.name} removed`, `test removed by name in ${test.file}`));
  for (const mark of tests.markers) items.push(testItem(mark.file, `${mark.name} now ${mark.marker}`, `${mark.marker} added in ${mark.file}`));
  for (const test of tests.weakened) items.push(testItem(test.file, `${test.name} weakened`, `${test.why} in ${test.file}`));
  for (const change of comparison.changes) {
    if (change.kind !== "altered" || change.node.level !== "file" || !isTest(change.node.path)) continue;
    items.push(testItem(change.node.path, `${change.node.path} edited`, "a test file the base had was edited"));
  }

  for (const change of comparison.dependencies) {
    const now = change.after.map(declarationText).join(", ");
    const was = change.before.map(declarationText).join(", ");
    items.push({
      kind: "dependency",
      label: `${change.name} ${change.kind}`,
      detail: change.kind === "added" ? `${now} in ${change.path}` : change.kind === "removed" ? `was ${was} in ${change.path}` : `${was} → ${now} in ${change.path}`,
      path: change.path,
      blast: { count: 0, files: [] },
      ids: [`file:${change.path}` as NodeId],
    });
  }

  return items.sort(
    (a, b) => RISK_KINDS.indexOf(a.kind) - RISK_KINDS.indexOf(b.kind) || Number(a.demoted === true) - Number(b.demoted === true) || b.blast.count - a.blast.count || byText(a.path, b.path) || byText(a.label, b.label),
  );
}
