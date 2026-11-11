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

/** The files Node tries for a `main` that is not an exact file (CJS resolution); `node file` tries the same. */
const MAIN_TRIES = ["", ".js", ".json", ".node", "/index.js", "/index.json", "/index.node"];
const TS_TRIES = ["", ".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx"];

interface Runner {
  /** What the runner appends to a script name that is not a file, in order; only what its own documentation says. */
  readonly tries: readonly string[];
  /** Options that take the next word as their value; any other option is taken to be a flag alone, or `--name=value`. */
  readonly valued: ReadonlySet<string>;
  /** Options after which the command runs something that is not a file: the command is skipped. */
  readonly inline: ReadonlySet<string>;
  /** Words that may come before the script: `deno run app.ts`, `bun run app.ts`. */
  readonly subcommands: ReadonlySet<string>;
  /** Whether `--test` before the script makes every following word a file. */
  readonly testFlag: boolean;
}
const runner = (r: Partial<Runner>): Runner => ({ tries: [""], valued: new Set(), inline: new Set(), subcommands: new Set(), testFlag: false, ...r });
const NODE_VALUED = ["-r", "--require", "--import", "--loader", "--experimental-loader", "--env-file", "--conditions", "-C", "--input-type", "--title", "--stack-trace-limit", "--max-old-space-size", "--watch-path", "--test-reporter", "--test-reporter-destination", "--test-name-pattern", "--test-concurrency", "--disable-warning"];
const NODE_INLINE = ["-e", "--eval", "-p", "--print", "-c", "--check", "-i", "--interactive"];
/** What a script command starts a file with: only a command's own first word counts, and each runner has its own options and name tries. */
const RUNNERS: ReadonlyMap<string, Runner> = new Map([
  ["node", runner({ tries: MAIN_TRIES, valued: new Set(NODE_VALUED), inline: new Set(NODE_INLINE), testFlag: true })],
  ["nodejs", runner({ tries: MAIN_TRIES, valued: new Set(NODE_VALUED), inline: new Set(NODE_INLINE), testFlag: true })],
  ["nodemon", runner({ tries: MAIN_TRIES, valued: new Set(["-w", "--watch", "-i", "--ignore", "-e", "--ext", "-d", "--delay", "-C", "--config", "--require", "-r", "--import"]), inline: new Set(["-x", "--exec"]) })],
  ["tsx", runner({ tries: TS_TRIES, valued: new Set(["--tsconfig", "-r", "--require", "--import", "--env-file", "--ignore", "--conditions"]), inline: new Set(["-e", "--eval", "-p", "--print"]) })],
  ["ts-node", runner({ tries: TS_TRIES, valued: new Set(["-P", "--project", "-r", "--require", "-O", "--compiler-options", "-C", "--compiler", "--cwd", "--dir"]), inline: new Set(["-e", "--eval", "-p", "--print"]) })],
  ["ts-node-esm", runner({ tries: TS_TRIES, valued: new Set(["-P", "--project", "-r", "--require", "-O", "--compiler-options", "--cwd", "--dir"]), inline: new Set(["-e", "--eval", "-p", "--print"]) })],
  ["ts-node-dev", runner({ tries: TS_TRIES, valued: new Set(["-r", "--require", "--project", "-P", "--watch", "--ignore-watch", "--debounce", "--interval"]) })],
  ["babel-node", runner({ tries: ["", ".js", ".jsx", ".mjs", ".cjs"], valued: new Set(["-r", "--require", "--presets", "--plugins", "-x", "--extensions"]), inline: new Set(["-e", "--eval", "-p", "--print"]) })],
  ["vite-node", runner({ tries: TS_TRIES, valued: new Set(["-r", "--root", "-c", "--config", "-m", "--mode", "--base"]) })],
  ["bun", runner({ tries: TS_TRIES, valued: new Set(["-r", "--preload", "--import", "--tsconfig-override", "--env-file", "--cwd", "-c", "--config"]), inline: new Set(["-e", "--eval", "-p", "--print"]), subcommands: new Set(["run"]) })],
  ["deno", runner({ valued: new Set(["-c", "--config", "--import-map", "--lock", "--env-file"]), subcommands: new Set(["run"]) })],
]);

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
        // In double quotes a backslash escapes only $, a backtick, a double quote, a backslash and a newline.
        if (d === "\\" && j + 1 < script.length && '$`"\\\n'.includes(script[j + 1]!)) {
          j++;
          if (script[j] !== "\n") text += script[j]!;
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
    } else if (c === "#" && word === undefined) {
      // A # that starts a word is a comment to the end of the line.
      while (i + 1 < script.length && script[i + 1] !== "\n") i++;
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
  /** `spec` from `directory` as a path in the tree, undefined when it leaves the tree or is absolute; `folder` when it ends in a slash or is the directory itself. */
  const spotOf = (directory: string, spec: string): { readonly base: string; readonly folder: boolean } | undefined => {
    if (spec === "" || spec.startsWith("/") || spec.includes("\0")) return undefined;
    const joined = posix.normalize(posix.join(directory, spec));
    if (joined.startsWith("../") || joined === "..") return undefined;
    const base = joined.endsWith("/") && joined.length > 1 ? joined.slice(0, -1) : joined;
    return { base: base === "./" ? "." : base, folder: joined.endsWith("/") || base === "." };
  };
  const inTree = (directory: string, spec: string): string | undefined => spotOf(directory, spec)?.base;
  /** The file `spec` names from `directory`, as written or with one of `tries` appended; a folder only takes the tries that go inside it. */
  const resolve = (directory: string, spec: string, tries: readonly string[]): string | undefined => {
    const spot = spotOf(directory, spec);
    if (spot === undefined) return undefined;
    return tries
      .filter((extra) => !spot.folder || extra.startsWith("/"))
      .map((extra) => (spot.base === "." ? extra.slice(1) : `${spot.base}${extra}`))
      .find((path) => idOf.has(path));
  };
  const directoryExists = (directory: string): boolean => directory === "." || paths.some((path) => path.startsWith(`${directory}/`));

  /**
   * Every file a package's `exports` names. Under subpath keys, a subpath goes to the most
   * specific key that matches it (Node's order: an exact key, else the longest pattern prefix),
   * so a `null` target or a narrower key takes files out of a wider pattern.
   */
  const exportedFiles = (directory: string, value: unknown): string[] => {
    const entries =
      typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length > 0 && Object.keys(value).every((key) => key.startsWith("."))
        ? Object.entries(value)
        : [[".", value] as [string, unknown]];
    const keys = entries.map(([key]) => key);
    const winnerOf = (subpath: string): string | undefined => {
      if (keys.includes(subpath) && !subpath.includes("*")) return subpath;
      let best: string | undefined;
      let bestPrefix = -1;
      for (const key of keys) {
        const star = key.indexOf("*");
        if (star < 0 || key.indexOf("*", star + 1) >= 0) continue;
        const prefix = star;
        if (!subpath.startsWith(key.slice(0, star)) || !subpath.endsWith(key.slice(star + 1)) || subpath.length < key.length) continue;
        if (prefix > bestPrefix || (prefix === bestPrefix && key.length > best!.length)) {
          best = key;
          bestPrefix = prefix;
        }
      }
      return best;
    };
    const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const found = new Set<string>();
    for (const [key, targets] of entries) {
      const keyStars = key.split("*").length - 1;
      if (keyStars > 1) continue;
      for (const target of stringLeaves(targets)) {
        if (!target.startsWith("./")) continue;
        if (keyStars === 0 || !target.includes("*")) {
          const file = resolve(directory, target, [""]);
          if (file !== undefined) found.add(file);
          continue;
        }
        // One text stands for every * of the target, and the subpath it makes must belong to this key.
        const parts = target.slice(2).split("*");
        const prefix = directory === "." ? "" : `${directory}/`;
        const pattern = new RegExp(`^${escape(prefix + parts[0]!)}${parts.slice(1).map((part, index) => `${index === 0 ? "(.+)" : "\\1"}${escape(part)}`).join("")}$`, "s");
        for (const path of paths) {
          if (path.split("/").includes("node_modules")) continue;
          const match = pattern.exec(path);
          if (match !== null && winnerOf(key.replace("*", match[1]!)) === key) found.add(path);
        }
      }
    }
    return [...found];
  };

  /** Runs one script's commands, each from the directory the chain's `cd`s have reached. */
  const readScript = (directory: string, name: string, script: string): void => {
    let cwd: string | undefined = directory;
    const commands = simpleCommands(script);
    commands.forEach((command, index) => {
      // A command piped or put in the background, on either side of it, runs in a subshell: a `cd` there moves nothing.
      const apart = command.joint === "sub" || commands[index + 1]?.joint === "sub";
      if (command.bad) {
        if (command.words[0] === "cd" && !apart) cwd = undefined;
        return;
      }
      const words = [...command.words];
      while (words[0] !== undefined && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
      if (words[0] === "env") {
        words.shift();
        while (words[0] !== undefined && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || words[0].startsWith("-"))) words.shift();
      }
      const first = words[0];
      if (first === undefined || cwd === undefined) return;
      if (first === "cd") {
        if (apart) return;
        const target = words.length === 2 ? inTree(cwd, words[1]!) : undefined;
        cwd = target !== undefined && directoryExists(target) ? target : undefined;
        return;
      }
      const reason = `package.json scripts.${name}`;
      const runs = RUNNERS.get(first);
      if (runs !== undefined) {
        // The runner's own options come first, then the script; whatever follows the script is its arguments.
        const args = words.slice(1);
        let tests = false;
        let named = false;
        let i = 0;
        for (; i < args.length; i++) {
          const arg = args[i]!;
          if (arg === "--") {
            i++;
            break;
          }
          if (!arg.startsWith("-") || arg === "-") {
            if (!named && runs.subcommands.has(arg)) {
              named = true;
              continue;
            }
            break;
          }
          const flag = arg.includes("=") && arg.startsWith("--") ? arg.slice(0, arg.indexOf("=")) : arg;
          if (runs.inline.has(flag)) return;
          if (flag === "--test" && runs.testFlag) tests = true;
          else if (runs.valued.has(arg)) i++;
        }
        const rest = args.slice(i);
        for (const arg of tests ? rest : rest.slice(0, 1)) {
          if (arg.startsWith("-")) continue;
          const file = resolve(cwd, arg, runs.tries);
          if (file !== undefined) add(file, reason);
        }
      } else if (first.includes("/") && !first.startsWith("/")) {
        const file = resolve(cwd, first, [""]);
        if (file !== undefined) add(file, reason);
      }
    });
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
    for (const file of exportedFiles(directory, table.exports)) add(file, "package.json exports");
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
