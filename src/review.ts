import { isCodeNode, lineCount } from "./graph.ts";
import type { Graph, ModuleNode, NodeId } from "./graph.ts";
import type { ChangeKind, Comparison, ModuleChange, Tally } from "./compare.ts";

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
