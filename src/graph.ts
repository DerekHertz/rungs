export type Level = "package" | "folder" | "file" | "class" | "function";

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
  readonly path: string;
  readonly name: string;
  readonly parent: NodeId | null;
  readonly lines: number;
}

export interface ContainerNode extends NodeBase {
  readonly level: "package" | "folder";
}

export interface FileNode extends NodeBase {
  readonly level: "file";
  readonly parent: NodeId;
  readonly analysis: Analysis;
  readonly generated: boolean;
}

export type ModuleNode = ContainerNode | FileNode;

export interface Graph {
  readonly extractorVersion: string;
  readonly nodes: readonly ModuleNode[];
}

export type FileTree = ReadonlyMap<string, string>;

export function compareIds(a: NodeId, b: NodeId): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonicalNode(node: ModuleNode): object {
  const base = {
    id: node.id,
    level: node.level,
    path: node.path,
    name: node.name,
    parent: node.parent,
    lines: node.lines,
  };
  return node.level === "file" ? { ...base, analysis: node.analysis, generated: node.generated } : base;
}

export function serializeGraph(graph: Graph): string {
  const nodes = [...graph.nodes].sort((a, b) => compareIds(a.id, b.id)).map(canonicalNode);
  return `${JSON.stringify({ extractorVersion: graph.extractorVersion, nodes }, null, 2)}\n`;
}
