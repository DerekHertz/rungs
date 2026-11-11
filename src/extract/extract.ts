import { createHash } from "node:crypto";
import { posix } from "node:path";
import { DEPENDENCY_LISTS, compareEdges, compareIds, compareImports, compareResolutions, compareSections, nodeId, qualifiedName, resourceId } from "../graph.ts";
import type { CodeNode, Dependency, Edge, ImportEdge, FileTree, Graph, Manifest, ModuleNode, NodeId, ResolutionEdge, SectionNode, TypeContract } from "../graph.ts";
import { countLines, isBinary, lineRangeOf, lineStarts } from "../lines.ts";
import { adapterFor } from "./adapters.ts";
import { markdownSections } from "./markdown.ts";
import { roleOf } from "./roles.ts";
import type { Declaration, EffectSite, ImportSite, LanguageAdapter, ResolutionSite, SourceFile } from "./adapters.ts";

export const EXTRACTOR_VERSION = "20";

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
  const sections: SectionNode[] = [];
  const edges: Edge[] = [];
  const resolutions: ResolutionEdge[] = [];
  const imports: ImportEdge[] = [];
  const analysed = new Set<string>();
  const typesByPath = new Map<string, readonly TypeContract[]>();
  for (const [adapter, files] of filesByAdapter) {
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const outlines = adapter.analyse(files, tree);
    for (const file of files) {
      analysed.add(file.path);
      typesByPath.set(file.path, outlines.get(file.path)?.types ?? []);
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
    if (posix.extname(path) === ".md" && !isBinary(text)) sections.push(...sectionNodes(path, text));
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
      ...(analysed.has(path) ? { types: typesByPath.get(path) ?? [] } : {}),
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
  sections.sort(compareSections);
  return { extractorVersion: EXTRACTOR_VERSION, nodes, edges, resolutions, imports, sections, manifests: manifestsOf(tree) };
}

// Dependencies as package.json writes them, one record per manifest. A file that is not a JSON
// object is unreadable and declares nothing; an entry whose range is not a string is declared with a null range.
function manifestsOf(tree: FileTree): Manifest[] {
  const manifests: Manifest[] = [];
  for (const [path, text] of tree) {
    if (posix.basename(path) !== "package.json") continue;
    const file = nodeId("file", path, "");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
    } catch {
      manifests.push({ file, path, readable: false, declared: [] });
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      manifests.push({ file, path, readable: false, declared: [] });
      continue;
    }
    const declared: Dependency[] = [];
    for (const list of DEPENDENCY_LISTS) {
      const section = (parsed as Record<string, unknown>)[list];
      if (typeof section !== "object" || section === null || Array.isArray(section)) continue;
      for (const [name, range] of Object.entries(section)) {
        declared.push({ name, range: typeof range === "string" ? range : null, list });
      }
    }
    declared.sort((a, b) => DEPENDENCY_LISTS.indexOf(a.list) - DEPENDENCY_LISTS.indexOf(b.list) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    manifests.push({ file, path, readable: true, declared });
  }
  return manifests.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// The only place code identity is decided: ordinals among siblings with the same text in source
// order, qualified names, and line ranges through lines.ts.
export function codeNodes(path: string, text: string, declarations: readonly Declaration[]): CodeNodes {
  const starts = lineStarts(text);
  const nodes: CodeNode[] = [];
  const spans: Span[] = [];
  const byStart = new Map<number, NodeId>();
  const visit = (siblings: readonly Declaration[], parent: NodeId, parentName: string, depth: number): void => {
    const seen = new Map<string, number>();
    for (const declaration of [...siblings].sort((a, b) => a.start - b.start)) {
      // Constants count apart, so one never moves the ordinal of a function or class of the same name.
      const key = declaration.level === "constant" ? `\0${declaration.text}` : declaration.text;
      const ordinal = (seen.get(key) ?? 0) + 1;
      seen.set(key, ordinal);
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
        ...(declaration.exportedAs === undefined ? {} : { exportedAs: declaration.exportedAs }),
        signature: declaration.signature,
      });
      // A constant owns no effects: a call in its initializer runs at module top level, as before.
      if (declaration.level !== "constant") {
        spans.push({ id, start: declaration.start, end: declaration.end, depth });
        byStart.set(declaration.start, id);
      }
      visit(declaration.children, id, name, depth + 1);
    }
  };
  visit(declarations, nodeId("file", path, ""), "", 1);
  return { nodes, spans, byStart };
}

// A section's identity is decided here, like a code node's: ordinals among siblings with the same
// heading text in source order, and the qualified name from the heading path.
function sectionNodes(path: string, text: string): SectionNode[] {
  const nodes: SectionNode[] = [];
  const stack: { level: number; id: NodeId; name: string; seen: Map<string, number> }[] = [];
  const topSeen = new Map<string, number>();
  for (const heading of markdownSections(text)) {
    while (stack.length > 0 && stack.at(-1)!.level >= heading.level) stack.pop();
    const parent = stack.at(-1);
    const seen = parent?.seen ?? topSeen;
    const ordinal = (seen.get(heading.text) ?? 0) + 1;
    seen.set(heading.text, ordinal);
    const name = qualifiedName(parent?.name ?? "", heading.text, ordinal);
    const id = nodeId("section", path, name);
    nodes.push({
      id,
      level: "section",
      path,
      name: ordinal > 1 ? `${heading.text} (${ordinal})` : heading.text,
      heading: heading.text,
      parent: parent?.id ?? nodeId("file", path, ""),
      headingLevel: heading.level,
      qualifiedName: name,
      range: { start: heading.start, end: heading.end },
    });
    stack.push({ level: heading.level, id, name, seen: new Map() });
  }
  return nodes;
}

export interface Span {
  readonly id: NodeId;
  readonly start: number;
  readonly end: number;
  readonly depth: number;
}

export interface CodeNodes {
  readonly nodes: CodeNode[];
  readonly spans: readonly Span[];
  /** The id of each class or function by the offset its declaration starts at; constants are left out. */
  readonly byStart: ReadonlyMap<number, NodeId>;
}

// An effect belongs to the innermost class or function whose text contains the whole call, and
// to the file when none does: module top level, which runs when the file is imported.
export const ownerOf = (path: string, site: { start: number; end: number }, spans: readonly Span[]): NodeId => {
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
    names: site.names,
    ...(site.reexports === undefined ? {} : { reexports: site.reexports }),
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
