import { posix } from "node:path";
import type { FileTree, Graph, NodeId } from "./graph.ts";
import type { WayIn } from "./importance.ts";

/*
 * Ways in (SPEC, The graph): only what the repo declares. The files a package.json names in
 * `main`, `bin`, `exports` and its scripts, plus test files. Every package.json in the tree
 * counts, each relative to its own folder. Derived from the tree's text and the graph's files
 * alone, so the same tree always gives the same list.
 */


/** What a script command starts a file with. */
const RUNNERS: ReadonlySet<string> = new Set(["node", "nodejs", "tsx", "ts-node", "ts-node-esm", "ts-node-dev", "babel-node", "vite-node", "bun", "deno", "nodemon"]);
const EXTENSIONS = ["", ".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".jsx", ".tsx"];

const byCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Every string leaf of `value`, whatever the condition or nesting that holds it. */
function stringLeaves(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringLeaves);
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(stringLeaves);
  return [];
}

/** The words of a script that may name a file to run: the non-flag words after a runner, split at shell operators. */
export function scriptFiles(script: string): string[] {
  const found: string[] = [];
  for (const segment of script.split(/&&|\|\||[;|&]/)) {
    const words = segment.trim().split(/\s+/).map((word) => word.replace(/^["']|["']$/g, ""));
    const runner = words.findIndex((word) => RUNNERS.has(posix.basename(word)));
    if (runner < 0) continue;
    for (const word of words.slice(runner + 1)) if (word !== "" && !word.startsWith("-") && !word.includes("*")) found.push(word);
  }
  return found;
}

/** Reads the package.json files of `tree` and the test files of `graph`: each way in once, with every reason. */
export function waysIn(tree: FileTree, graph: Graph): WayIn[] {
  const idOf = new Map<string, NodeId>();
  for (const node of graph.nodes) if (node.level === "file") idOf.set(node.path, node.id);
  const reasons = new Map<string, Set<string>>();
  const add = (path: string, reason: string): void => {
    reasons.set(path, (reasons.get(path) ?? new Set()).add(reason));
  };
  /** The file `spec` names from `directory`, if the tree has it: as written, or with a script extension. */
  const resolve = (directory: string, spec: string): string | undefined => {
    if (spec.startsWith("/") || spec.includes("\0")) return undefined;
    const base = posix.normalize(posix.join(directory, spec));
    if (base.startsWith("../") || base === ".." || base.endsWith("/")) return undefined;
    for (const extension of EXTENSIONS) if (idOf.has(`${base}${extension}`)) return `${base}${extension}`;
    return undefined;
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
    const named = (field: string, specs: string[]): void => {
      for (const spec of specs) {
        const file = resolve(directory, spec);
        if (file !== undefined) add(file, `package.json ${field}`);
      }
    };
    named("main", stringLeaves(table.main));
    named("bin", stringLeaves(table.bin));
    named("exports", stringLeaves(table.exports));
    if (typeof table.scripts === "object" && table.scripts !== null) {
      for (const [name, command] of Object.entries(table.scripts)) {
        if (typeof command === "string") named(`scripts.${name}`, scriptFiles(command));
      }
    }
  }
  for (const node of graph.nodes) if (node.level === "file" && node.role === "tests") add(node.path, "test file");

  return [...reasons]
    .map(([path, why]): WayIn => ({ id: idOf.get(path)!, path, reasons: [...why].sort(byCodeUnits) }))
    .sort((a, b) => byCodeUnits(a.path, b.path));
}
