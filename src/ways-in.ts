import { posix } from "node:path";
import type { FileTree, Graph, NodeId } from "./graph.ts";
import type { WayIn } from "./importance.ts";

/*
 * Ways in (SPEC, The graph): only what the repo declares. The files a package.json names in
 * `main`, `bin`, `exports` and its scripts, plus test files. Every package.json in the tree
 * counts, each relative to its own folder. Derived from the tree's text and the graph's files
 * alone, so the same tree always gives the same list. Where a script's syntax is not understood,
 * the command is skipped: nothing is ever guessed.
 */

/** What a script command starts a file with: only a command's own first word counts. */
const RUNNERS: ReadonlySet<string> = new Set(["node", "nodejs", "tsx", "ts-node", "ts-node-esm", "ts-node-dev", "babel-node", "vite-node", "bun", "deno", "nodemon"]);
/** The extensions `node file` and a script's runner try when the name has none; exports and bin never do. */
const EXTENSIONS = ["", ".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".jsx", ".tsx"];
/** The files Node tries for a `main` that is not an exact file (CJS resolution). */
const MAIN_TRIES = ["", ".js", ".json", ".node", "/index.js", "/index.json", "/index.node"];

const byCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Every string leaf of `value`, whatever the condition or nesting that holds it. */
function stringLeaves(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringLeaves);
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(stringLeaves);
  return [];
}

/** How a command chain joins to the next command: `&&`, `||` and `;` run in turn; `|` and `&` run in a subshell. */
type Joint = "seq" | "sub";
interface Simple {
  readonly words: readonly string[];
  /** The command's syntax is not understood: it is skipped, and a `cd` among it leaves the chain's directory unknown. */
  readonly bad: boolean;
  /** How this command is joined to the one before it. */
  readonly joint: Joint;
}

/**
 * Splits a script into simple commands with shell quoting (single, double, backslash). A command
 * holding `$`, a backtick, parentheses, redirections, braces, an unquoted glob or a quote that
 * never closes gets null words and is skipped.
 */
export function simpleCommands(script: string): Simple[] {
  const out: Simple[] = [];
  let words: string[] = [];
  let word: string | undefined;
  let bad = false;
  let joint: Joint = "seq";
  const endWord = (): void => {
    if (word !== undefined) words.push(word);
    word = undefined;
  };
  const endCommand = (next: Joint): void => {
    endWord();
    if (words.length > 0 || bad) out.push({ words, bad, joint });
    words = [];
    bad = false;
    joint = next;
  };
  for (let i = 0; i < script.length; i++) {
    const c = script[i]!;
    if (c === "'") {
      const close = script.indexOf("'", i + 1);
      if (close < 0) return [{ words: [], bad: true, joint: "seq" }];
      word = (word ?? "") + script.slice(i + 1, close);
      i = close;
    } else if (c === '"') {
      let text = "";
      let j = i + 1;
      for (; j < script.length && script[j] !== '"'; j++) {
        const d = script[j]!;
        if (d === "$" || d === "`") bad = true;
        if (d === "\\" && j + 1 < script.length) {
          j++;
          text += script[j]!;
        } else text += d;
      }
      if (j >= script.length) return [{ words: [], bad: true, joint: "seq" }];
      word = (word ?? "") + text;
      i = j;
    } else if (c === "\\") {
      if (i + 1 >= script.length) bad = true;
      else word = (word ?? "") + script[++i]!;
    } else if (c === "&" && script[i + 1] === "&") {
      endCommand("seq");
      i++;
    } else if (c === "|" && script[i + 1] === "|") {
      endCommand("seq");
      i++;
    } else if (c === ";" || c === "\n") endCommand("seq");
    else if (c === "|" || c === "&") endCommand("sub");
    else if (c === " " || c === "\t") endWord();
    else if ("$`()<>{}*?[]!~#".includes(c)) {
      bad = true;
      word = (word ?? "") + c;
    } else word = (word ?? "") + c;
  }
  endCommand("seq");
  return out;
}

/** Reads the package.json files of `tree` and the test files of `graph`: each way in once, with every reason. */
export function waysIn(tree: FileTree, graph: Graph): WayIn[] {
  const idOf = new Map<string, NodeId>();
  for (const node of graph.nodes) if (node.level === "file") idOf.set(node.path, node.id);
  const paths = [...idOf.keys()];
  const reasons = new Map<string, Set<string>>();
  const add = (path: string, reason: string): void => {
    reasons.set(path, (reasons.get(path) ?? new Set()).add(reason));
  };
  /** `spec` from `directory` as a path in the tree, undefined when it leaves the tree or is absolute. */
  const inTree = (directory: string, spec: string): string | undefined => {
    if (spec === "" || spec.startsWith("/") || spec.includes("\0")) return undefined;
    const base = posix.normalize(posix.join(directory, spec));
    return base.startsWith("../") || base === ".." || base.endsWith("/") ? undefined : base;
  };
  /** The file `spec` names from `directory`, as written or with one of `tries` appended. */
  const resolve = (directory: string, spec: string, tries: readonly string[]): string | undefined => {
    const base = inTree(directory, spec);
    if (base === undefined) return undefined;
    return tries.map((extra) => `${base}${extra}`).find((path) => idOf.has(path));
  };
  const directoryExists = (directory: string): boolean => directory === "." || paths.some((path) => path.startsWith(`${directory}/`));

  /** Every file an exports target names: itself, or for one `*` every file that fits, the star standing for any text. */
  const exported = (directory: string, target: string): string[] => {
    if (!target.startsWith("./")) return [];
    const stars = target.split("*").length - 1;
    if (stars === 0) {
      const file = resolve(directory, target, [""]);
      return file === undefined ? [] : [file];
    }
    if (stars > 1) return [];
    const [before, after] = target.split("*") as [string, string];
    const prefix = directory === "." ? before.slice(2) : `${directory}/${before.slice(2)}`;
    return paths.filter((path) => {
      if (path.split("/").includes("node_modules") || !path.startsWith(prefix) || !path.endsWith(after)) return false;
      return path.length >= prefix.length + after.length;
    });
  };

  /** Runs one script's commands, each from the directory the chain's `cd`s have reached. */
  const readScript = (directory: string, name: string, script: string): void => {
    let cwd: string | undefined = directory;
    for (const command of simpleCommands(script)) {
      if (command.bad) {
        if (command.words[0] === "cd" && command.joint === "seq") cwd = undefined;
        continue;
      }
      const words = [...command.words];
      while (words[0] !== undefined && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
      if (words[0] === "env") {
        words.shift();
        while (words[0] !== undefined && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || words[0].startsWith("-"))) words.shift();
      }
      const first = words[0];
      if (first === undefined || cwd === undefined) continue;
      if (first === "cd") {
        if (command.joint === "sub") continue;
        const target = words.length === 2 ? inTree(cwd, words[1]!) : undefined;
        cwd = target !== undefined && directoryExists(target) ? target : undefined;
        continue;
      }
      const reason = `package.json scripts.${name}`;
      if (RUNNERS.has(posix.basename(first)) && !first.includes("/")) {
        const args = words.slice(1);
        const many = args.includes("--test");
        for (const arg of args) {
          if (arg.startsWith("-")) continue;
          const file = resolve(cwd, arg, EXTENSIONS);
          if (file === undefined) continue;
          add(file, reason);
          if (!many) break;
        }
      } else if (first.startsWith("./") || first.startsWith("../")) {
        const file = resolve(cwd, first, [""]);
        if (file !== undefined) add(file, reason);
      }
    }
  };

  for (const [path, text] of tree) {
    if (posix.basename(path) !== "package.json" || !idOf.has(path)) continue;
    let manifest: unknown;
    try {
      manifest = JSON.parse(text);
    } catch {
      continue;
    }
    if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) continue;
    const table = manifest as Record<string, unknown>;
    const directory = posix.dirname(path);
    for (const spec of stringLeaves(table.main)) {
      const file = resolve(directory, spec, MAIN_TRIES);
      if (file !== undefined) add(file, "package.json main");
    }
    for (const spec of stringLeaves(table.bin)) {
      const file = resolve(directory, spec, [""]);
      if (file !== undefined) add(file, "package.json bin");
    }
    for (const target of stringLeaves(table.exports)) for (const file of exported(directory, target)) add(file, "package.json exports");
    if (typeof table.scripts === "object" && table.scripts !== null) {
      for (const [name, command] of Object.entries(table.scripts)) {
        if (typeof command === "string") readScript(directory, name, command);
      }
    }
  }
  for (const node of graph.nodes) if (node.level === "file" && node.role === "tests") add(node.path, "test file");

  return [...reasons]
    .map(([path, why]): WayIn => ({ id: idOf.get(path)!, path, reasons: [...why].sort(byCodeUnits) }))
    .sort((a, b) => byCodeUnits(a.path, b.path));
}
