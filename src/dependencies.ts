import { DEPENDENCY_LISTS } from "./graph.ts";
import type { Dependency, DependencyList, Graph, Manifest, NodeId } from "./graph.ts";

/** How a dependency stands in one package.json: the list it is in and the range written there. */
export interface Declaration {
  readonly list: DependencyList;
  /** Null when package.json does not write a string there: the range is not readable. */
  readonly range: string | null;
}

export interface DependencyChange {
  readonly kind: "added" | "removed" | "changed";
  /** The head side's package.json (the base side's, for a removed one). */
  readonly path: string;
  readonly name: string;
  /** Empty for an added dependency. */
  readonly before: readonly Declaration[];
  /** Empty for a removed dependency. */
  readonly after: readonly Declaration[];
}

const declarationsOf = (entries: readonly Dependency[]): Declaration[] =>
  entries
    .map(({ list, range }) => ({ list, range }))
    .sort((a, b) => DEPENDENCY_LISTS.indexOf(a.list) - DEPENDENCY_LISTS.indexOf(b.list));

const sameDeclarations = (a: readonly Declaration[], b: readonly Declaration[]): boolean =>
  a.length === b.length && a.every((one, index) => one.list === b[index]!.list && one.range === b[index]!.range);

const group = (entries: readonly Dependency[]): Map<string, Dependency[]> => {
  const by = new Map<string, Dependency[]>();
  for (const entry of entries) by.set(entry.name, [...(by.get(entry.name) ?? []), entry]);
  return by;
};

/**
 * The dependencies added, removed or changed (its range or its list) between the two graphs'
 * package.json files, from `package.json` alone. A manifest pairs with its base side through
 * `movedTo`, so a moved package.json changes nothing by moving. A manifest that is absent on one
 * side adds or removes all its dependencies; one that is unreadable on either side (not a JSON
 * object) is skipped, since it says nothing about what is declared. A name in two lists is one
 * dependency with both declarations. Sorted by path, then name.
 */
export function diffDependencies(base: Graph, head: Graph, movedTo: ReadonlyMap<NodeId, NodeId>): DependencyChange[] {
  const baseOf = new Map<NodeId, Manifest>();
  for (const manifest of base.manifests) baseOf.set(movedTo.get(manifest.file) ?? manifest.file, manifest);
  const changes: DependencyChange[] = [];
  const paired = new Set<NodeId>();
  for (const manifest of head.manifests) {
    const before = baseOf.get(manifest.file);
    if (before !== undefined) paired.add(manifest.file);
    if (!manifest.readable || (before !== undefined && !before.readable)) continue;
    const was = group(before?.declared ?? []);
    const now = group(manifest.declared);
    for (const name of new Set([...was.keys(), ...now.keys()])) {
      const old = declarationsOf(was.get(name) ?? []);
      const next = declarationsOf(now.get(name) ?? []);
      if (sameDeclarations(old, next)) continue;
      changes.push({ kind: old.length === 0 ? "added" : next.length === 0 ? "removed" : "changed", path: manifest.path, name, before: old, after: next });
    }
  }
  for (const [file, manifest] of baseOf) {
    if (paired.has(file) || !manifest.readable) continue;
    for (const [name, entries] of group(manifest.declared)) changes.push({ kind: "removed", path: manifest.path, name, before: declarationsOf(entries), after: [] });
  }
  return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** One declaration as text, `^1.2.0 (devDependencies)`. */
export const declarationText = (declaration: Declaration): string => `${declaration.range ?? "range not readable"} (${declaration.list})`;
