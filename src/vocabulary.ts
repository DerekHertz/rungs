import { posix } from "node:path";
import type { FileNode, LineRange, SectionNode } from "./graph.ts";
import { isCodeNode } from "./graph.ts";
import { splitLines } from "./lines.ts";
import { roleOf } from "./extract/roles.ts";
import { WITHHELD, looksSecret, promptName } from "./prompt-safe.ts";
import { isTestFile } from "./test-files.ts";
import type { BaseSide } from "./standards.ts";
import { GENERIC_PHRASES, GENERIC_WORDS, MAX_PHRASE_WORDS, MAX_WORD_CHARS, MIN_KEY_CHARS, STOP_WORDS, VOCABULARY_TABLE_VERSION } from "./vocabulary-table.ts";

export { VOCABULARY_TABLE_VERSION } from "./vocabulary-table.ts";

/*
 * A repository's own words (SPEC rule 5, never guess; CODING_STANDARDS, unknown is never zero). A
 * term is a word or short phrase the repository already uses for one of its concepts, taken from
 * its Markdown headings, folder names, exported names, test and describe names and package
 * descriptions, and pinned to where each was written. No model is called, and the rules in
 * vocabulary-table.ts are the same for every repository.
 *
 * The vocabulary is its own value, stored apart from the graph: nothing here writes a graph fact,
 * and a graph holds no term. Spellings of one concept that differ in case, plural or separators
 * are one term. A term most of a repository would match ("utils", "index") is dropped by a table
 * rule and the drop is counted. What could not be read is listed, so a short list never reads as
 * a complete one.
 */

export type TermSource = "heading" | "folder" | "export" | "test" | "package description";

/** One place a term was written. */
export interface TermPin {
  readonly source: TermSource;
  /** The file, or the folder for a "folder" pin. */
  readonly path: string;
  /**
   * The lines where it is written. Null when there are none to give: a folder has no lines, and a
   * name the file's text did not show is not guessed at.
   */
  readonly range: LineRange | null;
  /** The text as written, cut down to letters, digits and "_ . $ / -" so it is safe to show. */
  readonly written: string;
}

export interface Term {
  /** The concept: its words in lower case, singular, one space apart. Unique among terms. */
  readonly key: string;
  /** The spelling used most, for display; ties go to the first in sorted order. */
  readonly name: string;
  /** Every distinct spelling merged into this term, sorted. */
  readonly spellings: readonly string[];
  /** Sorted by path, then line, then source. Never empty. */
  readonly pins: readonly TermPin[];
}

/** Why a term was dropped. "short": its key is under MIN_KEY_CHARS or all digits. "generic": GENERIC_WORDS or GENERIC_PHRASES. */
export type DropRule = "short" | "generic";

export interface Unread {
  readonly path: string;
  readonly reason: string;
}

export interface Vocabulary {
  readonly tableVersion: number;
  /**
   * - "found": at least one term. `unread` and `notAnalysed` may say the list is incomplete.
   * - "none": everything was read and the repository wrote no term (any dropped ones are counted).
   * - "unknown": no term, and something could not be read, so there may be some. Never to be shown or counted as none.
   */
  readonly status: "found" | "none" | "unknown";
  /** Sorted by key. */
  readonly terms: readonly Term[];
  /** Terms the rules removed: they are counted and named, never silently gone. Sorted by key. */
  readonly dropped: { readonly count: number; readonly terms: readonly { readonly key: string; readonly rule: DropRule }[] };
  /** Written phrases that were not made terms, by why. Counts of phrases as written, so one term written twice counts twice. */
  readonly skipped: {
    /** More than MAX_PHRASE_WORDS words. */
    readonly tooLong: number;
    /** Shaped like a secret (looksSecret, promptName): never kept. */
    readonly withheld: number;
    /** No words, or a word longer than MAX_WORD_CHARS. */
    readonly notAWord: number;
    /** Folders whose name starts with ".": tooling, not the repository's concepts. */
    readonly hiddenFolders: number;
    /** Files and folders whose role is "generated" (lockfiles, vendored, minified). */
    readonly generated: number;
  };
  /** Files whose words could not be read, with why, sorted by path. */
  readonly unread: readonly Unread[];
  /** Text files no language adapter reads and no role explains (a Python file): their exported names and tests are not collected. */
  readonly notAnalysed: number;
  /** Why the status is "unknown", for display. */
  readonly reason?: string;
}

/** The singular of a word, by a few plain rules; a heuristic for merging plural and singular spellings, never a dictionary. */
export function singular(word: string): string {
  if (word.length <= 3 || /(?:ss|us|is)$/.test(word) || !word.endsWith("s")) return word;
  if (/[^aeiou]ies$/.test(word)) return `${word.slice(0, -3)}y`;
  if (/(?:ch|sh|x|z|ss)es$/.test(word)) return word.slice(0, -2);
  return word.slice(0, -1);
}

const WORD = /\p{Lu}+(?=\p{Lu}\p{Ll})|\p{Lu}?\p{Ll}+|\p{Lu}+|\p{Lo}+|\p{N}+/gu;

/** The words of a written phrase, lower case: split at separators, at camelCase and at digits. */
export function wordsOf(written: string): string[] {
  return (written.replace(/['’]/g, "").match(WORD) ?? []).map((word) => word.toLowerCase());
}

const STOP_SET: ReadonlySet<string> = new Set(STOP_WORDS);
const GENERIC_WORD_SET: ReadonlySet<string> = new Set(GENERIC_WORDS);
const GENERIC_PHRASE_SET: ReadonlySet<string> = new Set(GENERIC_PHRASES);

/** The written text as it may be shown: letters, digits and "_ . $ / -" only. */
const spelling = (written: string): string => written.replace(/[^\p{L}\p{N}_.$/ -]+/gu, " ").replace(/\s+/g, " ").trim();

/** A heading without its Markdown: link targets, emphasis, code ticks and HTML tags. */
const plainHeading = (heading: string): string => heading.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/<[^>]*>/g, "").replace(/[`*~]/g, "").trim();

interface Builder {
  readonly pins: Map<string, TermPin[]>;
  readonly skipped: { -readonly [K in keyof Vocabulary["skipped"]]: number };
}

/**
 * Makes `written` a term pinned at `where`, or counts why not. Stop words at either end are not
 * part of the name ("the sandbox", "folderOf"); inside it they stay ("order of operations").
 */
function add(into: Builder, written: string, where: Omit<TermPin, "written">): void {
  if (looksSecret(written)) {
    into.skipped.withheld++;
    return;
  }
  const all = wordsOf(written);
  let from = 0;
  let to = all.length;
  while (from < to && STOP_SET.has(all[from]!)) from++;
  while (to > from && STOP_SET.has(all[to - 1]!)) to--;
  const words = all.slice(from, to);
  if (words.length === 0 || words.some((word) => word.length > MAX_WORD_CHARS)) {
    into.skipped.notAWord++;
    return;
  }
  if (words.length > MAX_PHRASE_WORDS) {
    into.skipped.tooLong++;
    return;
  }
  const key = words.map(singular).join(" ");
  const pin: TermPin = { ...where, written: spelling(written) };
  const list = into.pins.get(key);
  if (list === undefined) into.pins.set(key, [pin]);
  else list.push(pin);
}

/** Cuts prose into chunks of words between stop words and punctuation: "a navigable visual system, for teams" gives "navigable visual system" and "teams". */
function chunks(prose: string): string[] {
  const found: string[] = [];
  for (const clause of prose.split(/[,;:.!?()[\]"“”—–]|\s[-/]\s/)) {
    let run: string[] = [];
    const flush = (): void => {
      if (run.length > 0) found.push(run.join(" "));
      run = [];
    };
    for (const token of clause.split(/\s+/)) {
      const bare = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
      if (bare === "" || STOP_SET.has(bare.toLowerCase())) flush();
      else run.push(bare);
    }
    flush();
  }
  return found;
}

/** The title of a test runner's callback, read from the last segment of its qualified name, or undefined for any other name. */
function testTitle(qualified: string): string | undefined {
  let last: string | undefined;
  let at = 0;
  while (at < qualified.length) {
    let end = at;
    if (qualified[at] === '"') {
      end = at + 1;
      while (end < qualified.length && qualified[end] !== '"') end += qualified[end] === "\\" ? 2 : 1;
      end = Math.min(end + 1, qualified.length);
      last = qualified.slice(at, end);
    } else {
      while (end < qualified.length && qualified[end] !== "." && qualified[end] !== "@") end++;
      last = undefined;
    }
    let after = end;
    if (qualified[after] === "@") {
      after++;
      while (after < qualified.length && qualified[after]! >= "0" && qualified[after]! <= "9") after++;
    }
    at = qualified[after] === "." ? after + 1 : after;
  }
  if (last === undefined) return undefined;
  try {
    const call = /^(?:test|it|describe|suite|context|skip|only|todo)\(("(?:[^"\\]|\\.)*")\) callback$/.exec(JSON.parse(last) as string);
    return call === null ? undefined : (JSON.parse(call[1]!) as string);
  } catch {
    return undefined;
  }
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every term the repository's own words give, pinned, with what could not be read counted. `undefined` is a base that could not be read: unknown, never none. */
export function collectVocabulary(base: BaseSide | undefined): Vocabulary {
  const empty = { count: 0, terms: [] };
  const skipped = { tooLong: 0, withheld: 0, notAWord: 0, hiddenFolders: 0, generated: 0 };
  if (base === undefined) return { tableVersion: VOCABULARY_TABLE_VERSION, status: "unknown", terms: [], dropped: empty, skipped, unread: [], notAnalysed: 0, reason: "the base tree could not be read" };

  const into: Builder = { pins: new Map(), skipped };
  const files = new Map<string, FileNode>();
  for (const node of base.graph.nodes) if (node.level === "file") files.set(node.path, node);
  const unread = new Map<string, string>();
  const linesCache = new Map<string, string[]>();
  const linesOf = (path: string): string[] => {
    let lines = linesCache.get(path);
    if (lines === undefined) linesCache.set(path, (lines = splitLines(base.tree.get(path) ?? "")));
    return lines;
  };

  // A file's words may be collected when it is in the graph and the tree, is text and is not generated. Why not is recorded once.
  const checked = new Map<string, boolean>();
  const canRead = (path: string, needsParse: boolean): boolean => {
    let ok = checked.get(path);
    if (ok === undefined) {
      const file = files.get(path);
      let reason: string | undefined;
      if (file === undefined) reason = "missing from the graph";
      else if (!base.tree.has(path)) reason = "missing from the tree";
      else if (file.lines === null) reason = "binary";
      if (reason !== undefined) unread.set(path, reason);
      else if (file?.role === "generated") skipped.generated++;
      ok = reason === undefined && file?.role !== "generated";
      checked.set(path, ok);
    }
    if (!ok) return false;
    // A file with syntax errors has no code nodes: its names are not known, which is not the same as having none.
    if (needsParse && files.get(path)?.analysis === "not fully read") {
      unread.set(path, "not fully read");
      return false;
    }
    return true;
  };

  // Folders: a folder has a name and no lines.
  for (const node of base.graph.nodes) {
    if (node.level !== "folder") continue;
    if (node.path.split("/").some((segment) => segment.startsWith("."))) skipped.hiddenFolders++;
    else if (roleOf(`${node.path}/x`, false) === "generated") skipped.generated++;
    else add(into, node.name, { source: "folder", path: node.path, range: null });
  }

  // Markdown headings, each pinned to its heading line (two, for an underlined one).
  const sectionsBy = new Map<string, SectionNode[]>();
  for (const section of base.graph.sections) sectionsBy.set(section.path, [...(sectionsBy.get(section.path) ?? []), section]);
  // Every Markdown file is looked at, so one with no readable headings (binary, absent from the tree) is listed and not taken for one with none.
  for (const path of files.keys()) if (posix.extname(path) === ".md") canRead(path, false);
  for (const [path, sections] of sectionsBy) {
    if (!canRead(path, false)) continue;
    const lines = linesOf(path);
    for (const section of sections) {
      const first = lines[section.range.start - 1] ?? "";
      const under = lines[section.range.start] ?? "";
      const underlined = !/^\s{0,3}#/.test(first) && section.range.end > section.range.start && /^\s{0,3}(?:=+|-+)\s*$/.test(under);
      add(into, plainHeading(section.heading), { source: "heading", path, range: { start: section.range.start, end: section.range.start + (underlined ? 1 : 0) } });
    }
  }

  // Exported names and test titles. A name is pinned to the first line of its declaration that holds it.
  let notAnalysed = 0;
  for (const file of files.values()) {
    if (file.analysis === "not analysed" && file.role === null && file.lines !== null) notAnalysed++;
    else if (file.analysis === "not fully read") canRead(file.path, true);
  }
  for (const node of base.graph.nodes) {
    if (!isCodeNode(node) || !canRead(node.path, true)) continue;
    const lines = linesOf(node.path);
    if (isTestFile(node.path)) {
      const title = node.level === "function" ? testTitle(node.qualifiedName) : undefined;
      if (title === undefined) continue;
      if (promptName(node.qualifiedName).includes(WITHHELD)) {
        skipped.withheld++;
        continue;
      }
      // The title is on the callback's line, or on one of the lines above it when the call is wrapped.
      let line = node.range.start;
      for (let at = node.range.start; at >= Math.max(1, node.range.start - 4); at--) {
        if (lines[at - 1]?.includes(title) === true) {
          line = at;
          break;
        }
      }
      add(into, title, { source: "test", path: node.path, range: { start: line, end: line } });
      continue;
    }
    if (!node.exported) continue;
    const names = new Set((node.exportedAs ?? []).filter((name) => name !== "*" && name !== "default"));
    if (node.exportedAs === undefined || node.exportedAs.includes("default") || node.exportedAs.includes("*")) names.add(node.name);
    for (const name of names) {
      const holds = new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`);
      let line = node.range.start;
      for (let at = node.range.start; at <= node.range.end; at++) {
        if (holds.test(lines[at - 1] ?? "")) {
          line = at;
          break;
        }
      }
      add(into, name, { source: "export", path: node.path, range: { start: line, end: line } });
    }
  }
  // Exported interfaces and type aliases: the graph has their names and not their lines, so the text gives the line.
  for (const file of files.values()) {
    if (file.types === undefined || file.types.length === 0 || !canRead(file.path, true)) continue;
    const lines = linesOf(file.path);
    for (const type of file.types) {
      if (type.kind === "re-export") continue;
      const declared = new RegExp(`\\b(?:interface|type)\\s+${escapeRegExp(type.name)}(?![\\w$])`);
      const at = lines.findIndex((line) => declared.test(line));
      add(into, type.name, { source: "export", path: file.path, range: at === -1 ? null : { start: at + 1, end: at + 1 } });
    }
  }

  // Package descriptions: prose, cut into chunks at stop words and punctuation.
  for (const manifest of base.graph.manifests) {
    const text = base.tree.get(manifest.path);
    if (text === undefined) {
      unread.set(manifest.path, "missing from the tree");
      continue;
    }
    if (!manifest.readable) {
      unread.set(manifest.path, "not a JSON object");
      continue;
    }
    let description: unknown;
    try {
      description = (JSON.parse(text.replace(/^\uFEFF/, "")) as Record<string, unknown>).description;
    } catch {
      unread.set(manifest.path, "not a JSON object");
      continue;
    }
    if (typeof description !== "string") continue;
    const at = linesOf(manifest.path).findIndex((line) => /"description"\s*:/.test(line));
    const range = at === -1 ? null : { start: at + 1, end: at + 1 };
    for (const chunk of looksSecret(description) ? [description] : chunks(description)) add(into, chunk, { source: "package description", path: manifest.path, range });
  }
  // A Markdown file or manifest the tree holds and the graph lacks is not of the same base: unread, never skipped.
  for (const path of base.tree.keys()) if (!files.has(path) && (posix.extname(path) === ".md" || posix.basename(path) === "package.json")) unread.set(path, "missing from the graph");

  // Merge, then drop by the written rules.
  const terms: Term[] = [];
  const dropped: { key: string; rule: DropRule }[] = [];
  for (const [key, list] of [...into.pins].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const words = key.split(" ");
    const rule: DropRule | undefined = key.length < MIN_KEY_CHARS || words.every((word) => /^\p{N}+$/u.test(word)) ? "short" : GENERIC_PHRASE_SET.has(key) || words.every((word) => GENERIC_WORD_SET.has(word)) ? "generic" : undefined;
    if (rule !== undefined) {
      dropped.push({ key, rule });
      continue;
    }
    const pins = [...new Map(list.map((pin) => [`${pin.path}\0${pin.range?.start ?? ""}\0${pin.range?.end ?? ""}\0${pin.source}\0${pin.written}`, pin])).values()];
    pins.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || (a.range?.start ?? 0) - (b.range?.start ?? 0) || (a.source < b.source ? -1 : a.source > b.source ? 1 : 0) || (a.written < b.written ? -1 : a.written > b.written ? 1 : 0));
    const counts = new Map<string, number>();
    for (const pin of pins) counts.set(pin.written, (counts.get(pin.written) ?? 0) + 1);
    const spellings = [...counts.keys()].sort();
    const name = spellings.reduce((best, one) => (counts.get(one)! > counts.get(best)! ? one : best));
    terms.push({ key, name, spellings, pins });
  }

  const unreadList = [...unread].map(([path, reason]) => ({ path, reason })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const result = { tableVersion: VOCABULARY_TABLE_VERSION, terms, dropped: { count: dropped.length, terms: dropped }, skipped, unread: unreadList, notAnalysed };
  if (terms.length > 0) return { ...result, status: "found" };
  if (unreadList.length > 0) return { ...result, status: "unknown", reason: `a file could not be read: ${unreadList.map((one) => one.path).join(", ")}` };
  if (notAnalysed > 0) return { ...result, status: "unknown", reason: `${notAnalysed} text file${notAnalysed === 1 ? " is" : "s are"} in a language no adapter reads` };
  return { ...result, status: "none" };
}
