import { createHash } from "node:crypto";
import { posix } from "node:path";
import { compareEdges, compareIds, compareImports, compareResolutions, nodeId, qualifiedName, resourceId } from "../graph.ts";
import type { CodeNode, Edge, ImportEdge, FileTree, Graph, ModuleNode, NodeId, ResolutionEdge } from "../graph.ts";
import { countLines, isBinary, lineRangeOf, lineStarts } from "../lines.ts";
import { adapterFor } from "./adapters.ts";
import { roleOf } from "./roles.ts";
import type { Declaration, EffectSite, ImportSite, LanguageAdapter, ResolutionSite, SourceFile } from "./adapters.ts";

export const EXTRACTOR_VERSION = "14";

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
  const edges: Edge[] = [];
  const resolutions: ResolutionEdge[] = [];
  const imports: ImportEdge[] = [];
  const analysed = new Set<string>();
  for (const [adapter, files] of filesByAdapter) {
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const outlines = adapter.analyse(files, tree);
    for (const file of files) {
      analysed.add(file.path);
      const outline = outlines.get(file.path);
      const code = codeNodes(file.path, file.text, outline?.declarations ?? []);
      nodes.push(...code.nodes);
      edges.push(...effectEdges(file.path, file.text, outline?.effects ?? [], code.spans));
      resolutions.push(...resolutionEdges(file.path, file.text, outline?.resolutions ?? [], code.spans));
      imports.push(...importEdges(file.path, file.text, outline?.imports ?? []));
    }
  }

  const directoryLines = new Map<string, number>([["", 0]]);
  for (const [path, text] of tree) {
    const lines = isBinary(text) ? null : countLines(text);
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
      directoryLines.set(dir, (directoryLines.get(dir) ?? 0) + (lines ?? 0));
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
  edges.sort(compareEdges);
  resolutions.sort(compareResolutions);
  imports.sort(compareImports);
  return { extractorVersion: EXTRACTOR_VERSION, nodes, edges, resolutions, imports };
}

// The only place code identity is decided: ordinals among siblings with the same text in source
// order, qualified names, and line ranges through lines.ts.
function codeNodes(path: string, text: string, declarations: readonly Declaration[]): CodeNodes {
  const starts = lineStarts(text);
  const nodes: CodeNode[] = [];
  const spans: Span[] = [];
  const visit = (siblings: readonly Declaration[], parent: NodeId, parentName: string, depth: number): void => {
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
        exported: declaration.exported,
        signature: declaration.signature,
      });
      spans.push({ id, start: declaration.start, end: declaration.end, depth });
      visit(declaration.children, id, name, depth + 1);
    }
  };
  visit(declarations, nodeId("file", path, ""), "", 1);
  return { nodes, spans };
}

interface Span {
  readonly id: NodeId;
  readonly start: number;
  readonly end: number;
  readonly depth: number;
}

interface CodeNodes {
  readonly nodes: CodeNode[];
  readonly spans: readonly Span[];
}

// An effect belongs to the innermost class or function whose text contains the whole call, and
// to the file when none does: module top level, which runs when the file is imported.
const ownerOf = (path: string, site: { start: number; end: number }, spans: readonly Span[]): NodeId => {
  let owner: Span | undefined;
  for (const span of spans) {
    if (span.start <= site.start && site.end <= span.end && (owner === undefined || span.depth > owner.depth)) {
      owner = span;
    }
  }
  return owner?.id ?? nodeId("file", path, "");
};

function resolutionEdges(path: string, text: string, sites: readonly ResolutionSite[], spans: readonly Span[]): ResolutionEdge[] {
  const starts = lineStarts(text);
  return sites.map((site) => ({
    from: ownerOf(path, site, spans),
    operation: site.operation,
    args: site.args,
    range: lineRangeOf(starts, site.start, site.end),
  }));
}

// An import is owned by its file: the edge runs file to file, wherever in the file it sits.
function importEdges(path: string, text: string, sites: readonly ImportSite[]): ImportEdge[] {
  const starts = lineStarts(text);
  return sites.map((site) => ({
    from: nodeId("file", path, ""),
    specifier: site.specifier,
    syntax: site.syntax,
    typeOnly: site.typeOnly,
    target: "file" in site.target ? { file: nodeId("file", site.target.file, "") } : site.target,
    range: lineRangeOf(starts, site.start, site.end),
  }));
}

function effectEdges(path: string, text: string, sites: readonly EffectSite[], spans: readonly Span[]): Edge[] {
  const starts = lineStarts(text);
  return sites.map((site) => {
    return {
      kind: "effect",
      from: ownerOf(path, site, spans),
      to: resourceId(site.resource),
      operation: site.operation,
      target: site.target,
      args: site.args,
      range: lineRangeOf(starts, site.start, site.end),
    };
  });
}

// node:crypto stays here, out of graph.ts, which the page bundles.
export function digestOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 32);
}

function directoryOf(path: string): string {
  const dir = posix.dirname(path);
  return dir === "." ? "" : dir;
}
