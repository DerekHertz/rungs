export type Level = "package" | "folder" | "file" | "class" | "function";
export type CodeLevel = "class" | "function";

export type NodeId = string & { readonly __brand: "NodeId" };

// Injective as long as qualifiedName is "" exactly for package, folder and file, and never
// contains "#" otherwise: the level ends at the first ":" and the name starts after the last "#".
export function nodeId(level: Level | "section", path: string, qualifiedName: string): NodeId {
  const suffix = qualifiedName === "" ? "" : `#${qualifiedName}`;
  return `${level}:${path}${suffix}` as NodeId;
}

/** 1-based and inclusive, start <= end, in lines as src/lines.ts defines them. */
export interface LineRange {
  readonly start: number;
  readonly end: number;
}

export type Analysis = "analysed" | "not analysed";

/** What a file is for. A file the extractor's role table does not recognise has none. */
export type Role = "source" | "tests" | "config" | "docs" | "generated";

interface NodeBase {
  readonly id: NodeId;
  /** For a class or function, the path of the file it is written in. */
  readonly path: string;
  /** For display only, never identity. */
  readonly name: string;
}

export interface ContainerNode extends NodeBase {
  readonly level: "package" | "folder";
  readonly parent: NodeId | null;
  /** The sum of the lines of the files below; code nodes are never counted. */
  readonly lines: number;
}

/** An interface or type alias a file exports, with its shape as written (layout and comments normalised away). */
export interface TypeContract {
  readonly name: string;
  readonly kind: "interface" | "type" | "re-export";
  readonly signature: string;
}

export interface FileNode extends NodeBase {
  readonly level: "file";
  readonly parent: NodeId;
  /** Null for a binary file: it has bytes, not lines. */
  readonly lines: number | null;
  readonly analysis: Analysis;
  /** Null when no rule in the extractor's table matches; never a guess. */
  readonly role: Role | null;
  /** sha256 of the file's whole text as UTF-8, first 32 hex digits. Equal digests, equal text. */
  readonly digest: string;
  /** The interfaces and type aliases the file exports, by name; absent for a file not analysed. */
  readonly types?: readonly TypeContract[];
}

/**
 * A class or function written in a file. Its parent is the file, or the class or function whose
 * source text contains it. It stores a range and no line count, so the two cannot disagree, and
 * a nested node's lines lie inside its parent's range rather than adding to it.
 */
export interface CodeNode extends NodeBase {
  readonly level: CodeLevel;
  readonly parent: NodeId;
  /** Never empty and never contains "#"; see qualifiedName. */
  readonly qualifiedName: string;
  readonly range: LineRange;
  /**
   * sha256 of the declaration's text, from its first token to the end of its body (children
   * included), first 32 hex digits. Lines shifting above it, or its leading comment changing,
   * leave it alone.
   */
  readonly digest: string;
  /** True when the file exports this node from its top level. Methods and nested code never are. */
  readonly exported: boolean;
  /**
   * The signature as written, whitespace and comments normalised away so reformatting is not a
   * change. A function: modifiers, type parameters, parameter list, return type annotation. A
   * class: type parameters, heritage clauses and public method signatures. Never inferred.
   */
  readonly signature: string;
}

/**
 * One heading of a Markdown file and the lines under it, down to the next heading of the same or
 * a higher level. A section has a name and lines, and no edges. Sections are not module nodes:
 * they sit beside `Graph.nodes`, so nothing that lays out or counts modules sees them.
 */
export interface SectionNode {
  readonly id: NodeId;
  readonly level: "section";
  /** The path of the Markdown file. */
  readonly path: string;
  /** The heading's text as written, without its hashes; "(2)" follows a repeat among siblings. For display only. */
  readonly name: string;
  /** The heading's text as written, never with a repeat's "(2)": what a description is matched against. */
  readonly heading: string;
  /** The enclosing section, or the file for a top-level one. */
  readonly parent: NodeId;
  /** 1 to 6: the number of hashes. */
  readonly headingLevel: number;
  /** Built like a code node's: one segment per enclosing heading, see qualifiedName. */
  readonly qualifiedName: string;
  /** From the heading's line to the line before the next heading of the same or a higher level. */
  readonly range: LineRange;
}

export function compareSections(a: SectionNode, b: SectionNode): number {
  return compareIds(a.id, b.id);
}

export function canonicalSection(node: SectionNode): object {
  return {
    id: node.id,
    level: node.level,
    path: node.path,
    name: node.name,
    heading: node.heading,
    parent: node.parent,
    headingLevel: node.headingLevel,
    qualifiedName: node.qualifiedName,
    range: { start: node.range.start, end: node.range.end },
  };
}

export type ModuleNode = ContainerNode | FileNode | CodeNode;

export function isCodeNode(node: ModuleNode): node is CodeNode {
  return node.level === "class" || node.level === "function";
}

/** The lines a node stands for: a container's or file's total, a code node's range length. */
export function lineCount(node: ModuleNode): number {
  return isCodeNode(node) ? node.range.end - node.range.start + 1 : (node.lines ?? 0);
}

const IDENTIFIER_NAME = /^[\p{ID_Start}$_][\p{ID_Continue}$\u200C\u200D]*$/u;

/**
 * The qualified name of a code node within its file. `parent` is the parent code node's qualified
 * name, or "" for a node directly in the file. `text` is what the language calls the node in its
 * scope, and `ordinal` counts the siblings with that same text in source order, from 1.
 *
 *   segment       = (IdentifierName | jsonString) ("@" ordinal)?    ordinal written only when > 1
 *   qualifiedName = segment ("." segment)*
 *
 * jsonString is JSON.stringify(text) with each "#" written as \u0023. An IdentifierName contains
 * none of . @ " # and a JSON string delimits itself, so a name decodes to exactly one path of
 * (text, ordinal) pairs: distinct paths give distinct names, none empty, none containing "#".
 */
export function qualifiedName(parent: string, text: string, ordinal: number): string {
  const head = IDENTIFIER_NAME.test(text) ? text : JSON.stringify(text).replaceAll("#", "\\u0023");
  const segment = ordinal > 1 ? `${head}@${ordinal}` : head;
  return parent === "" ? segment : `${parent}.${segment}`;
}

export type ResourceKind = "process" | "network" | "file system" | "queue" | "timer" | "code loaded at run time";

/** The order a reviewer reads resources in: what reaches furthest out first. */
export const RESOURCE_ORDER: readonly ResourceKind[] = ["process", "network", "queue", "file system", "timer", "code loaded at run time"];

export type ResourceId = string & { readonly __brand: "ResourceId" };

/** One id per kind. Resources are derived from edges, never nodes, so no layout or pairing sees them. */
export function resourceId(kind: ResourceKind): ResourceId {
  return `resource:${kind}` as ResourceId;
}

/** What an effect names: a literal in the source, "unknown" for any other argument, "none" for an API with no target. */
export type EffectTarget = { readonly literal: string } | "unknown" | "none";

/**
 * One argument as the source writes it. A literal string, an array of arguments (a spread of a
 * module-level `const` array of literals is read through, in place), or `unknown` with the
 * expression as written: never a guessed value.
 */
export type EffectArg = { readonly literal: string } | { readonly list: readonly EffectArg[] } | { readonly unknown: string };

/** A call that reaches a resource, pinned to the call's lines. */
export interface EffectEdge {
  readonly kind: "effect";
  /** The innermost class or function containing the call, or the file for module top level. */
  readonly from: NodeId;
  readonly to: ResourceId;
  /** The catalog key: "child_process execFileSync", or "fetch" for a global. */
  readonly operation: string;
  readonly target: EffectTarget;
  /** Every argument of the call, in order. */
  readonly args: readonly EffectArg[];
  readonly range: LineRange;
}

/**
 * A call that decides which file a module name or path means: `createRequire(base)`,
 * `require.resolve(name)`, `import(name)`. Kept apart from effects, which name a resource; the
 * ones that load code at run time (a non-literal `import()`, `createRequire`) are effects.
 */
export interface ResolutionEdge {
  readonly from: NodeId;
  /** "require.resolve" or "import()" of a literal. */
  readonly operation: string;
  readonly args: readonly EffectArg[];
  readonly range: LineRange;
}

export type Edge = EffectEdge;

/** The syntax that made the edge: `import x from`, `export ... from`, `require("x")`, `import("x")`. */
export type ImportSyntax = "import" | "export from" | "require" | "import()";

/**
 * Where an import points: a file of the tree, a package outside it named by its specifier (never
 * a node), or "unresolved" when the specifier is relative, or names a package of this tree, and
 * no file answers to it. Shown as exactly that, never dropped.
 */
export type ImportTarget = { readonly file: NodeId } | { readonly external: string } | { readonly unresolved: true; readonly reason?: string };

/** One static import, `export ... from`, or `require` / `import()` of a string literal, pinned to its lines. */
export interface ImportEdge {
  /** The file node that holds it. */
  readonly from: NodeId;
  /** The module name as written. */
  readonly specifier: string;
  readonly syntax: ImportSyntax;
  /** `import type` and `export type ... from`: erased before the code runs. */
  readonly typeOnly: boolean;
  readonly target: ImportTarget;
  readonly range: LineRange;
}

export const importTargetText = (target: ImportTarget): string =>
  "file" in target ? target.file : "external" in target ? `external:${target.external}` : "unresolved";

export function compareImports(a: ImportEdge, b: ImportEdge): number {
  const key = (edge: ImportEdge): string => `${edge.syntax}\0${importTargetText(edge.target)}\0${edge.specifier}\0${edge.typeOnly}`;
  return compareIds(a.from, b.from) || a.range.start - b.range.start || a.range.end - b.range.end || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
}

export function canonicalImport(edge: ImportEdge): object {
  return {
    from: edge.from,
    specifier: edge.specifier,
    syntax: edge.syntax,
    typeOnly: edge.typeOnly,
    target: edge.target,
    range: { start: edge.range.start, end: edge.range.end },
  };
}

export const DEPENDENCY_LISTS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;
export type DependencyList = (typeof DEPENDENCY_LISTS)[number];

/** One entry of a list in package.json: the name and the range exactly as written, never resolved. */
export interface Dependency {
  readonly name: string;
  /** Null when package.json writes something other than a string: declared, range unknown. */
  readonly range: string | null;
  readonly list: DependencyList;
}

/**
 * What one package.json declares, read from that file alone, never from a lockfile. `readable` is
 * false when the file is not a JSON object, in which case `declared` is empty and says nothing: an
 * unreadable manifest declares no dependency and removes none. An entry whose range is not a
 * string is kept with a null range, so it is never taken for a removal. Sorted by list order, then name.
 */
export interface Manifest {
  readonly file: NodeId;
  readonly path: string;
  readonly readable: boolean;
  readonly declared: readonly Dependency[];
}

/** The file names the extractor treats as lockfiles. */
export const LOCKFILE_NAMES: ReadonlySet<string> = new Set(["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock"]);

export function canonicalManifest(manifest: Manifest): object {
  return { file: manifest.file, path: manifest.path, readable: manifest.readable, declared: manifest.declared.map((d) => ({ name: d.name, range: d.range, list: d.list })) };
}

export interface Graph {
  readonly extractorVersion: string;
  readonly nodes: readonly ModuleNode[];
  /** Sorted by compareEdges. */
  readonly edges: readonly Edge[];
  /** Sorted by compareResolutions. */
  readonly resolutions: readonly ResolutionEdge[];
  /** Sorted by compareImports. */
  readonly imports: readonly ImportEdge[];
  /** Sorted by id. The headings of the Markdown files. */
  readonly sections: readonly SectionNode[];
  /** One per package.json in the tree, sorted by path. */
  readonly manifests: readonly Manifest[];
}

/** The resources some edge reaches, in RESOURCE_ORDER. */
export function resourcesOf(graph: Graph): ResourceKind[] {
  const reached = new Set<string>(graph.edges.map((edge) => edge.to));
  return RESOURCE_ORDER.filter((kind) => reached.has(resourceId(kind)));
}

export function targetText(target: EffectTarget): string {
  return typeof target === "string" ? target : `"${target.literal}"`;
}

export type FileTree = ReadonlyMap<string, string>;

/** The id of the root package, the node with no parent: the whole repository. */
export function rootOf(graph: Graph): NodeId {
  const root = graph.nodes.find((node) => node.parent === null);
  if (root === undefined) throw new Error("the graph has no root package");
  return root.id;
}

export function compareIds(a: NodeId, b: NodeId): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareEdges(a: Edge, b: Edge): number {
  return (
    compareIds(a.from, b.from) ||
    a.range.start - b.range.start ||
    a.range.end - b.range.end ||
    (a.operation < b.operation ? -1 : a.operation > b.operation ? 1 : 0) ||
    (a.to < b.to ? -1 : a.to > b.to ? 1 : 0) ||
    (targetText(a.target) < targetText(b.target) ? -1 : targetText(a.target) > targetText(b.target) ? 1 : 0)
  );
}

export function canonicalEdge(edge: Edge): object {
  return {
    kind: edge.kind,
    from: edge.from,
    to: edge.to,
    operation: edge.operation,
    target: edge.target,
    args: edge.args,
    range: { start: edge.range.start, end: edge.range.end },
  };
}

export function compareResolutions(a: ResolutionEdge, b: ResolutionEdge): number {
  return compareIds(a.from, b.from) || a.range.start - b.range.start || a.range.end - b.range.end || (a.operation < b.operation ? -1 : a.operation > b.operation ? 1 : 0);
}

export function canonicalResolution(edge: ResolutionEdge): object {
  return { from: edge.from, operation: edge.operation, args: edge.args, range: { start: edge.range.start, end: edge.range.end } };
}

/** An argument as text: `"x"`, `["a", "b"]`, or `?expression` for what is not known. */
export function argText(arg: EffectArg): string {
  if ("literal" in arg) return JSON.stringify(arg.literal);
  return "list" in arg ? `[${arg.list.map(argText).join(", ")}]` : `?${arg.unknown}`;
}

/** Every literal and unknown of the arguments, arrays opened, in order. */
export function argTokens(args: readonly EffectArg[]): string[] {
  const tokens: string[] = [];
  const walk = (arg: EffectArg): void => {
    if ("list" in arg) arg.list.forEach(walk);
    else tokens.push(argText(arg));
  };
  args.forEach(walk);
  return tokens;
}

export function canonicalNode(node: ModuleNode): object {
  const base = { id: node.id, level: node.level, path: node.path, name: node.name, parent: node.parent };
  switch (node.level) {
    case "package":
    case "folder":
      return { ...base, lines: node.lines };
    case "file":
      return { ...base, lines: node.lines, analysis: node.analysis, role: node.role, digest: node.digest, ...(node.types === undefined ? {} : { types: node.types.map((t) => ({ name: t.name, kind: t.kind, signature: t.signature })) }) };
    case "class":
    case "function":
      return {
        ...base,
        qualifiedName: node.qualifiedName,
        range: { start: node.range.start, end: node.range.end },
        digest: node.digest,
        exported: node.exported,
        signature: node.signature,
      };
  }
}

export function serializeGraph(graph: Graph): string {
  const nodes = [...graph.nodes].sort((a, b) => compareIds(a.id, b.id)).map(canonicalNode);
  const edges = [...graph.edges].sort(compareEdges).map(canonicalEdge);
  const resolutions = [...graph.resolutions].sort(compareResolutions).map(canonicalResolution);
  const imports = [...graph.imports].sort(compareImports).map(canonicalImport);
  const sections = [...graph.sections].sort(compareSections).map(canonicalSection);
  const manifests = [...graph.manifests].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map(canonicalManifest);
  return `${JSON.stringify({ extractorVersion: graph.extractorVersion, nodes, edges, resolutions, imports, sections, manifests }, null, 2)}\n`;
}
