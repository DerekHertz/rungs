import { contractsMoved } from "./compare.ts";
import type { Comparison, ContractMove } from "./compare.ts";
import { declarationText } from "./dependencies.ts";
import { resourceKindOf } from "./effects.ts";
import { isCodeNode, targetText } from "./graph.ts";
import type { Graph, ModuleNode, NodeId, ResourceKind } from "./graph.ts";
import type { ExportRadius } from "./importance.ts";
import { exportNamesOf, exportRadiusOf } from "./importance.ts";
import { effectParts } from "./review.ts";
import { signatureSummary } from "./signature-change.ts";
import type { TestChanges } from "./test-changes-types.ts";

/*
 * Risks (SPEC, Review): what could break, ranked, all derived. Blast radius is per export for a
 * contract: an import edge records the names it takes, so a changed export's radius is the files
 * that import that name (or all of the file), directly or through re-exports, and the files
 * resting on those (exportRadiusOf). An export whose names are unknown counts every file that
 * rests on its file (importanceOf, the plinth's own relation), so a radius is never undercounted.
 * Effects, tests and moved files are per file.
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
  /** For a changed function signature read exactly: the edit, one line each. Absent when it cannot be read, and the detail is the only account. */
  readonly summary?: readonly string[];
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
  const headRadius = exportRadiusOf(head);
  const baseRadius = exportRadiusOf(base);
  const headNodes = new Map<NodeId, ModuleNode>(head.nodes.map((node) => [node.id, node]));
  const baseNodes = new Map<NodeId, ModuleNode>(base.nodes.map((node) => [node.id, node]));

  /**
   * The files resting on the files at `paths`, by the head's edges, or the base's for a file the
   * head no longer has: on the whole file, or on the exports `of` it names.
   */
  const blastOf = (paths: readonly string[], basePaths: readonly string[] = [], of: readonly string[] | "all" = "all"): Blast => {
    const found = new Set<string>();
    const add = (path: string, radius: ExportRadius, names: ReadonlyMap<NodeId, ModuleNode>): void => {
      const id = `file:${path}` as NodeId;
      if (names.has(id)) for (const rest of radius(id, of)) found.add(names.get(rest)?.path ?? rest);
    };
    for (const path of paths) {
      add(path, headRadius, headNodes);
      // A file the head no longer has at that path keeps the dependents the base gave it.
      if (!headNodes.has(`file:${path}` as NodeId)) add(path, baseRadius, baseNodes);
    }
    // A moved file's old place: the files that rested on it there still do, or are broken by it.
    for (const path of basePaths) add(path, baseRadius, baseNodes);
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
    const was = baseNodes.get(move.from ?? move.id);
    // A block is exported under the names its head and base forms carry. A type's contract name is not an export name when it is a wildcard re-export or `export =` (any importer may use it: all),
    // and a dotted one is either a namespace member (exported as its first segment) or a quoted name with a dot, so both are asked for.
    const of =
      move.exportName !== undefined
        ? [move.exportName]
        : move.type === undefined
        ? exportNamesOf([headNodes.get(move.id), was].filter((found) => found !== undefined))
        : move.type.name.includes("* from") || move.type.name.includes("export=") || [headNodes.get(move.id), baseNodes.get(move.id)].some((file) => file?.level === "file" && file.types?.some((type) => type.name === move.type!.name && type.exportEquals === true))
          ? "all"
          : [...new Set([move.type.name, move.type.name.split(".")[0]!])];
    const summary = move.kind === "changed" && move.type === undefined && isCodeNode(node) && node.level === "function" && move.before !== null && move.after !== null ? signatureSummary(move.before, move.after) : null;
    items.push({ kind: "contract", label: `${name}${move.exportName === undefined ? "" : ` as ${move.exportName}`} ${CONTRACT_WORD[move.kind]}`, detail: contractDetail(move), ...(summary === null ? {} : { summary }), path: node.path, blast: blastOf([node.path], move.from === undefined || was === undefined ? [] : [was.path], of), ids: [move.id] });
  }

  /** Effects by test-ness, new or changed, resource and target: one item each, its radius the union of its holders'. */
  const groups = new Map<string, { demoted: boolean; word: string; resource: ResourceKind; target: string; notes: Set<string>; owners: Set<NodeId>; paths: Set<string> }>();
  const addEffect = (word: string, resource: ResourceKind, target: string, owner: ModuleNode, note: string): void => {
    const demoted = isTest(owner.path) || demotes(fileOf(owner));
    const key = `${demoted}\0${word}\0${resource}\0${target}`;
    const group = groups.get(key) ?? { demoted, word, resource, target, notes: new Set(), owners: new Set(), paths: new Set() };
    group.notes.add(note);
    group.owners.add(owner.id);
    group.paths.add(owner.path);
    groups.set(key, group);
  };
  for (const change of comparison.effects) {
    if (change.kind !== "added") continue;
    const resource = resourceKindOf(change.edge);
    const owner = headNodes.get(change.edge.from);
    if (EFFECT_RESOURCES.has(resource) && owner !== undefined) addEffect("new", resource, targetText(change.edge.target), owner, change.edge.operation);
  }
  for (const change of comparison.changedEffects) {
    const { resource, literal } = effectParts(change.label);
    const owner = headNodes.get(change.owner);
    if (resource === undefined || !EFFECT_RESOURCES.has(resource) || owner === undefined) continue;
    const target = literal !== undefined ? `"${literal}"` : change.label.endsWith("(target unknown)") ? "unknown" : "none";
    const edits = [...change.added.map((token) => `+ ${token}`), ...change.removed.map((token) => `− ${token}`)].join("  ");
    addEffect("changed", resource, target, owner, edits);
  }
  for (const group of groups.values()) {
    const paths = [...group.paths].sort(byText);
    items.push({
      kind: "effect",
      label: `${group.word} ${group.resource} call ${group.target}`,
      ...(group.demoted ? { demoted: true } : {}),
      detail: `${[...group.notes].sort(byText).join("; ")} in ${paths.join(", ")}`,
      path: paths[0]!,
      blast: blastOf(paths),
      ids: [...group.owners].sort(),
    });
  }

  // A file that moved or went away and that the base imported breaks its importers whether or not its contracts changed.
  for (const change of comparison.changes) {
    if (change.node.level !== "file" || (change.kind !== "moved" && change.kind !== "removed")) continue;
    const old = change.kind === "moved" ? change.from : change.node;
    const blast = blastOf([change.node.path], [old.path]);
    if (blast.count === 0) continue;
    const files = `${blast.count} ${blast.count === 1 ? "file" : "files"}`;
    items.push({
      kind: "contract",
      label: change.kind === "moved" ? `${change.node.path} moved from ${old.path}: ${files} ${blast.count === 1 ? "rests" : "rest"} on it` : `${old.path} removed: ${files} rested on it`,
      detail: blast.files.join(", "),
      path: change.node.path,
      blast,
      ids: [change.node.id],
    });
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
