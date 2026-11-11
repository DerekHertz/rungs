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

const isEqual = (a: unknown, b: unknown): boolean => {
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((one, index) => isEqual(one, b[index]));
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => key in b && isEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
  }
  return a === b;
};

const parsedOf = (text: string): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

/** The names whose entry differs in the raw lists, or undefined when a changed entry is not a string on a side that has it. */
const rawChangedNames = (was: Record<string, unknown>, now: Record<string, unknown>): Set<string> | undefined => {
  const names = new Set<string>();
  for (const list of DEPENDENCY_LISTS) {
    const isMap = (value: unknown): boolean => typeof value === "object" && value !== null && !Array.isArray(value);
    if (((was[list] !== undefined && !isMap(was[list])) || (now[list] !== undefined && !isMap(now[list]))) && !isEqual(was[list], now[list])) return undefined;
    const before = typeof was[list] === "object" && was[list] !== null && !Array.isArray(was[list]) ? (was[list] as Record<string, unknown>) : {};
    const after = typeof now[list] === "object" && now[list] !== null && !Array.isArray(now[list]) ? (now[list] as Record<string, unknown>) : {};
    for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (isEqual(before[name], after[name]) && name in before === name in after) continue;
      if ((name in before && typeof before[name] !== "string") || (name in after && typeof after[name] !== "string")) return undefined;
      names.add(name);
    }
  }
  return names;
};

/**
 * Whether two package.json texts differ only inside the four dependency lists, and the dependency
 * diff (`changed`, the names it lists for this file) represents every changed entry: both parse as
 * JSON objects and are deeply equal once those lists are removed (formatting and key order are no
 * change), every changed entry is a string on the sides that have it, and the changed names are
 * exactly `changed`. Anything else, or an unreadable side, means no.
 */
export function onlyDependenciesChanged(before: string, after: string, changed: ReadonlySet<string>): boolean {
  const was = parsedOf(before);
  const now = parsedOf(after);
  if (was === undefined || now === undefined) return false;
  const strip = (value: Record<string, unknown>): object => {
    const rest = { ...value };
    for (const list of DEPENDENCY_LISTS) delete rest[list];
    return rest;
  };
  if (!isEqual(strip(was), strip(now))) return false;
  const names = rawChangedNames(was, now);
  return names !== undefined && names.size === changed.size && [...names].every((name) => changed.has(name));
}
