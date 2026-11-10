import { posix } from "node:path";
import { compareIds, nodeId } from "../graph.ts";
import type { FileTree, Graph, ModuleNode, NodeId } from "../graph.ts";
import { adapterFor } from "./adapters.ts";

export const EXTRACTOR_VERSION = "1";

export function extract(tree: FileTree): Graph {
  const packageDirs = new Set([""]);
  for (const path of tree.keys()) {
    if (posix.basename(path) === "package.json") packageDirs.add(directoryOf(path));
  }
  const directoryId = (dir: string): NodeId =>
    nodeId(packageDirs.has(dir) ? "package" : "folder", dir, "");

  const nodes: ModuleNode[] = [];
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
      analysis: adapterFor(path) === undefined ? "not analysed" : "analysed",
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

function countLines(text: string): number {
  if (text === "") return 0;
  const newlines = text.split("\n").length - 1;
  return text.endsWith("\n") ? newlines : newlines + 1;
}
