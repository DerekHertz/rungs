import { RESOURCE_ORDER, isCodeNode, lineCount, targetText } from "./graph.ts";
import type { CodeLevel, EffectTarget, Graph, LineRange, ModuleNode, NodeId, ResourceKind } from "./graph.ts";
import { resourceKindOf } from "./effects.ts";
import type { ChangeKind, Comparison, ContractMove, ContractMoveKind, ModuleChange, Tally } from "./compare.ts";

/** Most urgent first: a removed or altered module changed what already stood, a moved one is the same text. */
const URGENCY: Record<ChangeKind, number> = { removed: 0, altered: 1, added: 2, moved: 3 };

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * How a needle is looked for in a description, case-sensitively:
 *
 * - `path`: the whole path, not preceded by a path character and not continuing into a longer
 *   path or file name (`src/a.ts` is not in `lib/src/a.ts`, `src/a.ts.map` or `src/a.tsx`).
 * - `file`: a base name with its extension, preceded by a slash or a non-name character, not
 *   continuing into a longer name.
 * - `name`: a class or function name on identifier boundaries, a qualified name whole.
 */
export function appears(description: string, kind: "path" | "file" | "name", needle: string): boolean {
  // Nothing, or only white space, names nothing.
  if (needle.trim() === "") return false;
  const body = escape(needle);
  // Everything that can continue a JavaScript identifier, joiners included.
  const word = "\\p{ID_Continue}\\u200C\\u200D_";
  const pattern =
    kind === "path"
      ? `(?<![${word}./-])${body}(?![${word}/-]|\\.[${word}])`
      : kind === "file"
        ? `(?<![${word}.-])${body}(?![${word}/-]|\\.[${word}])`
        : `(?<![${word}$])${body}(?![${word}$])`;
  return new RegExp(pattern, "u").test(description);
}

interface EntryBase {
  readonly id: NodeId;
  /** A path for a file or district, the qualified name for a class or function. */
  readonly label: string;
  readonly lines: number;
  readonly children: readonly ReviewEntry[];
}

export type ReviewEntry =
  | (EntryBase & {
      readonly level: "file" | "class" | "function";
      readonly change: ChangeKind;
      readonly from?: string;
      /** An agent linked a claim to this very module, not only to something in its file. */
      readonly linked?: true;
    })
  /** A folder or package whose changed files are all unmentioned, rolled up. `children` are its files. */
  | (EntryBase & { readonly level: "district"; readonly files: number; readonly kinds: Tally });

export interface Unmentioned {
  /** Every changed file, mentioned or not. */
  readonly changedFiles: number;
  /** Files whose path or name the description never gives, linked by an agent or not. */
  readonly unmentionedFiles: number;
  /** Of those, the files an agent linked a claim to. */
  readonly linkedFiles: number;
  /** "No claim covers it": neither mentioned nor linked. */
  readonly entries: readonly ReviewEntry[];
  /** "Linked by the agent only": not mentioned, but an agent linked a claim to the file or to code in it. A claimed fact. */
  readonly linkedEntries: readonly ReviewEntry[];
}

type Kinds = { -readonly [K in ChangeKind]: number };

/** The path a change stood at on each side: its own, and a moved module's old one. */
const pathsOf = (change: ModuleChange): string[] =>
  change.kind === "moved" ? [change.node.path, change.from.path] : [change.node.path];

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
const directoryOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")));

function sizeOf(node: ModuleNode): number {
  return lineCount(node);
}

function bySeverity(a: ReviewEntry, b: ReviewEntry): number {
  const rank = (entry: ReviewEntry): number =>
    entry.level === "district"
      ? Math.min(...(["removed", "altered", "added", "moved"] as const).filter((kind) => entry.kinds[kind] > 0).map((kind) => URGENCY[kind]))
      : URGENCY[entry.change];
  return rank(a) - rank(b) || b.lines - a.lines || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0);
}

/**
 * What "mentioned" means for one comparison and description: a file by its path (or its base
 * name when no other changed file shares it, a moved file under its old path too), a class or
 * function by its qualified name or an enclosing name.
 */
function mentionRules(comparison: Comparison, description: string) {
  const shared = new Map<string, number>();
  for (const change of comparison.changes) {
    if (change.node.level !== "file") continue;
    for (const name of new Set(pathsOf(change).map(baseName))) shared.set(name, (shared.get(name) ?? 0) + 1);
  }
  const pathMentioned = (path: string): boolean =>
    appears(description, "path", path) || (shared.get(baseName(path)) === 1 && appears(description, "file", baseName(path)));
  return {
    pathMentioned,
    fileMentioned: (change: ModuleChange): boolean => pathsOf(change).some(pathMentioned),
    nameCovered(qualifiedName: string): boolean {
      const parts = qualifiedName.split(".");
      return parts.some((_, index) => appears(description, "name", parts.slice(0, index + 1).join(".")));
    },
  };
}

/**
 * The changed files, and the classes and functions under them, that no claim covers, rolled up.
 *
 * A file is mentioned when its path appears in `description`, or its base name does and no other
 * changed file has that base name; a moved file counts under its old path too. A class or
 * function is mentioned when its file is, or when its qualified name or one of its enclosing
 * names appears. Folders and packages are never listed for their own change, only as a roll-up.
 *
 * Unmentioned files are listed with their unmentioned classes and functions under them. A folder
 * below the repository root, with a node in `graph`, whose changed files are two or more and all
 * unmentioned, is listed once in place of them, at the highest such folder. Entries sort by
 * urgency (removed, altered, added, moved; a district by its most urgent file), then by lines,
 * largest first, then by label. `graph` is the picture's graph, so a ghost folder is reachable.
 *
 * `linked` holds the ids an agent linked to a claim. A link never removes a change from view and
 * never beats a mention: an unmentioned file moves from `entries` to `linkedEntries` when it, or
 * code in it, is linked, and the linked code is marked in its children. Each list rolls up on its
 * own, so a folder rolls up only when every changed file in it is in that list.
 */
export function unmentioned(
  comparison: Comparison,
  graph: Graph,
  description: string,
  linked: ReadonlySet<NodeId> = new Set(),
): Unmentioned {
  const fileChanges = comparison.changes.filter((change) => change.node.level === "file");
  const { pathMentioned, fileMentioned, nameCovered } = mentionRules(comparison, description);

  const codeBy = new Map<string, ReviewEntry[]>();
  for (const change of comparison.changes) {
    const node = change.node;
    if (!isCodeNode(node) || pathsOf(change).some(pathMentioned)) continue;
    if (nameCovered(node.qualifiedName)) continue;
    const entry: ReviewEntry = { id: node.id, level: node.level, label: node.qualifiedName, change: change.kind, lines: sizeOf(node), children: [] };
    codeBy.set(node.path, [...(codeBy.get(node.path) ?? []), entry]);
  }

  const linkedPaths = new Set<string>();
  for (const change of comparison.changes) if (isCodeNode(change.node) && linked.has(change.node.id)) linkedPaths.add(change.node.path);

  const dirsChanged = new Map<string, number>();
  const none: ReviewEntry[] = [];
  const byAgent: ReviewEntry[] = [];
  for (const change of fileChanges) {
    const node = change.node;
    for (let dir = directoryOf(node.path); dir !== ""; dir = directoryOf(dir)) dirsChanged.set(dir, (dirsChanged.get(dir) ?? 0) + 1);
    if (fileMentioned(change)) continue;
    const agent = linked.has(node.id) || linkedPaths.has(node.path);
    const children = (codeBy.get(node.path) ?? [])
      .map((child): ReviewEntry => (linked.has(child.id) && child.level !== "district" ? { ...child, linked: true } : child))
      .sort(bySeverity);
    const entry: ReviewEntry = {
      id: node.id,
      level: "file",
      label: node.path,
      change: change.kind,
      lines: sizeOf(node),
      children,
      ...(change.kind === "moved" ? { from: change.from.path } : {}),
    };
    (agent ? byAgent : none).push(entry);
  }

  const containerAt = new Map<string, NodeId>();
  for (const node of graph.nodes) if (node.level === "package" || node.level === "folder") containerAt.set(node.path, node.id);

  /** A folder rolls up in a list when two or more of its changed files are in it and no changed file of the folder is elsewhere. */
  function rollUp(files: readonly ReviewEntry[]): ReviewEntry[] {
    const inList = new Map<string, number>();
    const filesIn = new Map<string, ReviewEntry[]>();
    for (const file of files) {
      for (let dir = directoryOf(file.label); dir !== ""; dir = directoryOf(dir)) {
        inList.set(dir, (inList.get(dir) ?? 0) + 1);
        filesIn.set(dir, [...(filesIn.get(dir) ?? []), file]);
      }
    }
    const rolls = (dir: string): boolean => containerAt.has(dir) && (inList.get(dir) ?? 0) >= 2 && inList.get(dir) === dirsChanged.get(dir);
    const topOf = (path: string): string | undefined => {
      let top: string | undefined;
      for (let dir = directoryOf(path); dir !== ""; dir = directoryOf(dir)) if (rolls(dir)) top = dir;
      return top;
    };

    const districts = new Map<string, ReviewEntry>();
    const entries: ReviewEntry[] = [];
    for (const file of files) {
      const top = topOf(file.label);
      if (top === undefined) {
        entries.push(file);
        continue;
      }
      if (districts.has(top)) continue;
      const inside = (filesIn.get(top) ?? []).slice().sort(bySeverity);
      const kinds: Kinds = { added: 0, altered: 0, removed: 0, moved: 0 };
      for (const entry of inside) if (entry.level === "file") kinds[entry.change] += 1;
      const district: ReviewEntry = {
        id: containerAt.get(top)!,
        level: "district",
        label: top,
        files: inside.length,
        kinds,
        lines: inside.reduce((sum, entry) => sum + entry.lines, 0),
        children: inside,
      };
      districts.set(top, district);
      entries.push(district);
    }
    return entries.sort(bySeverity);
  }

  return {
    changedFiles: fileChanges.length,
    unmentionedFiles: none.length + byAgent.length,
    linkedFiles: byAgent.length,
    entries: rollUp(none),
    linkedEntries: rollUp(byAgent),
  };
}

/** The ids of every entry of `result`, nested ones included: the changes no claim covers. */
export function unmentionedIds(result: Unmentioned): Set<NodeId> {
  const ids = new Set<NodeId>();
  const visit = (entries: readonly ReviewEntry[]): void => {
    for (const entry of entries) {
      ids.add(entry.id);
      visit(entry.children);
    }
  };
  visit(result.entries);
  return ids;
}

export interface ContractRow {
  readonly kind: "row";
  readonly move: ContractMove;
  readonly id: NodeId;
  readonly label: string;
  /** Where it stands now; where it stood for a removed one. */
  readonly path: string;
  readonly level: CodeLevel;
  /** No claim covers the change to this node. */
  readonly unmentioned: boolean;
}

/** Many added or moved exports of one file, kept to one row so the changed ones stay on screen. */
export interface ContractRollup {
  readonly kind: "rollup";
  readonly moveKind: "added" | "moved";
  readonly path: string;
  readonly fileId: NodeId;
  readonly rows: readonly ContractRow[];
  readonly unmentioned: number;
}

export interface ContractsReport {
  readonly counts: Readonly<Record<ContractMoveKind, number>>;
  readonly entries: readonly (ContractRow | ContractRollup)[];
}

/** A file with more added (or moved) exports than this gets one rollup row. */
export const ROLLUP_OVER = 3;

/** Changed first, since only a changed signature can break a caller; then what went; then what appeared. */
const CONTRACT_ORDER: readonly ContractMoveKind[] = ["changed", "effects", "removed", "unexported", "exposed", "moved", "added"];

/**
 * The contracts that moved as rows to show, in the order a reviewer must read them: changed,
 * effects, removed, unexported, exposed, moved, added. Within a kind, by id, with a file's rollup after
 * the single rows of its kind. Only added and moved exports roll up, since a new or relocated
 * file can bring hundreds; a changed, removed, unexported or exposed export is always its own row.
 */
export function contractsReport(
  comparison: Comparison,
  moves: readonly ContractMove[],
  unmentionedSet: ReadonlySet<NodeId>,
  graph: Graph,
): ContractsReport {
  // An effects move can be for a node whose text did not change, so it has no change to read.
  const nodeOf = new Map<NodeId, ModuleNode>(graph.nodes.map((node) => [node.id, node]));
  for (const change of comparison.changes) nodeOf.set(change.node.id, change.node);
  const counts: Record<ContractMoveKind, number> = { changed: 0, effects: 0, removed: 0, unexported: 0, exposed: 0, moved: 0, added: 0 };
  const rows: ContractRow[] = [];
  for (const move of moves) {
    const node = nodeOf.get(move.id);
    if (node === undefined || !isCodeNode(node)) continue;
    counts[move.kind] += 1;
    rows.push({ kind: "row", move, id: move.id, label: node.qualifiedName, path: node.path, level: node.level, unmentioned: unmentionedSet.has(move.id) });
  }

  const entries: (ContractRow | ContractRollup)[] = [];
  const grouped = new Map<string, ContractRow[]>();
  for (const row of rows) {
    const kind = row.move.kind;
    if (kind !== "added" && kind !== "moved") {
      entries.push(row);
      continue;
    }
    const key = `${kind} ${row.path}`;
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  for (const group of grouped.values()) {
    const first = group[0]!;
    if (group.length <= ROLLUP_OVER) {
      entries.push(...group);
      continue;
    }
    entries.push({
      kind: "rollup",
      moveKind: first.move.kind as "added" | "moved",
      path: first.path,
      fileId: `file:${first.path}` as NodeId,
      rows: group,
      unmentioned: group.filter((row) => row.unmentioned).length,
    });
  }
  const rank = (entry: ContractRow | ContractRollup): number =>
    CONTRACT_ORDER.indexOf(entry.kind === "row" ? entry.move.kind : entry.moveKind);
  const key = (entry: ContractRow | ContractRollup): string => (entry.kind === "row" ? entry.id : entry.path);
  entries.sort((a, b) => rank(a) - rank(b) || Number(a.kind === "rollup") - Number(b.kind === "rollup") || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  return { counts, entries };
}

export interface SignatureDiff {
  readonly prefix: string;
  readonly removed: string;
  readonly added: string;
  readonly suffix: string;
}

/** What two signatures share at the start and the end, and the middle of each that differs. */
export function signatureDiff(before: string, after: string): SignatureDiff {
  let start = 0;
  const shortest = Math.min(before.length, after.length);
  while (start < shortest && before[start] === after[start]) start += 1;
  let end = 0;
  while (end < shortest - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end += 1;
  return {
    prefix: before.slice(0, start),
    removed: before.slice(start, before.length - end),
    added: after.slice(start, after.length - end),
    suffix: before.slice(before.length - end),
  };
}

export interface EffectRow {
  /** The class or function the call is in, or the file for module top level. */
  readonly id: NodeId;
  readonly label: string;
  readonly path: string;
  readonly operation: string;
  /** The call's own lines, in the file. */
  readonly range: LineRange;
}

/** The calls of one resource that name one target, or the same unknown or absent one. */
export interface EffectGroup {
  readonly resource: ResourceKind;
  readonly target: EffectTarget;
  readonly rows: readonly EffectRow[];
}

export interface EffectsBlock {
  /** New calls outside tests. */
  readonly edges: number;
  /** The classes, functions and files that hold them. */
  readonly functions: number;
  readonly groups: readonly EffectGroup[];
  /** Calls in files whose role is tests, apart so they do not bury the rest. */
  readonly tests: { readonly edges: number; readonly groups: readonly EffectGroup[] };
}

export interface NewEffects {
  /** No claim covers the module that makes the call, and the description does not name its target. */
  readonly none: EffectsBlock;
  /** Not mentioned either, but an agent linked a claim to the module or its file. A claimed fact. */
  readonly byAgent: EffectsBlock;
}

/**
 * The effect edges the change added that the description does not cover. A call is covered when
 * the module that makes it is mentioned (by the rules of `unmentioned`) or the description names
 * its literal target as a name. A call whose module, or an enclosing module or file, an agent
 * linked is in `byAgent`. Calls in generated files are left out. Groups run in RESOURCE_ORDER,
 * then literal targets alphabetically, then unknown, then none; rows by path and line.
 * `graph` is the picture's graph.
 */
export function newEffects(
  comparison: Comparison,
  graph: Graph,
  description: string,
  linked: ReadonlySet<NodeId> = new Set(),
): NewEffects {
  const { pathMentioned, fileMentioned, nameCovered } = mentionRules(comparison, description);
  const nodes = new Map<NodeId, ModuleNode>(graph.nodes.map((node) => [node.id, node]));
  const fileChanges = new Map<NodeId, ModuleChange>();
  for (const change of comparison.changes) if (change.node.level === "file") fileChanges.set(change.node.id, change);
  const linkedAbove = (start: NodeId): boolean => {
    for (let id: NodeId | null | undefined = start; id !== null && id !== undefined; id = nodes.get(id)?.parent) {
      if (linked.has(id)) return true;
    }
    return false;
  };

  type Bucket = { rows: [EffectGroup["resource"], EffectTarget, EffectRow][]; owners: Set<NodeId> };
  const fresh = (): { source: Bucket; tests: Bucket } => ({ source: { rows: [], owners: new Set() }, tests: { rows: [], owners: new Set() } });
  const none = fresh();
  const byAgent = fresh();
  for (const change of comparison.effects) {
    if (change.kind !== "added") continue;
    const edge = change.edge;
    const owner = nodes.get(edge.from);
    const file = owner === undefined ? undefined : nodes.get(`file:${owner.path}` as NodeId);
    if (owner === undefined || file?.level !== "file" || file.role === "generated") continue;
    const fileChange = fileChanges.get(file.id);
    const covered =
      (fileChange === undefined ? pathMentioned(file.path) : fileMentioned(fileChange)) ||
      (isCodeNode(owner) && nameCovered(owner.qualifiedName)) ||
      (typeof edge.target === "object" && appears(description, "name", edge.target.literal));
    if (covered) continue;
    const row: EffectRow = {
      id: owner.id,
      label: isCodeNode(owner) ? owner.qualifiedName : owner.path,
      path: owner.path,
      operation: edge.operation,
      range: edge.range,
    };
    const side = linkedAbove(owner.id) ? byAgent : none;
    const bucket = file.role === "tests" ? side.tests : side.source;
    bucket.rows.push([resourceKindOf(edge), edge.target, row]);
    bucket.owners.add(owner.id);
  }

  const group = (bucket: Bucket): EffectGroup[] => {
    const groups = new Map<string, { resource: ResourceKind; target: EffectTarget; rows: EffectRow[] }>();
    for (const [resource, target, row] of bucket.rows) {
      const key = `${RESOURCE_ORDER.indexOf(resource)}\0${targetText(target)}`;
      const found = groups.get(key) ?? { resource, target, rows: [] };
      found.rows.push(row);
      groups.set(key, found);
    }
    const targetRank = (target: EffectTarget): number => (typeof target === "object" ? 0 : target === "unknown" ? 1 : 2);
    return [...groups.values()]
      .map((found) => ({ ...found, rows: found.rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.range.start - b.range.start || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0)) }))
      .sort(
        (a, b) =>
          RESOURCE_ORDER.indexOf(a.resource) - RESOURCE_ORDER.indexOf(b.resource) ||
          targetRank(a.target) - targetRank(b.target) ||
          (targetText(a.target) < targetText(b.target) ? -1 : targetText(a.target) > targetText(b.target) ? 1 : 0),
      );
  };
  const block = ({ source, tests }: { source: Bucket; tests: Bucket }): EffectsBlock => ({
    edges: source.rows.length,
    functions: source.owners.size,
    groups: group(source),
    tests: { edges: tests.rows.length, groups: group(tests) },
  });
  return { none: block(none), byAgent: block(byAgent) };
}

/** The parts of an effect label: its resource, the API's own name, and the literal it names if it names one. */
export function effectParts(label: string): { resource: ResourceKind | undefined; name: string; literal: string | undefined } {
  const resource = RESOURCE_ORDER.find((kind) => label.startsWith(`${kind} `));
  const rest = resource === undefined ? label : label.slice(resource.length + 1);
  const at = rest.search(/ ("|\(target unknown\))/);
  const operation = at === -1 ? rest : rest.slice(0, at);
  const literal = at !== -1 && rest[at + 1] === '"' ? rest.slice(at + 2, -1) : undefined;
  return { resource, name: operation.slice(operation.lastIndexOf(" ") + 1), literal };
}

/** A contract row's chip for one effect label: the resource and the literal it names, else the API's name. */
export function effectChip(label: string): string {
  const { resource, name, literal } = effectParts(label);
  return `${resource ?? ""} ${literal ?? name}`.trim();
}
