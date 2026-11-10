import { canonicalNode, compareIds, isCodeNode, nodeId } from "./graph.ts";
import type { CodeNode, ContainerNode, FileNode, Graph, ModuleNode, NodeId } from "./graph.ts";

export type ChangeKind = "added" | "altered" | "removed" | "moved";

type Body = FileNode | CodeNode;

export type ModuleChange =
  /** Head only and unpaired. A package or folder is added when its path is new. */
  | { readonly kind: "added"; readonly node: ModuleNode }
  /** Base only and unpaired, exactly as the base graph has it. A package or folder is removed
   *  when its path is gone. */
  | { readonly kind: "removed"; readonly node: ModuleNode }
  /** The same id on both sides with a different digest. Containers are never altered. */
  | { readonly kind: "altered"; readonly node: Body; readonly before: Body }
  /** Different ids, identical digest, paired by the rules on `compare`. `node` is the head side. */
  | { readonly kind: "moved"; readonly node: Body; readonly from: Body };

export interface Comparison {
  readonly extractorVersion: string;
  /** Sorted by node.id, at most one entry per id. An unchanged module has no entry. */
  readonly changes: readonly ModuleChange[];
}

export class ExtractorVersionMismatch extends Error {
  readonly base: string;
  readonly head: string;
  constructor(base: string, head: string) {
    super(`graphs from extractor ${base} and ${head} can't be compared`);
    this.name = "ExtractorVersionMismatch";
    this.base = base;
    this.head = head;
  }
}

const isBody = (node: ModuleNode): node is Body => node.level !== "package" && node.level !== "folder";

/**
 * What changed from `base` to `head`. Throws ExtractorVersionMismatch before reading a node.
 *
 * Nodes pair by id first: the same id with another digest is altered. A move is only ever a
 * pairing recorded here, never a new id, and only an identical body pairs:
 *
 * - Files unpaired on both sides group by digest. A digest held by exactly one removed and one
 *   added file pairs them. When the pair pairs, its code nodes pair by qualified name.
 * - Code nodes still unpaired group by level and digest, and pair by the same one-to-one rule,
 *   so a class never pairs with a function. The descendants of a pair pair by the rest of their
 *   qualified name.
 * - Packages and folders pair by path, so a folder that gains a package.json is no change, and
 *   are never altered. A path only in head is added, a path only in base is removed.
 */
export function compare(base: Graph, head: Graph): Comparison {
  if (base.extractorVersion !== head.extractorVersion) {
    throw new ExtractorVersionMismatch(base.extractorVersion, head.extractorVersion);
  }
  const changes: ModuleChange[] = [];
  const baseBodies = new Map<NodeId, Body>();
  const headBodies = new Map<NodeId, Body>();
  const baseChildren = new Map<NodeId, CodeNode[]>();
  const baseDirs = new Set<string>();
  const headDirs = new Set<string>();
  for (const node of base.nodes) {
    if (!isBody(node)) baseDirs.add(node.path);
    else {
      baseBodies.set(node.id, node);
      if (isCodeNode(node)) baseChildren.set(node.parent, [...(baseChildren.get(node.parent) ?? []), node]);
    }
  }
  for (const node of head.nodes) {
    if (!isBody(node)) headDirs.add(node.path);
    else headBodies.set(node.id, node);
  }

  const paired = new Set<NodeId>();
  const pair = (from: Body, node: Body): void => {
    paired.add(from.id);
    paired.add(node.id);
    changes.push({ kind: "moved", node, from });
  };
  const unpaired = (bodies: ReadonlyMap<NodeId, Body>, others: ReadonlyMap<NodeId, Body>): Body[] =>
    [...bodies.values()].filter((node) => !others.has(node.id) && !paired.has(node.id));

  const pairDescendants = (from: Body, node: Body): void => {
    const fromPrefix = isCodeNode(from) ? from.qualifiedName : "";
    const nodePrefix = isCodeNode(node) ? node.qualifiedName : "";
    for (const child of baseChildren.get(from.id) ?? []) {
      const name = nodePrefix + child.qualifiedName.slice(fromPrefix.length);
      const counterpart = headBodies.get(nodeId(child.level, node.path, name));
      if (
        counterpart === undefined ||
        baseBodies.has(counterpart.id) ||
        headBodies.has(child.id) ||
        paired.has(child.id) ||
        paired.has(counterpart.id) ||
        counterpart.digest !== child.digest
      ) {
        continue;
      }
      pair(child, counterpart);
      pairDescendants(child, counterpart);
    }
  };

  for (const node of headBodies.values()) {
    const before = baseBodies.get(node.id);
    if (before !== undefined && before.digest !== node.digest) changes.push({ kind: "altered", node, before });
  }

  /** Pairs each one-to-one group and reports whether anything paired. */
  const pairUniques = (removed: readonly Body[], added: readonly Body[], keyOf: (node: Body) => string): boolean => {
    let any = false;
    const groups = new Map<string, { removed: Body[]; added: Body[] }>();
    const group = (key: string) => {
      const found = groups.get(key) ?? { removed: [], added: [] };
      groups.set(key, found);
      return found;
    };
    for (const node of removed) group(keyOf(node)).removed.push(node);
    for (const node of added) group(keyOf(node)).added.push(node);
    for (const { removed: from, added: to } of groups.values()) {
      const [one] = from;
      const [other] = to;
      if (from.length !== 1 || to.length !== 1 || one === undefined || other === undefined) continue;
      if (paired.has(one.id) || paired.has(other.id)) continue;
      pair(one, other);
      pairDescendants(one, other);
      any = true;
    }
    return any;
  };
  const files = (nodes: Body[]) => nodes.filter((node) => node.level === "file");
  const code = (nodes: Body[]) => nodes.filter(isCodeNode);
  const baseOnly = () => unpaired(baseBodies, headBodies);
  const headOnly = () => unpaired(headBodies, baseBodies);
  pairUniques(files(baseOnly()), files(headOnly()), (node) => node.digest);
  // A pair's descendants pair with it, which can leave another group one-to-one, so regroup
  // until nothing pairs.
  while (pairUniques(code(baseOnly()), code(headOnly()), (node) => `${node.level} ${node.digest}`));

  for (const node of baseOnly()) changes.push({ kind: "removed", node });
  for (const node of headOnly()) changes.push({ kind: "added", node });
  for (const node of base.nodes) {
    if (!isBody(node) && !headDirs.has(node.path)) changes.push({ kind: "removed", node });
  }
  for (const node of head.nodes) {
    if (!isBody(node) && !baseDirs.has(node.path)) changes.push({ kind: "added", node });
  }
  changes.sort((a, b) => compareIds(a.node.id, b.node.id));
  return { extractorVersion: head.extractorVersion, changes };
}

/** Per-kind counts of changed files. */
export interface Tally {
  readonly added: number;
  readonly altered: number;
  readonly removed: number;
  readonly moved: number;
}

/**
 * For each package and folder of `head`, the files changed below it, by kind, for its name pill.
 * A moved file counts where it landed. A removed file counts in each directory it stood in that
 * `head` still has, and one whose directories are all gone counts nowhere but the ones above.
 * Containers with nothing changed below are left out. Classes and functions are never counted.
 */
export function tally(comparison: Comparison, head: Graph): ReadonlyMap<NodeId, Tally> {
  const containerAt = new Map<string, NodeId>();
  for (const node of head.nodes) {
    if (!isBody(node)) containerAt.set(node.path, node.id);
  }
  const counts = new Map<NodeId, { added: number; altered: number; removed: number; moved: number }>();
  for (const change of comparison.changes) {
    if (change.node.level !== "file") continue;
    for (let dir = change.node.path; dir !== ""; ) {
      dir = dir.slice(0, Math.max(0, dir.lastIndexOf("/")));
      const id = containerAt.get(dir);
      if (id === undefined) continue;
      const count = counts.get(id) ?? { added: 0, altered: 0, removed: 0, moved: 0 };
      count[change.kind] += 1;
      counts.set(id, count);
    }
  }
  return new Map([...counts].sort(([a], [b]) => compareIds(a, b)));
}

/** Canonical JSON, nodes through canonicalNode, for comparison.json and the golden. */
export function serializeComparison(comparison: Comparison): string {
  const changes = comparison.changes.map((change) => {
    switch (change.kind) {
      case "added":
      case "removed":
        return { kind: change.kind, node: canonicalNode(change.node) };
      case "altered":
        return { kind: change.kind, node: canonicalNode(change.node), before: canonicalNode(change.before) };
      case "moved":
        return { kind: change.kind, node: canonicalNode(change.node), from: canonicalNode(change.from) };
    }
  });
  return `${JSON.stringify({ extractorVersion: comparison.extractorVersion, changes }, null, 2)}\n`;
}

export type Change = ChangeKind | "unchanged";

const NO_CHANGES: Tally = { added: 0, altered: 0, removed: 0, moved: 0 };

export interface Overlay {
  /** "unchanged" for an id with no entry. */
  change(id: NodeId): Change;
  entry(id: NodeId): ModuleChange | undefined;
  /**
   * A package or folder, a ghost one included, counts the changed files below it. A file counts
   * its changed classes and functions, the removed ones that are not in the picture's graph
   * included. Zeros for anything else, and for what has not changed.
   */
  tally(id: NodeId): Tally;
}

export interface Picture {
  /**
   * What is laid out: the head graph, and under a comparison the ghosts after it. A ghost is a
   * removed file, its classes and functions that were removed with it, and a removed package or
   * folder, all as the base graph had them but standing in the head's directory at their path, or
   * in a ghost one. A function removed from a file that stays is in the comparison, not here.
   */
  readonly graph: Graph;
  readonly overlay: Overlay | null;
}

const directoryOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")));

function ancestorsOf(path: string): string[] {
  const dirs: string[] = [];
  for (let dir = directoryOf(path); dir !== ""; dir = directoryOf(dir)) dirs.push(dir);
  return dirs;
}

/** `pictureOf(head, null)` is the plain picture. It lays nothing out; city.ts does. */
export function pictureOf(head: Graph, comparison: Comparison | null): Picture {
  if (comparison === null) return { graph: head, overlay: null };

  const entries = new Map<NodeId, ModuleChange>(comparison.changes.map((change) => [change.node.id, change]));
  const removed = (level: (node: ModuleNode) => boolean): ModuleNode[] =>
    comparison.changes.flatMap((change) => (change.kind === "removed" && level(change.node) ? [change.node] : []));

  const removedFiles = removed((node) => node.level === "file");
  const removedPaths = new Set(removedFiles.map((node) => node.path));
  const removedDirectories = new Map<string, ModuleNode>();
  for (const node of removed((n) => !isBody(n))) removedDirectories.set(node.path, node);
  // Only a directory that a removed file stood in is drawn. One whose files all moved is not.
  const ghostContainers: ModuleNode[] = [];
  for (const dir of new Set(removedFiles.flatMap((file) => ancestorsOf(file.path)))) {
    const node = removedDirectories.get(dir);
    if (node !== undefined) ghostContainers.push(node);
  }
  ghostContainers.sort((a, b) => a.path.length - b.path.length);

  const directoryAt = new Map<string, NodeId>();
  for (const node of head.nodes) if (!isBody(node)) directoryAt.set(node.path, node.id);
  for (const node of ghostContainers) directoryAt.set(node.path, node.id);
  const standIn = (path: string): NodeId => {
    for (let dir = directoryOf(path); ; dir = directoryOf(dir)) {
      const found = directoryAt.get(dir);
      if (found !== undefined) return found;
      if (dir === "") throw new Error(`no directory to stand ${path} in`);
    }
  };

  const ghosts: ModuleNode[] = [];
  const present = new Set<NodeId>(head.nodes.map((node) => node.id));
  for (const node of ghostContainers) {
    ghosts.push({ ...(node as ContainerNode), parent: standIn(node.path) });
    present.add(node.id);
  }
  for (const node of removedFiles) {
    ghosts.push({ ...(node as FileNode), parent: standIn(node.path) });
    present.add(node.id);
  }
  // A removed file's code is removed, or moved away: a move's `from` is the base node.
  const pending = comparison.changes.flatMap((change): CodeNode[] => {
    const base = change.kind === "removed" ? change.node : change.kind === "moved" ? change.from : undefined;
    return base !== undefined && isCodeNode(base) && removedPaths.has(base.path) ? [base] : [];
  });
  for (let progress = true; progress; ) {
    progress = false;
    for (const node of pending) {
      if (present.has(node.id) || !present.has(node.parent)) continue;
      ghosts.push(node);
      present.add(node.id);
      progress = true;
    }
  }
  const graph: Graph = { ...head, nodes: [...head.nodes, ...ghosts] };

  const directories = tally(comparison, graph);
  const codeTallies = new Map<string, { added: number; altered: number; removed: number; moved: number }>();
  for (const change of comparison.changes) {
    if (!isCodeNode(change.node)) continue;
    const count = codeTallies.get(change.node.path) ?? { added: 0, altered: 0, removed: 0, moved: 0 };
    count[change.kind] += 1;
    codeTallies.set(change.node.path, count);
  }
  const overlay: Overlay = {
    change: (id) => entries.get(id)?.kind ?? "unchanged",
    entry: (id) => entries.get(id),
    tally(id) {
      const found = directories.get(id);
      if (found !== undefined) return found;
      return id.startsWith("file:") ? (codeTallies.get(id.slice("file:".length)) ?? NO_CHANGES) : NO_CHANGES;
    },
  };
  return { graph, overlay };
}

/** A district's changed files for its name pill: `+3 ~5 −1 →2`, nothing for a kind with no files. */
export function tallyText(counts: Tally): string {
  const parts: [string, number][] = [["+", counts.added], ["~", counts.altered], ["−", counts.removed], ["→", counts.moved]];
  return parts.flatMap(([mark, count]) => (count > 0 ? [`${mark}${count}`] : [])).join(" ");
}
