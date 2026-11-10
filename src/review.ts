import { isCodeNode, lineCount } from "./graph.ts";
import type { CodeLevel, Graph, ModuleNode, NodeId } from "./graph.ts";
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
  | (EntryBase & { readonly level: "file" | "class" | "function"; readonly change: ChangeKind; readonly from?: string })
  /** A folder or package whose changed files are all unmentioned, rolled up. `children` are its files. */
  | (EntryBase & { readonly level: "district"; readonly files: number; readonly kinds: Tally });

export interface Unmentioned {
  /** Every changed file, mentioned or not. */
  readonly changedFiles: number;
  readonly unmentionedFiles: number;
  readonly entries: readonly ReviewEntry[];
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
 */
export function unmentioned(comparison: Comparison, graph: Graph, description: string): Unmentioned {
  const fileChanges = comparison.changes.filter((change) => change.node.level === "file");
  const shared = new Map<string, number>();
  for (const change of fileChanges) {
    for (const name of new Set(pathsOf(change).map(baseName))) shared.set(name, (shared.get(name) ?? 0) + 1);
  }
  const pathMentioned = (path: string): boolean =>
    appears(description, "path", path) || (shared.get(baseName(path)) === 1 && appears(description, "file", baseName(path)));
  const fileMentioned = (change: ModuleChange): boolean => pathsOf(change).some(pathMentioned);

  const codeBy = new Map<string, ReviewEntry[]>();
  for (const change of comparison.changes) {
    const node = change.node;
    if (!isCodeNode(node) || pathsOf(change).some(pathMentioned)) continue;
    const parts = node.qualifiedName.split(".");
    const covered = parts.some((_, index) => appears(description, "name", parts.slice(0, index + 1).join(".")));
    if (covered) continue;
    const entry: ReviewEntry = { id: node.id, level: node.level, label: node.qualifiedName, change: change.kind, lines: sizeOf(node), children: [] };
    codeBy.set(node.path, [...(codeBy.get(node.path) ?? []), entry]);
  }

  const files: ReviewEntry[] = [];
  const dirsChanged = new Map<string, number>();
  const dirsUnmentioned = new Map<string, number>();
  const filesIn = new Map<string, ReviewEntry[]>();
  for (const change of fileChanges) {
    const node = change.node;
    const dirs: string[] = [];
    for (let dir = directoryOf(node.path); dir !== ""; dir = directoryOf(dir)) dirs.push(dir);
    for (const dir of dirs) dirsChanged.set(dir, (dirsChanged.get(dir) ?? 0) + 1);
    if (fileMentioned(change)) continue;
    const children = [...(codeBy.get(node.path) ?? [])].sort(bySeverity);
    const entry: ReviewEntry = {
      id: node.id,
      level: "file",
      label: node.path,
      change: change.kind,
      lines: sizeOf(node),
      children,
      ...(change.kind === "moved" ? { from: change.from.path } : {}),
    };
    files.push(entry);
    for (const dir of dirs) {
      dirsUnmentioned.set(dir, (dirsUnmentioned.get(dir) ?? 0) + 1);
      filesIn.set(dir, [...(filesIn.get(dir) ?? []), entry]);
    }
  }

  const containerAt = new Map<string, NodeId>();
  for (const node of graph.nodes) if (node.level === "package" || node.level === "folder") containerAt.set(node.path, node.id);
  const rolls = (dir: string): boolean =>
    containerAt.has(dir) && (dirsUnmentioned.get(dir) ?? 0) >= 2 && dirsUnmentioned.get(dir) === dirsChanged.get(dir);
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
  entries.sort(bySeverity);
  return { changedFiles: fileChanges.length, unmentionedFiles: files.length, entries };
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
const CONTRACT_ORDER: readonly ContractMoveKind[] = ["changed", "removed", "unexported", "exposed", "moved", "added"];

/**
 * The contracts that moved as rows to show, in the order a reviewer must read them: changed,
 * removed, unexported, exposed, moved, added. Within a kind, by id, with a file's rollup after
 * the single rows of its kind. Only added and moved exports roll up, since a new or relocated
 * file can bring hundreds; a changed, removed, unexported or exposed export is always its own row.
 */
export function contractsReport(
  comparison: Comparison,
  moves: readonly ContractMove[],
  unmentionedSet: ReadonlySet<NodeId>,
): ContractsReport {
  const nodeOf = new Map<NodeId, ModuleNode>(comparison.changes.map((change) => [change.node.id, change.node]));
  const counts: Record<ContractMoveKind, number> = { changed: 0, removed: 0, unexported: 0, exposed: 0, moved: 0, added: 0 };
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
