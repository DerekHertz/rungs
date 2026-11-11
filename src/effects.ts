import { argTokens, compareEdges, isCodeNode, targetText } from "./graph.ts";
import type { EffectArg, EffectEdge, Graph, LineRange, NodeId, ResourceKind } from "./graph.ts";

// Page-safe: the review panel bundles this module, so nothing here may import node:*.

/** An effect edge that exists on one side of a comparison only. */
export interface EffectChange {
  readonly kind: "added" | "removed";
  /** As its own graph has it: the head edge for "added", the base edge for "removed". */
  readonly edge: EffectEdge;
}

export const resourceKindOf = (edge: EffectEdge): ResourceKind => edge.to.slice("resource:".length) as ResourceKind;

/** "process child_process execFileSync "git"", "network fetch (target unknown)", "timer setTimeout", "code loaded at run time import() (target unknown)". */
export function effectLabel(edge: EffectEdge): string {
  const head = `${resourceKindOf(edge)} ${edge.operation}`;
  if (edge.target === "none") return head;
  return edge.target === "unknown" ? `${head} (target unknown)` : `${head} ${targetText(edge.target)}`;
}

/**
 * The effect edges that appeared or went away. An edge is the same edge when its owner (a base
 * owner followed through `movedTo`, the pairs compare recorded), resource, operation and target
 * are the same; lines are not part of it, so an edit above shifts nothing. The same edge may
 * occur several times in one owner: they match one to one in source order, and the surplus is
 * added (or removed), the later ones first to count.
 */
export function diffEffects(base: Graph, head: Graph, movedTo: ReadonlyMap<NodeId, NodeId>): EffectChange[] {
  const keyOf = (edge: EffectEdge, owner: NodeId): string =>
    `${owner}\0${edge.to}\0${edge.operation}\0${targetText(edge.target)}`;
  const sequence = (edge: EffectEdge): string => argTokens(edge.args).join("\u0000");
  const before = new Map<string, EffectEdge[]>();
  for (const edge of base.edges) {
    const key = keyOf(edge, movedTo.get(edge.from) ?? edge.from);
    before.set(key, [...(before.get(key) ?? []), edge]);
  }
  const heads = new Map<string, EffectEdge[]>();
  for (const edge of head.edges) heads.set(keyOf(edge, edge.from), [...(heads.get(keyOf(edge, edge.from)) ?? []), edge]);
  const changes: EffectChange[] = [];
  for (const [key, edges] of heads) {
    // Calls with the same arguments pair first, as in changedEffects; the rest pair in source
    // order, and the surplus is added.
    const bases = [...(before.get(key) ?? [])];
    const rest: EffectEdge[] = [];
    for (const edge of edges) {
      const same = bases.findIndex((was) => sequence(was) === sequence(edge));
      if (same === -1) rest.push(edge);
      else bases.splice(same, 1);
    }
    for (const edge of rest.slice(bases.length)) changes.push({ kind: "added", edge });
    for (const edge of bases.slice(rest.length)) changes.push({ kind: "removed", edge });
  }
  for (const [key, edges] of before) {
    if (!heads.has(key)) for (const edge of edges) changes.push({ kind: "removed", edge });
  }
  return changes.sort((a, b) => compareEdges(a.edge, b.edge) || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
}

/**
 * A call that is the same effect on both sides, by owner, resource, operation and target, whose
 * arguments are not. Calls in one owner with the same change collapse into one entry.
 */
export interface ChangedEffect {
  readonly kind: "changed";
  /** The head owner: the class, function or file that holds the calls. */
  readonly owner: NodeId;
  /** "process child_process execFileSync "git"", or "require.resolve" for a resolution. */
  readonly label: string;
  /** Arguments the head has and the base lacks, as `"literal"` or `?expression`; repeats count. */
  readonly added: readonly string[];
  readonly removed: readonly string[];
  /** The calls with this change. */
  readonly count: number;
  /** Their lines in the head file, in source order. */
  readonly ranges: readonly LineRange[];
}

/**
 * What the head's argument list gained and lost against the base's, as sequences: the tokens
 * outside a longest common subsequence. Two lists with the same tokens in another order differ.
 */
function sequenceDiff(was: readonly string[], now: readonly string[]): [string[], string[]] {
  const table = Array.from({ length: was.length + 1 }, () => new Array<number>(now.length + 1).fill(0));
  for (let i = was.length - 1; i >= 0; i--) {
    for (let j = now.length - 1; j >= 0; j--) {
      table[i]![j] = was[i] === now[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const added: string[] = [];
  const removed: string[] = [];
  let i = 0;
  let j = 0;
  while (i < was.length || j < now.length) {
    if (i < was.length && j < now.length && was[i] === now[j]) {
      i++;
      j++;
    } else if (j < now.length && (i === was.length || table[i]![j + 1]! >= table[i + 1]![j]!)) added.push(now[j++]!);
    else removed.push(was[i++]!);
  }
  return [added, removed];
}

/**
 * The effect calls, and the module-resolution calls, that exist on both sides under the same
 * owner (followed through `movedTo`), resource, operation and target but with other arguments.
 * Matching is one to one in source order, as in diffEffects. A resolution has no target, so it
 * pairs on owner and operation alone; one left unpaired is reported with all its arguments as
 * added or removed, since its specifier or base is new or gone. Sorted by owner, then label.
 */
export function changedEffects(base: Graph, head: Graph, movedTo: ReadonlyMap<NodeId, NodeId>): ChangedEffect[] {
  interface Site {
    readonly owner: NodeId;
    readonly key: string;
    readonly label: string;
    readonly args: readonly EffectArg[];
    readonly range: LineRange;
    readonly resolution: boolean;
  }
  const sitesOf = (graph: Graph, ownerOf: (id: NodeId) => NodeId): Site[] => [
    ...graph.edges.map((edge): Site => ({
      owner: ownerOf(edge.from),
      key: `${ownerOf(edge.from)}\0${edge.to}\0${edge.operation}\0${targetText(edge.target)}`,
      label: effectLabel(edge),
      args: edge.args,
      range: edge.range,
      resolution: false,
    })),
    ...graph.resolutions.map((edge): Site => ({
      owner: ownerOf(edge.from),
      key: `${ownerOf(edge.from)}\0resolution\0${edge.operation}`,
      label: edge.operation,
      args: edge.args,
      range: edge.range,
      resolution: true,
    })),
  ];
  const before = new Map<string, Site[]>();
  const sequence = (site: Site): string => argTokens(site.args).join("\u0000");
  for (const site of sitesOf(base, (id) => movedTo.get(id) ?? id)) before.set(site.key, [...(before.get(site.key) ?? []), site]);
  const groups = new Map<string, { owner: NodeId; label: string; added: string[]; removed: string[]; ranges: LineRange[] }>();
  const report = (site: Site, added: string[], removed: string[]): void => {
    if (added.length === 0 && removed.length === 0) return;
    const id = `${site.owner}\0${site.label}\0${added.join("\0")}\0\u0001${removed.join("\0")}`;
    const found = groups.get(id) ?? { owner: site.owner, label: site.label, added, removed, ranges: [] };
    found.ranges.push(site.range);
    groups.set(id, found);
  };
  const now = new Map<string, Site[]>();
  for (const site of sitesOf(head, (id) => id)) now.set(site.key, [...(now.get(site.key) ?? []), site]);
  for (const [key, heads] of now) {
    // Calls with the same arguments pair first, so moving a call within its owner is no change;
    // the rest pair in source order.
    const bases = [...(before.get(key) ?? [])];
    const rest: Site[] = [];
    for (const site of heads) {
      const same = bases.findIndex((was) => sequence(was) === sequence(site));
      if (same === -1) rest.push(site);
      else bases.splice(same, 1);
    }
    rest.forEach((site, index) => {
      const was = bases[index];
      if (was === undefined) {
        if (site.resolution) report(site, argTokens(site.args), []);
        return;
      }
      const [added, removed] = sequenceDiff(argTokens(was.args), argTokens(site.args));
      report(site, added, removed);
    });
    for (const site of bases.slice(rest.length)) if (site.resolution) report(site, [], argTokens(site.args));
  }
  for (const [key, sites] of before) {
    if (!now.has(key)) for (const site of sites) if (site.resolution) report(site, [], argTokens(site.args));
  }
  return [...groups.values()]
    .map((group) => ({ kind: "changed" as const, ...group, count: group.ranges.length, ranges: group.ranges.sort((a, b) => a.start - b.start) }))
    .sort((a, b) => (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0) || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}

/** A token for display: on one line and at most 80 characters. Comparison always uses the whole token. */
export function shortToken(token: string): string {
  const line = token.replace(/\s+/g, " ");
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/** `+"-c" +"core.fsmonitor=" -?base`: what the head's arguments added and removed. */
export const changeText = (change: Pick<ChangedEffect, "added" | "removed">): string =>
  [...change.added.map((token) => `+${shortToken(token)}`), ...change.removed.map((token) => `-${shortToken(token)}`)].join(" ");

/**
 * For each class and function, the labels of the effects of its own calls and of every class or
 * function written inside it, so a closure's call counts for the exported function that holds it.
 * Calls at a file's top level belong to the file and are in no set. Direct calls only: a call
 * through another function's body is not followed until call edges exist.
 */
export function effectSets(graph: Graph): ReadonlyMap<NodeId, ReadonlySet<string>> {
  const parentOf = new Map<NodeId, NodeId>();
  for (const node of graph.nodes) if (isCodeNode(node)) parentOf.set(node.id, node.parent);
  const sets = new Map<NodeId, Set<string>>();
  for (const edge of graph.edges) {
    const label = effectLabel(edge);
    for (let id: NodeId | undefined = edge.from; id !== undefined && parentOf.has(id); id = parentOf.get(id)) {
      const set = sets.get(id) ?? new Set<string>();
      set.add(label);
      sets.set(id, set);
    }
  }
  return sets;
}
