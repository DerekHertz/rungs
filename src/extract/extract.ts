import { posix } from "node:path";
import { compareIds, nodeId } from "../graph.ts";
import type { FileTree, Graph, ModuleNode, NodeId } from "../graph.ts";
import { countLines } from "../lines.ts";
import { adapterFor } from "./adapters.ts";
import type { LanguageAdapter, SourceFile } from "./adapters.ts";

export const EXTRACTOR_VERSION = "2";

const GENERATED_BASENAMES: ReadonlySet<string> = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
]);

export function extract(tree: FileTree): Graph {
  const packageDirs = new Set([""]);
  for (const path of tree.keys()) {
    if (posix.basename(path) === "package.json") packageDirs.add(directoryOf(path));
  }
  const directoryId = (dir: string): NodeId =>
    nodeId(packageDirs.has(dir) ? "package" : "folder", dir, "");

  const filesByAdapter = new Map<LanguageAdapter, SourceFile[]>();
  for (const [path, text] of tree) {
    const adapter = adapterFor(path);
    if (adapter === undefined) continue;
    const files = filesByAdapter.get(adapter) ?? [];
    files.push({ path, text });
    filesByAdapter.set(adapter, files);
  }
  const nodes: ModuleNode[] = [];
  const analysed = new Set<string>();
  for (const [adapter, files] of filesByAdapter) {
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    nodes.push(...adapter.analyse(files));
    for (const file of files) analysed.add(file.path);
  }

  const directoryLines = new Map<string, number>([["", 0]]);
  for (const [path, text] of tree) {
    const lines = countLines(text);
    nodes.push({
      id: nodeId("file", path, ""),
      level: "file",
      path,
      name: posix.basename(path),
      parent: directoryId(directoryOf(path)),
      lines,
      analysis: analysed.has(path) ? "analysed" : "not analysed",
      generated: GENERATED_BASENAMES.has(posix.basename(path)),
    });
    for (let dir = path; dir !== ""; ) {
      dir = directoryOf(dir);
      directoryLines.set(dir, (directoryLines.get(dir) ?? 0) + lines);
    }
  }
  for (const [dir, lines] of directoryLines) {
    nodes.push({
      id: directoryId(dir),
      level: packageDirs.has(dir) ? "package" : "folder",
      path: dir,
      name: posix.basename(dir),
      parent: dir === "" ? null : directoryId(directoryOf(dir)),
      lines,
    });
  }
  nodes.sort((a, b) => compareIds(a.id, b.id));
  return { extractorVersion: EXTRACTOR_VERSION, nodes };
}

function directoryOf(path: string): string {
  const dir = posix.dirname(path);
  return dir === "." ? "" : dir;
}
