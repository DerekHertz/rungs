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
  readonly generated: boolean;
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

export interface Graph {
  readonly extractorVersion: string;
  readonly nodes: readonly ModuleNode[];
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

function canonicalNode(node: ModuleNode): object {
  const base = { id: node.id, level: node.level, path: node.path, name: node.name, parent: node.parent };
  switch (node.level) {
    case "package":
    case "folder":
      return { ...base, lines: node.lines };
    case "file":
      return { ...base, lines: node.lines, analysis: node.analysis, generated: node.generated };
    case "class":
    case "function":
      return {
        ...base,
        qualifiedName: node.qualifiedName,
        range: { start: node.range.start, end: node.range.end },
      };
  }
}

export function serializeGraph(graph: Graph): string {
  const nodes = [...graph.nodes].sort((a, b) => compareIds(a.id, b.id)).map(canonicalNode);
  return `${JSON.stringify({ extractorVersion: graph.extractorVersion, nodes }, null, 2)}\n`;
}
