import { createHash } from "node:crypto";
import { posix } from "node:path";
import { compareIds, nodeId, qualifiedName } from "../graph.ts";
import type { CodeNode, FileTree, Graph, ModuleNode, NodeId } from "../graph.ts";
import { countLines, lineRangeOf, lineStarts } from "../lines.ts";
import { adapterFor } from "./adapters.ts";
import { roleOf } from "./roles.ts";
import type { Declaration, LanguageAdapter, SourceFile } from "./adapters.ts";

export const EXTRACTOR_VERSION = "6";

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
    const outlines = adapter.analyse(files);
    for (const file of files) {
      analysed.add(file.path);
      nodes.push(...codeNodes(file.path, file.text, outlines.get(file.path) ?? []));
    }
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
      role: roleOf(path, analysed.has(path)),
      digest: digestOf(text),
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

// The only place code identity is decided: ordinals among siblings with the same text in source
// order, qualified names, and line ranges through lines.ts.
function codeNodes(path: string, text: string, declarations: readonly Declaration[]): CodeNode[] {
  const starts = lineStarts(text);
  const nodes: CodeNode[] = [];
  const visit = (siblings: readonly Declaration[], parent: NodeId, parentName: string): void => {
    const seen = new Map<string, number>();
    for (const declaration of [...siblings].sort((a, b) => a.start - b.start)) {
      const ordinal = (seen.get(declaration.text) ?? 0) + 1;
      seen.set(declaration.text, ordinal);
      const name = qualifiedName(parentName, declaration.text, ordinal);
      const id = nodeId(declaration.level, path, name);
      nodes.push({
        id,
        level: declaration.level,
        path,
        name: ordinal > 1 ? `${declaration.text} (${ordinal})` : declaration.text,
        parent,
        qualifiedName: name,
        range: lineRangeOf(starts, declaration.start, declaration.end),
        digest: digestOf(text.slice(declaration.start, declaration.end)),
      });
      visit(declaration.children, id, name);
    }
  };
  visit(declarations, nodeId("file", path, ""), "");
  return nodes;
}

// node:crypto stays here, out of graph.ts, which the page bundles.
function digestOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 32);
}

function directoryOf(path: string): string {
  const dir = posix.dirname(path);
  return dir === "." ? "" : dir;
}
