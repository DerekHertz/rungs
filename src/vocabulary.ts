import { posix } from "node:path";
import ts from "typescript";
import { scriptKind } from "./extract/javascript.ts";
import type { FileNode, LineRange, SectionNode } from "./graph.ts";
import { isCodeNode } from "./graph.ts";
import { splitLines } from "./lines.ts";
import { roleOf } from "./extract/roles.ts";
import { looksSecret } from "./prompt-safe.ts";
import { isTestFile } from "./test-files.ts";
import type { BaseSide } from "./standards.ts";
import { GENERIC_PHRASES, GENERIC_WORDS, MAX_PHRASE_WORDS, MAX_WORD_CHARS, MIN_KEY_CHARS, NON_CODE_EXTENSIONS, NON_CODE_NAMES, STOP_WORDS, VOCABULARY_TABLE_VERSION } from "./vocabulary-table.ts";

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
  /** The concept: the stems (see `stem`) of its words, one space apart. It merges case, plural and separators, and is not always a word: show `name`. Unique among terms. */
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
  readonly dropped: { readonly count: number; readonly terms: readonly { readonly key: string; /** The spelling used most, since a key is a stem. */ readonly name: string; readonly rule: DropRule }[] };
  /** Written phrases that were not made terms, by why. Counts of phrases as written, so one term written twice counts twice. */
  readonly skipped: {
    /** More than MAX_PHRASE_WORDS words. */
    readonly tooLong: number;
    /** Shaped like a secret (looksSecret on the text as written): never kept. */
    readonly withheld: number;
    /** No words, or a word longer than MAX_WORD_CHARS. */
    readonly notAWord: number;
    /** Folders whose name starts with ".": tooling, not the repository's concepts. */
    readonly hiddenFolders: number;
    /** Files and folders whose role is "generated" (lockfiles, vendored, minified). */
    readonly generated: number;
    /** Test calls whose title is not a string literal (a variable, a template with a hole): its words cannot be read. */
    readonly notLiteral: number;
    /** Wildcard re-exports (`export * from "x"`): they name no export, so no term is made from the path. */
    readonly wildcard: number;
  };
  /** Files whose words could not be read, with why, sorted by path. */
  readonly unread: readonly Unread[];
  /** Text files no language adapter reads, in any role (a Python file under docs or tests too), other than data and plain repository files: their exported names and tests are not collected. */
  readonly notAnalysed: number;
  /** Why the status is "unknown", for display. */
  readonly reason?: string;
}

/**
 * A word's stem: the same string for its singular and its plural, by a few plain rules. It is not
 * always a word ("cache" and "caches" both give "cach"); a term's `key` is made of stems and its
 * `name` is what is shown. A heuristic for merging spellings, never a dictionary.
 *
 * Plural first: -ies after a consonant, then -ches -shes -xes -sses -uses and -zzes lose "es"
 * (caches, boxes, classes, statuses, quizzes), any other -s is dropped (cases, sizes, keys).
 * Then -y after a consonant becomes -i (policy, policies) and a final silent -e goes (cache, case,
 * size), so a singular with an -e meets its plural.
 */
export function stem(word: string): string {
  let w = word;
  if (w.length > 3 && w.endsWith("s") && !/(?:ss|us|is)$/.test(w)) {
    if (/[^aeiou]ies$/.test(w)) w = `${w.slice(0, -3)}y`;
    else if (/(?:ch|sh|x|ss|us)es$/.test(w)) w = w.slice(0, -2);
    else if (/zzes$/.test(w)) w = w.slice(0, -3);
    else w = w.slice(0, -1);
  }
  if (/[^aeiou]y$/.test(w)) w = `${w.slice(0, -1)}i`;
  else if (w.length >= 3 && w.endsWith("e") && !w.endsWith("ee")) w = w.slice(0, -1);
  return w;
}

const WORD = /\p{Lu}+(?=\p{Lu}\p{Ll})|\p{Lu}?\p{Ll}+|\p{Lu}+|\p{Lo}+|\p{N}+/gu;

/** The words of a written phrase, lower case: split at separators, at camelCase and at digits. */
export function wordsOf(written: string): string[] {
  return (written.replace(/['’]/g, "").match(WORD) ?? []).map((word) => word.toLowerCase());
}

/** The key a phrase is a term under: the stems of its words, one space apart. For looking a term up by what a person would write ("config file"). */
export const keyOf = (phrase: string): string => wordsOf(phrase).map(stem).join(" ");

const STOP_SET: ReadonlySet<string> = new Set(STOP_WORDS);
/** The table's generic words and phrases as keys are made: stemmed, so "utils" and "util" are both caught. */
const GENERIC_WORD_SET: ReadonlySet<string> = new Set(GENERIC_WORDS.map(stem));
const GENERIC_PHRASE_SET: ReadonlySet<string> = new Set(GENERIC_PHRASES.map(keyOf));
const STOP_STEM_SET: ReadonlySet<string> = new Set(STOP_WORDS.map(stem));

/** Whether a stem (see `stem`) is a stop word or a generic word: it says nothing about what a module is for. Narrowing code to candidate terms skips these. */
export const isFillerStem = (word: string): boolean => STOP_STEM_SET.has(word) || GENERIC_WORD_SET.has(word);

/** The written text as it may be shown: letters, digits and "_ . $ / -" only. */
const spelling = (written: string): string => written.replace(/[^\p{L}\p{N}_.$/ -]+/gu, " ").replace(/\s+/g, " ").trim();

/** A heading without its Markdown: link targets, emphasis, code ticks and HTML tags. */
const plainHeading = (heading: string): string => heading.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/<[^>]*>/g, "").replace(/[`*~]/g, "").trim();

interface Builder {
  /** By key; `longest` is the length of its longest spelling's words before stemming, which is what "too short" is judged on. */
  readonly pins: Map<string, { longest: number; pins: TermPin[] }>;
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
  const key = words.map(stem).join(" ");
  const pin: TermPin = { ...where, written: spelling(written) };
  const found = into.pins.get(key);
  if (found === undefined) into.pins.set(key, { longest: words.join(" ").length, pins: [pin] });
  else {
    found.longest = Math.max(found.longest, words.join(" ").length);
    found.pins.push(pin);
  }
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

const TEST_CALLEES: ReadonlySet<string> = new Set(["test", "it", "describe", "suite", "context"]);
const TEST_MODIFIERS: ReadonlySet<string> = new Set(["only", "skip", "todo", "fails", "concurrent", "sequential"]);

/** `test`, `it.only`, `describe.skip`, `it.concurrent.skip`: a test runner's name for a test or a group. */
function isTestCallee(expression: ts.Expression): boolean {
  if (ts.isIdentifier(expression)) return TEST_CALLEES.has(expression.text);
  return ts.isPropertyAccessExpression(expression) && TEST_MODIFIERS.has(expression.name.text) && isTestCallee(expression.expression);
}

/** One call of a test runner: its title when the first argument is a string literal, else undefined (a name, a template with a hole). */
interface TestCall {
  readonly title: string | undefined;
  readonly range: LineRange;
}

/**
 * The test calls of a script, read from its syntax tree, so a call written in a comment or a
 * string is not one, and the title is the call's own first argument whatever its callback is (or
 * whether it has one: `test.todo("x")`).
 */
function testCalls(path: string, text: string): TestCall[] {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(path));
  const found: TestCall[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.arguments.length > 0 && isTestCallee(node.expression)) {
      const arg = node.arguments[0]!;
      const start = arg.getStart(file);
      const range = { start: file.getLineAndCharacterOfPosition(start).line + 1, end: file.getLineAndCharacterOfPosition(Math.max(start, arg.getEnd() - 1)).line + 1 };
      found.push({ title: ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg) ? arg.text : undefined, range });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The first line from `from` to `to` (1-based, both included) that `holds`, or null: no line is ever guessed. */
function firstLine(lines: readonly string[], from: number, to: number, holds: (line: string) => boolean): number | null {
  for (let at = Math.max(1, from); at <= Math.min(to, lines.length); at++) if (holds(lines[at - 1]!)) return at;
  return null;
}

const oneLine = (line: number | null): LineRange | null => (line === null ? null : { start: line, end: line });

/**
 * The lines of the top-level `key` of a JSON object, from the key to the end of its value, or null
 * when it has none. Read by walking the text, so a nested key of the same name is not taken for it.
 */
function topLevelKey(text: string, key: string): LineRange | null {
  let depth = 0;
  let line = 1;
  let found: LineRange | null = null;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === "\n") line++;
    else if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") depth--;
    else if (char === '"') {
      let end = i + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      const start = line;
      if (depth === 1 && text.slice(i + 1, end) === key) {
        let at = end + 1;
        let now = line;
        const skip = (): void => {
          while (at < text.length && /\s/.test(text[at]!)) now += text[at++] === "\n" ? 1 : 0;
        };
        skip();
        if (text[at] === ":") {
          at++;
          skip();
          found = { start, end: now };
        }
      }
      i = end;
    }
  }
  return found;
}

/** Every term the repository's own words give, pinned, with what could not be read counted. `undefined` is a base that could not be read: unknown, never none. */
export function collectVocabulary(base: BaseSide | undefined): Vocabulary {
  const empty = { count: 0, terms: [] };
  const skipped = { tooLong: 0, withheld: 0, notAWord: 0, hiddenFolders: 0, generated: 0, notLiteral: 0, wildcard: 0 };
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
  const nonCode: ReadonlySet<string> = new Set(NON_CODE_EXTENSIONS);
  const plainNames: ReadonlySet<string> = new Set(NON_CODE_NAMES);

  // A file's words may be collected when it is in the graph and the tree, is text and is not generated. Why not is recorded once.
  const checked = new Map<string, boolean>();
  const canRead = (path: string, needsParse: boolean): boolean => {
    let ok = checked.get(path);
    if (ok === undefined) {
      const file = files.get(path);
      let reason: string | undefined;
      if (file === undefined) reason = "missing from the graph";
      else if (!base.tree.has(path)) reason = "missing from the tree";
      else if (file.role === "generated") skipped.generated++;
      else if (file.lines === null) reason = "binary";
      if (reason !== undefined) unread.set(path, reason);
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

  // Every file that could hold words and was not read is counted, so a short list never reads as a complete one.
  let notAnalysed = 0;
  for (const file of files.values()) {
    const extension = posix.extname(file.path).toLowerCase();
    if (extension === ".md" || (file.lines === null && !nonCode.has(extension)) || file.analysis === "not fully read") canRead(file.path, file.analysis === "not fully read");
    else if (file.analysis === "not analysed" && file.lines !== null && file.role !== "generated" && !nonCode.has(extension) && !plainNames.has(posix.basename(file.path).toLowerCase())) notAnalysed++;
  }

  // Folders and package directories: a folder has a name and no lines.
  for (const node of base.graph.nodes) {
    if (node.level !== "folder" && !(node.level === "package" && node.path !== "")) continue;
    if (node.path.split("/").some((segment) => segment.startsWith("."))) skipped.hiddenFolders++;
    else if (roleOf(`${node.path}/x`, false) === "generated") skipped.generated++;
    else add(into, node.name, { source: "folder", path: node.path, range: null });
  }

  // Markdown headings, each pinned to every line of the heading: one for a "#" heading, the text and its underline for the other kind.
  const sectionsBy = new Map<string, SectionNode[]>();
  for (const section of base.graph.sections) sectionsBy.set(section.path, [...(sectionsBy.get(section.path) ?? []), section]);
  for (const [path, sections] of sectionsBy) {
    if (!canRead(path, false)) continue;
    const lines = linesOf(path);
    for (const section of sections) {
      let end = section.range.start;
      if (!/^\s{0,3}#/.test(lines[section.range.start - 1] ?? "")) {
        for (let at = section.range.start + 1; at <= section.range.end && (lines[at - 1] ?? "").trim() !== ""; at++) {
          if (/^\s{0,3}(?:=+|-+)\s*$/.test(lines[at - 1]!)) {
            end = at;
            break;
          }
        }
      }
      add(into, plainHeading(section.heading), { source: "heading", path, range: { start: section.range.start, end } });
    }
  }

  // Exported names, in any file. A name is pinned to a line that writes it, and to none when no line does.
  for (const node of base.graph.nodes) {
    if (!isCodeNode(node) || !canRead(node.path, true)) continue;
    const lines = linesOf(node.path);
    if (!node.exported) continue;
    const names = new Set((node.exportedAs ?? []).filter((name) => name !== "*" && name !== "default"));
    if (node.exportedAs === undefined || node.exportedAs.includes("default") || node.exportedAs.includes("*")) names.add(node.name);
    for (const name of names) {
      const holds = new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`);
      const writes = (text: string): boolean => holds.test(text);
      // The declared name is written in the declaration; an alias is written by the export statement, outside it.
      const line = name === node.name ? firstLine(lines, node.range.start, node.range.end, writes) : (firstLine(lines, 1, node.range.start - 1, writes) ?? firstLine(lines, node.range.end + 1, lines.length, writes));
      add(into, name, { source: "export", path: node.path, range: oneLine(line) });
    }
  }
  // Exported interfaces and type aliases, and re-exported names: the graph has their names and not their lines, so the text gives the line.
  for (const file of files.values()) {
    if (file.types === undefined || file.types.length === 0 || !canRead(file.path, true)) continue;
    const lines = linesOf(file.path);
    for (const type of file.types) {
      if (type.kind === "re-export") {
        if (type.name === "default") continue;
        // `export * from "x"` names no export, and the graph writes it as `* from "x"`: no term from a path.
        if (type.name.startsWith("* ")) {
          skipped.wildcard++;
          continue;
        }
        const holds = new RegExp(`(?<![\\w$])${escapeRegExp(type.name)}(?![\\w$])`);
        const edge = base.graph.imports.find((one) => one.from === file.id && one.reexports !== undefined && one.reexports !== "star" && one.reexports.some((entry) => entry.as === type.name));
        const line = firstLine(lines, edge?.range.start ?? 1, edge?.range.end ?? lines.length, (text) => holds.test(text));
        add(into, type.name, { source: "export", path: file.path, range: oneLine(line) });
        continue;
      }
      const declared = new RegExp(`\\b(?:interface|type)\\s+${escapeRegExp(type.name)}(?![\\w$])`);
      add(into, type.name, { source: "export", path: file.path, range: oneLine(firstLine(lines, 1, lines.length, (text) => declared.test(text))) });
    }
  }
  // Test titles, read from the test calls themselves: the call's literal first argument, whatever its callback; one that is no literal is counted.
  for (const file of files.values()) {
    if (!isTestFile(file.path) || file.analysis !== "analysed" || !canRead(file.path, true)) continue;
    for (const call of testCalls(file.path, base.tree.get(file.path)!)) {
      if (call.title === undefined) skipped.notLiteral++;
      else add(into, call.title, { source: "test", path: file.path, range: call.range });
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
    const range = topLevelKey(text, "description");
    for (const chunk of looksSecret(description) ? [description] : chunks(description)) add(into, chunk, { source: "package description", path: manifest.path, range });
  }
  // A Markdown file or manifest the tree holds and the graph lacks is not of the same base: unread, never skipped.
  for (const path of base.tree.keys()) if (!files.has(path) && (posix.extname(path) === ".md" || posix.basename(path) === "package.json")) unread.set(path, "missing from the graph");

  // Merge, then drop by the written rules.
  const terms: Term[] = [];
  const dropped: { key: string; name: string; rule: DropRule }[] = [];
  for (const [key, { longest, pins: list }] of [...into.pins].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const words = key.split(" ");
    const rule: DropRule | undefined = longest < MIN_KEY_CHARS || words.every((word) => /^\p{N}+$/u.test(word)) ? "short" : GENERIC_PHRASE_SET.has(key) || words.every((word) => GENERIC_WORD_SET.has(word)) ? "generic" : undefined;
    const pins = [...new Map(list.map((pin) => [`${pin.path}\0${pin.range?.start ?? ""}\0${pin.range?.end ?? ""}\0${pin.source}\0${pin.written}`, pin])).values()];
    pins.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || (a.range?.start ?? 0) - (b.range?.start ?? 0) || (a.source < b.source ? -1 : a.source > b.source ? 1 : 0) || (a.written < b.written ? -1 : a.written > b.written ? 1 : 0));
    const counts = new Map<string, number>();
    for (const pin of pins) counts.set(pin.written, (counts.get(pin.written) ?? 0) + 1);
    const spellings = [...counts.keys()].sort();
    const name = spellings.reduce((best, one) => (counts.get(one)! > counts.get(best)! ? one : best));
    if (rule !== undefined) dropped.push({ key, name, rule });
    else terms.push({ key, name, spellings, pins });
  }

  const unreadList = [...unread].map(([path, reason]) => ({ path, reason })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const result = { tableVersion: VOCABULARY_TABLE_VERSION, terms, dropped: { count: dropped.length, terms: dropped }, skipped, unread: unreadList, notAnalysed };
  if (terms.length > 0) return { ...result, status: "found" };
  if (unreadList.length > 0) return { ...result, status: "unknown", reason: `a file could not be read: ${unreadList.map((one) => one.path).join(", ")}` };
  if (notAnalysed > 0) return { ...result, status: "unknown", reason: `${notAnalysed} text file${notAnalysed === 1 ? " is" : "s are"} in a language no adapter reads` };
  if (skipped.notLiteral > 0) return { ...result, status: "unknown", reason: `${skipped.notLiteral} test title${skipped.notLiteral === 1 ? " is" : "s are"} not a string literal, so its words could not be read` };
  return { ...result, status: "none" };
}
