import { posix } from "node:path";
import ts from "typescript";
import type { CallList, CallRef, UnresolvedCall } from "./defining.ts";
import { adapterFor } from "./extract/adapters.ts";
import type { Declaration } from "./extract/adapters.ts";
import { ImportResolver } from "./extract/javascript-imports.ts";
import type { ResolutionMode } from "./extract/javascript-imports.ts";
import { isCodeSyntax, outline, scriptKind } from "./extract/javascript.ts";
import { isCodeNode, nodeId, qualifiedName } from "./graph.ts";
import type { FileTree, Graph, LineRange, ModuleNode, NodeId } from "./graph.ts";
import { isBinary, lineRangeOf, lineStarts } from "./lines.ts";
import { isAnonymous, labelOf } from "./review.ts";

/*
 * Call edges (SPEC, The graph: Edges; rule 4, lazy). The extracted graph has none: they are
 * worked out here, from the TypeScript compiler's own answer for each call (the symbol of the
 * callee, followed through aliases to its declaration), when a view asks, for the files it
 * needs, and kept per tree. Derived only: no model, and a call that does not land on a code
 * node of the tree (a dynamic call, a call through `any`, node_modules, a built-in) is unresolved
 * with its callee text, never guessed.
 *
 * Type reference edges are not recorded: interfaces and type aliases are not nodes of the graph,
 * so a type annotation has no node to point at except a class, and that is left for its own issue.
 */

const MAX_TEXT = 80;

interface Site {
  /** The innermost class or function holding the call, or the file at module top level. */
  readonly owner: NodeId;
  readonly text: string;
  readonly at: LineRange;
  readonly to?: NodeId;
}

interface Index {
  readonly spans: readonly { readonly id: NodeId; readonly start: number; readonly end: number; readonly depth: number }[];
  readonly byStart: ReadonlyMap<number, NodeId>;
}

const EXTENSIONS: ReadonlyMap<string, ts.Extension> = new Map([
  [".ts", ts.Extension.Ts],
  [".tsx", ts.Extension.Tsx],
  [".mts", ts.Extension.Mts],
  [".cts", ts.Extension.Cts],
  [".js", ts.Extension.Js],
  [".jsx", ts.Extension.Jsx],
  [".mjs", ts.Extension.Mjs],
  [".cjs", ts.Extension.Cjs],
]);

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export class CallResolver {
  private readonly tree: FileTree;
  private readonly graph: Graph;
  private readonly nodes: ReadonlyMap<NodeId, ModuleNode>;
  private readonly effectLines = new Set<string>();
  private program: ts.Program | undefined;
  private readonly indexes = new Map<string, Index>();
  private readonly found = new Map<string, readonly Site[]>();
  private importersByFile: Map<NodeId, { from: NodeId; passes: boolean }[]> | undefined;

  constructor(tree: FileTree, graph: Graph) {
    this.tree = tree;
    this.graph = graph;
    this.nodes = new Map(graph.nodes.map((node) => [node.id, node]));
    for (const edge of graph.edges) this.effectLines.add(`${edge.from}\0${edge.range.start}\0${edge.range.end}`);
  }

  /** Whether the graph has a class or function with this id. */
  has(id: NodeId): boolean {
    const node = this.nodes.get(id);
    return node !== undefined && isCodeNode(node);
  }

  /** What the block calls: resolved blocks with the lines of each call, and the calls that are unresolved. */
  calleesOf(blockId: NodeId): CallList {
    const block = this.nodes.get(blockId);
    if (block === undefined || !isCodeNode(block)) return { resolved: [], unresolved: [] };
    const resolved = new Map<NodeId, LineRange[]>();
    const unresolved: UnresolvedCall[] = [];
    for (const site of this.sitesIn(block.path)) {
      if (!this.inside(site.owner, blockId)) continue;
      if (site.to === undefined) unresolved.push({ text: site.text, at: site.at });
      // A call to itself is recursion, not a callee.
      else if (site.to !== blockId) resolved.set(site.to, [...(resolved.get(site.to) ?? []), site.at]);
    }
    return {
      resolved: [...resolved].map(([id, at]) => this.refOf(id, at)).sort(compareRefs),
      unresolved: unresolved.sort((a, b) => a.at.start - b.at.start || byText(a.text, b.text)),
    };
  }

  /** The blocks that call `blockId`, found in its own file and the files that import it (through re-exports too). */
  callersOf(blockId: NodeId): CallRef[] {
    const block = this.nodes.get(blockId);
    if (block === undefined || !isCodeNode(block)) return [];
    const holders = new Map<NodeId, LineRange[]>();
    for (const path of this.searchFor(`file:${block.path}` as NodeId)) {
      for (const site of this.sitesIn(path)) {
        if (site.to !== blockId || this.inside(site.owner, blockId)) continue;
        const holder = this.holderOf(site.owner);
        holders.set(holder, [...(holders.get(holder) ?? []), site.at]);
      }
    }
    return [...holders].map(([id, at]) => this.refOf(id, at)).sort(compareRefs);
  }

  /** The files that can call into `file`: itself, its importers, and the importers of any file that re-exports it. */
  private searchFor(file: NodeId): string[] {
    if (this.importersByFile === undefined) {
      this.importersByFile = new Map();
      for (const edge of this.graph.imports) {
        if (!("file" in edge.target)) continue;
        const list = this.importersByFile.get(edge.target.file) ?? [];
        list.push({ from: edge.from, passes: edge.reexports !== undefined });
        this.importersByFile.set(edge.target.file, list);
      }
    }
    const seen = new Set<NodeId>([file]);
    const queue = [file];
    for (let at = queue.pop(); at !== undefined; at = queue.pop()) {
      for (const { from, passes } of this.importersByFile.get(at) ?? []) {
        if (seen.has(from)) continue;
        seen.add(from);
        // A file that only imports is a caller's home; one that re-exports also hands the name on.
        if (passes) queue.push(from);
      }
    }
    return [...seen].map((id) => this.nodes.get(id)?.path ?? "").filter((path) => path !== "").sort(byText);
  }

  private inside(owner: NodeId, blockId: NodeId): boolean {
    for (let at = this.nodes.get(owner); at !== undefined; at = isCodeNode(at) ? this.nodes.get(at.parent) : undefined) if (at.id === blockId) return true;
    return false;
  }

  /** The named block a call is made from: itself if named, else the nearest named holder, else the file. */
  private holderOf(owner: NodeId): NodeId {
    let at = this.nodes.get(owner);
    while (at !== undefined && isCodeNode(at)) {
      if (!isAnonymous(at)) return at.id;
      at = this.nodes.get(at.parent);
    }
    return at === undefined ? owner : at.id;
  }

  private refOf(id: NodeId, at: LineRange[]): CallRef {
    const node = this.nodes.get(id)!;
    return isCodeNode(node)
      ? { id, label: labelOf(node), level: node.level, path: node.path, range: node.range, at }
      : { id, label: "(top level)", level: "file", path: node.path, range: null, at };
  }

  /** Every call written in `path`, resolved or not, in source order; kept after the first ask. */
  private sitesIn(path: string): readonly Site[] {
    const known = this.found.get(path);
    if (known !== undefined) return known;
    const made = this.analyse(path);
    this.found.set(path, made);
    return made;
  }

  private analyse(path: string): readonly Site[] {
    const text = this.tree.get(path);
    const program = this.programOver();
    const source = program.getSourceFile(`/${path}`);
    if (text === undefined || source === undefined || source.isDeclarationFile) return [];
    const checker = program.getTypeChecker();
    const starts = lineStarts(text);
    const index = this.indexOf(path, source);
    const file = `file:${path}` as NodeId;
    const sites: Site[] = [];
    const visit = (node: ts.Node): void => {
      if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && !isModuleLoad(node)) {
        const start = node.getStart(source);
        const at = lineRangeOf(starts, start, Math.max(node.end, start + 1));
        const owner = innermost(index, start) ?? file;
        const to = this.targetOf(checker, node);
        const calleeText = `${ts.isNewExpression(node) ? "new " : ""}${oneLine(node.expression.getText(source))}`;
        // An effect (fs.readFileSync, fetch) is shown as the effect it is, not as an unresolved call.
        if (to !== undefined || !this.effectLines.has(`${owner}\0${at.start}\0${at.end}`)) sites.push({ owner, text: calleeText, at, ...(to === undefined ? {} : { to }) });
      }
      node.forEachChild(visit);
    };
    visit(source);
    return sites.sort((a, b) => a.at.start - b.at.start || a.at.end - b.at.end);
  }

  /** The code node the compiler says `call` runs, or undefined: no symbol, no body, or not in the tree. */
  private targetOf(checker: ts.TypeChecker, call: ts.CallExpression | ts.NewExpression): NodeId | undefined {
    const callee = unwrap(call.expression);
    const named = ts.isPropertyAccessExpression(callee) ? callee.name : ts.isIdentifier(callee) ? callee : ts.isElementAccessExpression(callee) ? callee.argumentExpression : undefined;
    let symbol = named === undefined ? undefined : checker.getSymbolAtLocation(named);
    if (symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    let found: ts.Node[];
    if (symbol?.declarations !== undefined) found = codeOf(symbol.declarations);
    else {
      // No symbol to follow (the result of a call, say): the signature the compiler chose, if it has a declaration.
      const declaration = ts.isNewExpression(call) ? undefined : checker.getResolvedSignature(call)?.declaration;
      found = declaration === undefined ? [] : codeOf([declaration]);
    }
    // Two bodies would be a guess between them.
    if (found.length !== 1) return undefined;
    const declaration = found[0]!;
    const sourceFile = declaration.getSourceFile();
    const path = sourceFile.fileName.slice(1);
    if (!this.tree.has(path)) return undefined;
    return this.indexOf(path, sourceFile).byStart.get(declaration.getStart(sourceFile));
  }

  private indexOf(path: string, source: ts.SourceFile): Index {
    const known = this.indexes.get(path);
    if (known !== undefined) return known;
    const spans: { id: NodeId; start: number; end: number; depth: number }[] = [];
    const byStart = new Map<number, NodeId>();
    // The extractor's own identity: ordinals among siblings with the same text, in source order.
    const visit = (siblings: readonly Declaration[], parentName: string, depth: number): void => {
      const seen = new Map<string, number>();
      for (const declaration of [...siblings].sort((a, b) => a.start - b.start)) {
        const ordinal = (seen.get(declaration.text) ?? 0) + 1;
        seen.set(declaration.text, ordinal);
        const name = qualifiedName(parentName, declaration.text, ordinal);
        const id = nodeId(declaration.level, path, name);
        spans.push({ id, start: declaration.start, end: declaration.end, depth });
        byStart.set(declaration.start, id);
        visit(declaration.children, name, depth + 1);
      }
    };
    visit(outline(source), "", 1);
    const made = { spans, byStart };
    this.indexes.set(path, made);
    return made;
  }

  /** One program over the tree's JavaScript and TypeScript files, imports resolved the way the extractor resolves them. Built on first use. */
  private programOver(): ts.Program {
    if (this.program !== undefined) return this.program;
    const names = new Map<string, string>();
    for (const [path, text] of this.tree) if (adapterFor(path) !== undefined && !isBinary(text)) names.set(`/${path}`, text);
    const resolver = new ImportResolver(this.tree);
    const options: ts.CompilerOptions = {
      allowJs: true,
      noLib: true,
      types: [],
      noEmit: true,
      target: ts.ScriptTarget.Latest,
      jsx: ts.JsxEmit.Preserve,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      module: ts.ModuleKind.ESNext,
      ignoreDeprecations: "6.0",
    };
    const host: ts.CompilerHost = {
      getSourceFile: (name, languageVersion) => {
        const text = names.get(name);
        return text === undefined ? undefined : ts.createSourceFile(name, text, languageVersion, true, scriptKind(name));
      },
      getDefaultLibFileName: () => "/lib.d.ts",
      writeFile: () => {},
      getCurrentDirectory: () => "/",
      getCanonicalFileName: (name) => name,
      useCaseSensitiveFileNames: () => true,
      getNewLine: () => "\n",
      fileExists: (name) => names.has(name),
      readFile: (name) => names.get(name),
      resolveModuleNameLiterals: (literals, containing) =>
        literals.map((literal) => {
          const mode: ResolutionMode = ts.isCallExpression(literal.parent) && ts.isIdentifier(literal.parent.expression) && literal.parent.expression.text === "require" ? "cjs" : "esm";
          const target = resolver.resolve(literal.text, containing.slice(1), mode);
          const extension = "file" in target ? EXTENSIONS.get(posix.extname(target.file)) : undefined;
          if (!("file" in target) || extension === undefined || !names.has(`/${target.file}`)) return { resolvedModule: undefined };
          return { resolvedModule: { resolvedFileName: `/${target.file}`, extension, isExternalLibraryImport: false } };
        }),
    };
    this.program = ts.createProgram({ rootNames: [...names.keys()], host, options });
    return this.program;
  }
}

const compareRefs = (a: CallRef, b: CallRef): number => byText(a.path, b.path) || (a.range?.start ?? a.at[0]?.start ?? 0) - (b.range?.start ?? b.at[0]?.start ?? 0) || byText(a.id, b.id);

function innermost(index: Index, offset: number): NodeId | undefined {
  let best: Index["spans"][number] | undefined;
  for (const span of index.spans) if (span.start <= offset && offset < span.end && (best === undefined || span.depth > best.depth)) best = span;
  return best?.id;
}

const oneLine = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT - 1)}…` : flat;
};

/** `require("x")`, `import("x")` and `super(...)` are not calls to a block: imports have their own edges. */
function isModuleLoad(call: ts.CallExpression | ts.NewExpression): boolean {
  if (ts.isNewExpression(call)) return false;
  return call.expression.kind === ts.SyntaxKind.ImportKeyword || call.expression.kind === ts.SyntaxKind.SuperKeyword || (ts.isIdentifier(call.expression) && call.expression.text === "require");
}

function unwrap(expression: ts.Expression): ts.Expression {
  let at = expression;
  while (ts.isParenthesizedExpression(at) || ts.isNonNullExpression(at) || ts.isAsExpression(at) || ts.isSatisfiesExpression(at)) at = at.expression;
  return at;
}

/** The declarations that are code nodes: a function or class with a body, or the one a variable, property or default export holds. */
function codeOf(declarations: readonly ts.Declaration[]): ts.Node[] {
  const found: ts.Node[] = [];
  for (const declaration of declarations) {
    const held = ts.isVariableDeclaration(declaration) || ts.isPropertyAssignment(declaration) || ts.isPropertyDeclaration(declaration) ? declaration.initializer : ts.isExportAssignment(declaration) ? declaration.expression : undefined;
    const node = held !== undefined ? unwrap(held) : declaration;
    if (isCodeSyntax(node)) found.push(node);
  }
  return found;
}
