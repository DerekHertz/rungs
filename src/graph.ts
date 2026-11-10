export type Level = "package" | "folder" | "file" | "class" | "function";
export type CodeLevel = "class" | "function";

export type NodeId = string & { readonly __brand: "NodeId" };

// Injective as long as qualifiedName is "" exactly for package, folder and file, and never
// contains "#" otherwise: the level ends at the first ":" and the name starts after the last "#".
export function nodeId(level: Level, path: string, qualifiedName: string): NodeId {
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

export interface FileNode extends NodeBase {
  readonly level: "file";
  readonly parent: NodeId;
  readonly lines: number;
  readonly analysis: Analysis;
  /** Null when no rule in the extractor's table matches; never a guess. */
  readonly role: Role | null;
  /** sha256 of the file's whole text as UTF-8, first 32 hex digits. Equal digests, equal text. */
  readonly digest: string;
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

export type ModuleNode = ContainerNode | FileNode | CodeNode;

export function isCodeNode(node: ModuleNode): node is CodeNode {
  return node.level === "class" || node.level === "function";
}

/** The lines a node stands for: a container's or file's total, a code node's range length. */
export function lineCount(node: ModuleNode): number {
  return isCodeNode(node) ? node.range.end - node.range.start + 1 : node.lines;
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

export type ResourceKind = "process" | "network" | "file system" | "queue" | "timer";

/** The order a reviewer reads resources in: what reaches furthest out first. */
export const RESOURCE_ORDER: readonly ResourceKind[] = ["process", "network", "queue", "file system", "timer"];

export type ResourceId = string & { readonly __brand: "ResourceId" };

/** One id per kind. Resources are derived from edges, never nodes, so no layout or pairing sees them. */
export function resourceId(kind: ResourceKind): ResourceId {
  return `resource:${kind}` as ResourceId;
}

/** What an effect names: a literal in the source, "unknown" for any other argument, "none" for an API with no target. */
export type EffectTarget = { readonly literal: string } | "unknown" | "none";

/** A call that reaches a resource, pinned to the call's lines. */
export interface EffectEdge {
  readonly kind: "effect";
  /** The innermost class or function containing the call, or the file for module top level. */
  readonly from: NodeId;
  readonly to: ResourceId;
  /** The catalog key: "child_process execFileSync", or "fetch" for a global. */
  readonly operation: string;
  readonly target: EffectTarget;
  readonly range: LineRange;
}

export type Edge = EffectEdge;

export interface Graph {
  readonly extractorVersion: string;
  readonly nodes: readonly ModuleNode[];
  /** Sorted by compareEdges. */
  readonly edges: readonly Edge[];
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
    range: { start: edge.range.start, end: edge.range.end },
  };
}

export function canonicalNode(node: ModuleNode): object {
  const base = { id: node.id, level: node.level, path: node.path, name: node.name, parent: node.parent };
  switch (node.level) {
    case "package":
    case "folder":
      return { ...base, lines: node.lines };
    case "file":
      return { ...base, lines: node.lines, analysis: node.analysis, role: node.role, digest: node.digest };
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
  return `${JSON.stringify({ extractorVersion: graph.extractorVersion, nodes, edges }, null, 2)}\n`;
}
