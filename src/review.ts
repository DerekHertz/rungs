import { LOCKFILE_NAMES, RESOURCE_ORDER, isCodeNode, lineCount, nodeId, targetText } from "./graph.ts";
import type { CodeLevel, EffectTarget, Graph, LineRange, ModuleNode, NodeId, ResourceKind } from "./graph.ts";
import type { DependencyChange } from "./dependencies.ts";
import { resourceKindOf } from "./effects.ts";
import { typeChange } from "./type-change.ts";
import type { ChangedEffect } from "./effects.ts";
import type { SectionChange } from "./sections.ts";
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

/**
 * Whether a Markdown heading is in a description: the whole phrase, case-insensitively, any run
 * of white space matching the heading's own, and not inside a longer word ("Review" is not in
 * "Reviewer" or "preview"). A heading with no letter or digit names nothing.
 */
export function headingAppears(description: string, heading: string): boolean {
  if (!/[\p{L}\p{N}]/u.test(heading)) return false;
  const body = heading.trim().split(/\s+/).map(escape).join("\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, "iu").test(description);
}

interface EntryBase {
  readonly id: NodeId;
  /** A path for a file or district, the qualified name for a class or function. */
  readonly label: string;
  /** Null for a binary file, which has bytes and no lines. */
  readonly lines: number | null;
  readonly children: readonly ReviewEntry[];
}

export type ReviewEntry =
  | (EntryBase & {
      readonly level: "file" | "class" | "function" | "section";
      readonly change: ChangeKind;
      /** A section's file, to select when the entry is picked. */
      readonly path?: string;
      /** A section's added and removed lines. */
      readonly plus?: number;
      readonly minus?: number;
      readonly from?: string;
      /** An agent linked a claim to this very module, not only to something in its file. */
      readonly linked?: true;
      /** Anonymous callbacks inside it whose change is rolled up into this row instead of listed. */
      readonly folded?: readonly NodeId[];
    })
  /** A folder or package whose changed files are all unmentioned, rolled up. `children` are its files. */
  | (EntryBase & { readonly level: "district"; readonly files: number; readonly kinds: Tally })
  /** Files whose text is identical under a new path, all from one folder to one folder: one fact, not one item each. `children` are the moved files. */
  | (EntryBase & { readonly level: "moves"; readonly files: number; readonly from: string; readonly to: string });

export interface Unmentioned {
  /** Every changed file, mentioned or not. */
  readonly changedFiles: number;
  /** Files whose path or name the description never gives, linked by an agent or not. */
  readonly unmentionedFiles: number;
  /** Of those, the lockfile changes listed under an unmentioned dependency change (see dependencyReview), not among the entries. */
  readonly dependencyLockfiles: number;
  /** Of those, the files an agent linked a claim to. */
  readonly linkedFiles: number;
  /** "No claim covers it": neither mentioned nor linked. */
  readonly entries: readonly ReviewEntry[];
  /** "Linked by the agent only": not mentioned, but an agent linked a claim to the file or to code in it. A claimed fact. */
  readonly linkedEntries: readonly ReviewEntry[];
  /** Move groups listed, in either list. A group stands for several files in `unmentionedFiles`. */
  readonly moveGroups: number;
  /** Move groups in `entries`, and the files they hold: the summary counts each group as one item. */
  readonly unlinkedMoveGroups: number;
  readonly unlinkedMovedFiles: number;
}

interface Segment {
  readonly text: string;
  readonly ordinal: number;
}

/** The (text, ordinal) path a qualified name encodes; see `qualifiedName` in graph.ts. */
function segmentsOf(name: string): Segment[] {
  const found: Segment[] = [];
  let at = 0;
  while (at < name.length) {
    let text: string;
    if (name[at] === '"') {
      let end = at + 1;
      while (name[end] !== '"') end += name[end] === "\\" ? 2 : 1;
      text = JSON.parse(name.slice(at, end + 1)) as string;
      at = end + 1;
    } else {
      const end = name.slice(at).search(/[.@]/u);
      const stop = end === -1 ? name.length : at + end;
      text = name.slice(at, stop);
      at = stop;
    }
    let ordinal = 1;
    if (name[at] === "@") {
      const digits = /^\d+/u.exec(name.slice(at + 1))![0];
      ordinal = Number(digits);
      at += 1 + digits.length;
    }
    found.push({ text, ordinal });
    at += 1;
  }
  return found;
}

/** The callbacks a test runner names: `test("x")`, `describe.only("x")`, `it.skip("x")` (the extractor names a callback by the last name of its callee, so those read `only("x")`, `skip("x")`). Any other callback with a string argument is still anonymous. */
const LABELLED_CALLBACK = /^(?:test|it|describe|suite|skip|only|todo|concurrent|sequential|fails|failing)\(".*"\) callback$/su;

/** A function the source gives no name a reviewer could tell apart: `map() callback`, `<function>`. */
export function isAnonymous(node: ModuleNode): boolean {
  if (node.level !== "function" && node.level !== "class") return false;
  const last = segmentsOf(node.qualifiedName).at(-1)!.text;
  if (last === "<function>" || last === "<class>") return true;
  return last.endsWith(" callback") && !LABELLED_CALLBACK.test(last);
}

/** What a row says: a test or describe callback by its own `test("name")`, anything else by its qualified name. */
export function labelOf(node: ModuleNode & { readonly qualifiedName: string }): string {
  const last = segmentsOf(node.qualifiedName).at(-1)!;
  if (!LABELLED_CALLBACK.test(last.text)) return node.qualifiedName;
  return `${last.text.slice(0, -" callback".length)}${last.ordinal > 1 ? `@${last.ordinal}` : ""}`;
}

type Kinds = { -readonly [K in ChangeKind]: number };

/** The path a change stood at on each side: its own, and a moved module's old one. */
const pathsOf = (change: ModuleChange): string[] =>
  change.kind === "moved" ? [change.node.path, change.from.path] : [change.node.path];

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
const directoryOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")));

function sizeOf(node: ModuleNode): number | null {
  return node.level === "file" && node.lines === null ? null : lineCount(node);
}

function bySeverity(a: ReviewEntry, b: ReviewEntry): number {
  const rank = (entry: ReviewEntry): number =>
    entry.level === "moves"
      ? URGENCY.moved
      : entry.level === "district"
      ? Math.min(...(["removed", "altered", "added", "moved"] as const).filter((kind) => entry.kinds[kind] > 0).map((kind) => URGENCY[kind]))
      : URGENCY[entry.change];
  // A binary file has no size to rank by: it follows the sized rows of its urgency, then goes by label.
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (a.lines === null || b.lines === null) {
    if (a.lines !== b.lines) return a.lines === null ? 1 : -1;
    return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
  }
  return b.lines - a.lines || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0);
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
    /** A section is covered by its own heading or an enclosing one. */
    sectionCovered: (section: SectionChange): boolean =>
      [...section.ancestorHeadings, section.heading].some((heading) => headingAppears(description, heading)),
  };
}

/** A changed lockfile: a generated file the extractor's lockfile names recognise. */
const isLockfileChange = (change: ModuleChange): boolean => change.node.level === "file" && change.node.role === "generated" && LOCKFILE_NAMES.has(baseName(change.node.path));

/** A lockfile follows the dependency changes of the package.json in its own folder, and only those. */
const followsDependencies = (comparison: Comparison, lockfile: ModuleChange): boolean =>
  comparison.dependencies.some((change) => directoryOf(change.path) === directoryOf(lockfile.node.path));

/**
 * The changed files, and the classes and functions under them, that no claim covers, rolled up.
 * A lockfile's change is left out when a dependency changed: dependencyReview lists it.
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
  const { pathMentioned, fileMentioned, nameCovered, sectionCovered } = mentionRules(comparison, description);

  const sectionsBy = new Map<string, ReviewEntry[]>();
  for (const section of comparison.sections) {
    if (sectionCovered(section)) continue;
    const entry: ReviewEntry = {
      id: section.id,
      level: "section",
      label: [...section.ancestors, section.name].join(" › "),
      change: section.kind,
      lines: section.plus + section.minus,
      path: section.path,
      plus: section.plus,
      minus: section.minus,
      children: [],
    };
    sectionsBy.set(section.path, [...(sectionsBy.get(section.path) ?? []), entry]);
  }

  // Moved files by (old folder, new folder). A group of two or more is one fact, mentioned when the
  // description names either folder or a folder above one; its files then count as mentioned.
  const moveGroupOf = (change: ModuleChange): string | undefined =>
    change.kind === "moved" && change.node.level === "file" ? `${directoryOf(change.from.path)}\0${directoryOf(change.node.path)}` : undefined;
  const movedTogether = new Map<string, number>();
  for (const change of fileChanges) {
    const key = moveGroupOf(change);
    if (key !== undefined) movedTogether.set(key, (movedTogether.get(key) ?? 0) + 1);
  }
  // A folder is named as a path, bare or with a trailing slash (never as the start of a file's path).
  // Only the group's own folder may be a bare word; a folder above it needs a slash: `themes/town` or `themes/`.
  // The path token ends after the slash: at white space, the end, a closing quote or bracket, or
  // sentence punctuation that is itself followed by one of those. `new/@scope/x.ts` and `new/.env` go on.
  const tokenEnd = "(?=$|[\\s\"'`)\\]}>]|[.,;:!?](?=$|[\\s\"'`)\\]}>]))";
  const slashed = (dir: string): boolean => new RegExp(`(?<![\\p{ID_Continue}\\u200C\\u200D_./-])${escape(dir)}/${tokenEnd}`, "u").test(description);
  const folderNamed = (dir: string): boolean => {
    for (let at = dir; at !== ""; at = directoryOf(at)) {
      if ((at === dir || at.includes("/")) && appears(description, "path", at)) return true;
      if (slashed(at)) return true;
    }
    return false;
  };
  const groupMentioned = (change: ModuleChange): boolean => {
    const key = moveGroupOf(change);
    if (key === undefined || (movedTogether.get(key) ?? 0) < 2) return false;
    return key.split("\0").some(folderNamed);
  };

  const changeOf = new Map<NodeId, ModuleChange>(comparison.changes.map((change) => [change.node.id, change]));
  // Removed nodes are not in the picture graph; their parents are the base graph's, read from the change itself.
  const nodeOf = new Map<NodeId, ModuleNode>([...comparison.changes.map((change): [NodeId, ModuleNode] => [change.node.id, change.node]), ...graph.nodes.map((node): [NodeId, ModuleNode] => [node.id, node])]);
  /** The nearest enclosing change that is not itself anonymous, or undefined when only the file holds it. */
  const holderOf = (node: ModuleNode): ModuleChange | undefined => {
    for (let up = isCodeNode(node) ? nodeOf.get(node.parent) : undefined; up !== undefined && isCodeNode(up); up = nodeOf.get(up.parent)) {
      const held = changeOf.get(up.id);
      if (held !== undefined && !isAnonymous(held.node)) return held;
    }
    return undefined;
  };

  const folds = new Map<NodeId, NodeId[]>();
  const fileFolds = new Map<string, NodeId[]>();
  const codeChanges: ModuleChange[] = [];
  for (const change of comparison.changes) {
    const node = change.node;
    if (!isCodeNode(node) || pathsOf(change).some(pathMentioned)) continue;
    if (nameCovered(node.qualifiedName)) continue;
    if (!isAnonymous(node)) {
      codeChanges.push(change);
      continue;
    }
    const holder = holderOf(node);
    if (holder === undefined) fileFolds.set(node.path, [...(fileFolds.get(node.path) ?? []), node.id]);
    else folds.set(holder.node.id, [...(folds.get(holder.node.id) ?? []), node.id]);
  }

  const codeBy = new Map<string, ReviewEntry[]>();
  for (const change of codeChanges) {
    const node = change.node as ModuleNode & { readonly level: "class" | "function"; readonly qualifiedName: string };
    const folded = folds.get(node.id);
    const entry: ReviewEntry = { id: node.id, level: node.level, label: labelOf(node), change: change.kind, lines: sizeOf(node), children: [], ...(folded === undefined ? {} : { folded }) };
    codeBy.set(node.path, [...(codeBy.get(node.path) ?? []), entry]);
  }

  const linkedPaths = new Set<string>();
  for (const change of comparison.changes) if (isCodeNode(change.node) && linked.has(change.node.id)) linkedPaths.add(change.node.path);

  const dirsChanged = new Map<string, number>();
  const underDependencies = new Set(dependencyReview(comparison, description).lockfiles.map((entry) => entry.id));
  let dependencyLockfiles = 0;
  const none: ReviewEntry[] = [];
  const byAgent: ReviewEntry[] = [];
  for (const change of fileChanges) {
    const node = change.node;
    for (let dir = directoryOf(node.path); dir !== ""; dir = directoryOf(dir)) dirsChanged.set(dir, (dirsChanged.get(dir) ?? 0) + 1);
    if (fileMentioned(change) || groupMentioned(change)) continue;
    if (isLockfileChange(change) && followsDependencies(comparison, change)) {
      if (underDependencies.has(node.id)) dependencyLockfiles += 1;
      continue;
    }
    const agent = linked.has(node.id) || linkedPaths.has(node.path);
    const children = (codeBy.get(node.path) ?? [])
      .map((child): ReviewEntry => (linked.has(child.id) && child.level !== "district" && child.level !== "moves" ? { ...child, linked: true } : child))
      .sort(bySeverity);
    children.push(...(sectionsBy.get(node.path) ?? []));
    const entry: ReviewEntry = {
      id: node.id,
      level: "file",
      label: node.path,
      change: change.kind,
      lines: sizeOf(node),
      children,
      ...(change.kind === "moved" ? { from: change.from.path } : {}),
      ...(fileFolds.has(node.path) ? { folded: fileFolds.get(node.path)! } : {}),
    };
    (agent ? byAgent : none).push(entry);
  }

  const containerAt = new Map<string, NodeId>();
  for (const node of graph.nodes) if (node.level === "package" || node.level === "folder") containerAt.set(node.path, node.id);

  /** Moved files that share both folders become one entry each, at two or more; the rest of the list is returned as it was. */
  function groupMoves(files: readonly ReviewEntry[]): { rest: ReviewEntry[]; groups: ReviewEntry[] } {
    const by = new Map<string, ReviewEntry[]>();
    for (const file of files) {
      if (file.level !== "file" || file.from === undefined) continue;
      const key = `${directoryOf(file.from)}\0${directoryOf(file.label)}`;
      by.set(key, [...(by.get(key) ?? []), file]);
    }
    const grouped = new Set<ReviewEntry>();
    const groups: ReviewEntry[] = [];
    for (const [key, inside] of by) {
      if (inside.length < 2) continue;
      const [from, to] = key.split("\0") as [string, string];
      inside.sort(bySeverity);
      for (const file of inside) grouped.add(file);
      groups.push({
        id: inside[0]!.id,
        level: "moves",
        label: `${inside.length} files moved unchanged: ${from === "" ? "(root)" : from} → ${to === "" ? "(root)" : to}`,
        files: inside.length,
        from,
        to,
        lines: inside.reduce((sum, file) => sum + (file.lines ?? 0), 0),
        children: inside,
      });
    }
    return { rest: files.filter((file) => !grouped.has(file)), groups };
  }

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
        lines: inside.reduce((sum, entry) => sum + (entry.lines ?? 0), 0),
        children: inside,
      };
      districts.set(top, district);
      entries.push(district);
    }
    return entries.sort(bySeverity);
  }

  const unlinked = groupMoves(none);
  const linkedGroups = groupMoves(byAgent);
  return {
    changedFiles: fileChanges.length,
    unmentionedFiles: none.length + byAgent.length + dependencyLockfiles,
    dependencyLockfiles,
    linkedFiles: byAgent.length,
    entries: [...rollUp(unlinked.rest), ...unlinked.groups].sort(bySeverity),
    linkedEntries: [...rollUp(linkedGroups.rest), ...linkedGroups.groups].sort(bySeverity),
    moveGroups: unlinked.groups.length + linkedGroups.groups.length,
    unlinkedMoveGroups: unlinked.groups.length,
    unlinkedMovedFiles: none.length - unlinked.rest.length,
  };
}

/** How many sections the entries list, nested ones included. */
export function sectionCount(entries: readonly ReviewEntry[]): number {
  return entries.reduce((sum, entry) => sum + (entry.level === "section" ? 1 : 0) + sectionCount(entry.children), 0);
}

/** The ids of every entry of `result`, nested ones included: the changes no claim covers. */
export function unmentionedIds(result: Unmentioned): Set<NodeId> {
  const ids = new Set<NodeId>();
  const visit = (entries: readonly ReviewEntry[]): void => {
    for (const entry of entries) {
      ids.add(entry.id);
      if (entry.level !== "district" && entry.level !== "moves") for (const id of entry.folded ?? []) ids.add(id);
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
  readonly level: CodeLevel | "interface" | "type" | "re-export";
  /** No claim covers the change to this node. */
  readonly unmentioned: boolean;
  /** A changed interface or type alias: one line per member, union arm or clause that was added, removed or changed. Null when its text cannot be read apart, so the whole before and after is shown instead. */
  readonly members?: readonly string[] | null;
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

/** A call whose arguments changed, under the class, function or file that holds it. */
export interface EffectsChangedRow {
  readonly id: NodeId;
  /** The qualified name of a class or function, the path of a file. */
  readonly label: string;
  readonly path: string;
  readonly change: ChangedEffect;
  /** "none": no claim covers it. "byAgent": only an agent's link does, a claimed fact. "claimed": the description does. */
  readonly coverage: "none" | "byAgent" | "claimed";
}

export interface ContractsReport {
  readonly counts: Readonly<Record<ContractMoveKind, number>>;
  /** Kind "effects changed": any holder, exported or not, since a call's arguments are its contract with what it reaches. */
  readonly effectsChanged: readonly EffectsChangedRow[];
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
  effectsChanged: readonly EffectsChangedRow[] = [],
): ContractsReport {
  // An effects move can be for a node whose text did not change, so it has no change to read.
  // Removed nodes are not in the picture graph; their parents are the base graph's, read from the change itself.
  const nodeOf = new Map<NodeId, ModuleNode>([...comparison.changes.map((change): [NodeId, ModuleNode] => [change.node.id, change.node]), ...graph.nodes.map((node): [NodeId, ModuleNode] => [node.id, node])]);
  for (const change of comparison.changes) nodeOf.set(change.node.id, change.node);
  const counts: Record<ContractMoveKind, number> = { changed: 0, effects: 0, removed: 0, unexported: 0, exposed: 0, moved: 0, added: 0 };
  const rows: ContractRow[] = [];
  for (const move of moves) {
    const node = nodeOf.get(move.id);
    if (move.type !== undefined) {
      counts[move.kind] += 1;
      const members = move.kind === "changed" && move.before !== null && move.after !== null ? typeChange(move.before, move.after) : undefined;
      rows.push({ kind: "row", move, id: move.id, label: move.type.name, path: node?.path ?? move.id.replace(/^file:/, ""), level: move.type.kind, unmentioned: unmentionedSet.has(move.id), ...(members === undefined ? {} : { members: members === null || members.length === 0 ? null : members }) });
      continue;
    }
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
  return { counts, effectsChanged, entries };
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
  /** Calls whose arguments changed that no claim covers: kind "effects changed" in Unmentioned. */
  readonly changed: { readonly none: readonly EffectsChangedRow[]; readonly byAgent: readonly EffectsChangedRow[] };
  /** No claim covers the module that makes the call, and the description does not name its target. */
  readonly none: EffectsBlock;
  /** Not mentioned either, but an agent linked a claim to the module or its file. A claimed fact. */
  readonly byAgent: EffectsBlock;
}

/**
 * The changed effects (see changedEffects in src/effects.ts) with whether a claim covers each:
 * the description names its holder or an enclosing name or path (the rules of `unmentioned`), or
 * names a literal argument it added or removed. Calls in generated files are left out. Sorted by
 * path, then holder.
 */
export function effectsChangedRows(
  comparison: Comparison,
  graph: Graph,
  description: string,
  linked: ReadonlySet<NodeId> = new Set(),
): EffectsChangedRow[] {
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
  const rows: EffectsChangedRow[] = [];
  for (const change of comparison.changedEffects) {
    const owner = nodes.get(change.owner);
    const file = owner === undefined ? undefined : nodes.get(`file:${owner.path}` as NodeId);
    if (owner === undefined || file?.level !== "file" || file.role === "generated") continue;
    const fileChange = fileChanges.get(file.id);
    const says = [...change.added, ...change.removed].some((token) => token.startsWith('"') && appears(description, "name", JSON.parse(token) as string));
    const covered =
      (fileChange === undefined ? pathMentioned(file.path) : fileMentioned(fileChange)) || (isCodeNode(owner) && nameCovered(owner.qualifiedName)) || says;
    rows.push({
      id: owner.id,
      label: isCodeNode(owner) ? owner.qualifiedName : owner.path,
      path: owner.path,
      change,
      coverage: covered ? "claimed" : linkedAbove(owner.id) ? "byAgent" : "none",
    });
  }
  return rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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
  const rows = effectsChangedRows(comparison, graph, description, linked);
  return {
    changed: { none: rows.filter((row) => row.coverage === "none"), byAgent: rows.filter((row) => row.coverage === "byAgent") },
    none: block(none),
    byAgent: block(byAgent),
  };
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

/** One dependency change no claim covers. `id` is its package.json's file node. */
export interface DependencyRow {
  readonly id: NodeId;
  readonly change: DependencyChange;
}

export interface DependencyReview {
  /** Dependency changes whose name the description never gives, by path then name. */
  readonly none: readonly DependencyRow[];
  /** The lockfile changes those follow, as file entries; empty when none is listed. */
  readonly lockfiles: readonly ReviewEntry[];
}

const NAME_WORD = "\\p{ID_Continue}\\u200C\\u200D_$";

/**
 * A dependency is mentioned when its name appears in the description as a whole name: not inside
 * a longer one (`three` is not in `three-stdlib`, `@types/three` or `three.js`), a scope kept
 * with its package.
 */
export function dependencyMentioned(description: string, name: string): boolean {
  if (name.trim() === "") return false;
  return new RegExp(`(?<![${NAME_WORD}@/.-])${escape(name)}(?![${NAME_WORD}/-]|\\.[${NAME_WORD}])`, "u").test(description);
}

/**
 * The dependency changes (see diffDependencies in src/dependencies.ts) the description does not
 * name, and the lockfile changes that follow them: a lockfile is listed under the unmentioned
 * dependency changes of the package.json in its own folder. When every dependency change in its
 * folder is mentioned, the lockfile counts as mentioned, explained by them (and `unmentioned`
 * leaves it out); with no dependency change in its folder `unmentioned` lists it as a file.
 */
export function dependencyReview(comparison: Comparison, description: string): DependencyReview {
  const none = comparison.dependencies
    .filter((change) => !dependencyMentioned(description, change.name))
    .map((change): DependencyRow => ({ id: nodeId("file", change.path, ""), change }));
  const { fileMentioned } = mentionRules(comparison, description);
  const lockfiles = comparison.changes
    .filter((change) => isLockfileChange(change) && !fileMentioned(change) && none.some((row) => directoryOf(row.change.path) === directoryOf(change.node.path)))
    .map((change): ReviewEntry => ({
      id: change.node.id,
      level: "file",
      label: change.node.path,
      change: change.kind,
      lines: sizeOf(change.node),
      children: [],
      ...(change.kind === "moved" ? { from: change.from.path } : {}),
    }));
  return { none, lockfiles };
}
