import { posix } from "node:path";
import ts from "typescript";
import type { CallList, CallRef, UnresolvedCall } from "./defining.ts";
import { adapterFor } from "./extract/adapters.ts";
import { ImportResolver } from "./extract/javascript-imports.ts";
import type { ResolutionMode } from "./extract/javascript-imports.ts";
import { codeNodes, ownerOf } from "./extract/extract.ts";
import type { CodeNodes } from "./extract/extract.ts";
import { effectSites } from "./extract/javascript-effects.ts";
import { isCodeSyntax, outline, scriptKind } from "./extract/javascript.ts";
import { isCodeNode } from "./graph.ts";
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
  private program: ts.Program | undefined;
  private reassigned: Set<ts.Symbol> | undefined;
  private readonly indexes = new Map<string, CodeNodes>();
  private readonly found = new Map<string, readonly Site[]>();
  private importersByFile: Map<NodeId, NodeId[]> | undefined;

  constructor(tree: FileTree, graph: Graph) {
    this.tree = tree;
    this.graph = graph;
    this.nodes = new Map(graph.nodes.map((node) => [node.id, node]));
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
      resolved: [...resolved].flatMap(([id, at]) => this.refOf(id, at) ?? []).sort(compareRefs),
      unresolved: unresolved.sort((a, b) => a.at.start - b.at.start || byText(a.text, b.text)),
    };
  }

  /** The blocks that call `blockId`, found in its own file and every file that imports it, directly or not. */
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
    return [...holders].flatMap(([id, at]) => this.refOf(id, at) ?? []).sort(compareRefs);
  }

  /** The files that can call into `file`: itself and every file that imports it, directly or through others. The compiler decides which calls really reach it. */
  private searchFor(file: NodeId): string[] {
    if (this.importersByFile === undefined) {
      this.importersByFile = new Map();
      for (const edge of this.graph.imports) {
        if (!("file" in edge.target)) continue;
        this.importersByFile.set(edge.target.file, [...(this.importersByFile.get(edge.target.file) ?? []), edge.from]);
      }
    }
    const seen = new Set<NodeId>([file]);
    const queue = [file];
    for (let at = queue.pop(); at !== undefined; at = queue.pop()) {
      for (const from of this.importersByFile.get(at) ?? []) {
        if (seen.has(from)) continue;
        seen.add(from);
        queue.push(from);
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

  private refOf(id: NodeId, at: LineRange[]): CallRef | undefined {
    const node = this.nodes.get(id);
    if (node === undefined) return undefined;
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
    // An effect (fs.readFileSync, fetch) is shown as the effect it is, not as an unresolved call: matched by the call's own start.
    const effects = new Set(effectSites(source, checker).map((site) => site.start));
    const sites: Site[] = [];
    const visit = (node: ts.Node): void => {
      if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && !isModuleLoad(node, checker)) {
        const start = node.getStart(source);
        const at = lineRangeOf(starts, start, Math.max(node.end, start + 1));
        const owner = ownerOf(path, { start, end: node.end }, index.spans);
        const found = this.targetOf(checker, node);
        // An id the graph does not have is never an edge.
        const to = found !== undefined && this.nodes.has(found) ? found : undefined;
        const calleeText = `${ts.isNewExpression(node) ? "new " : ""}${oneLine(node.expression.getText(source))}`;
        if (to !== undefined || !effects.has(start)) sites.push({ owner, text: calleeText, at, ...(to === undefined ? {} : { to }) });
      }
      node.forEachChild(visit);
    };
    visit(source);
    return sites.sort((a, b) => a.at.start - b.at.start || a.at.end - b.at.end);
  }

  /**
   * The code node `call` runs, only when the callee is a direct reference (an identifier, a property
   * access, or `new X`) whose symbol has exactly one body: a function or method, a class, or a
   * `const` bound to a function, never assigned to. Anything else is undefined: unresolved.
   */
  private targetOf(checker: ts.TypeChecker, call: ts.CallExpression | ts.NewExpression): NodeId | undefined {
    let callee: ts.Expression = call.expression;
    while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
    const named = ts.isPropertyAccessExpression(callee) ? callee.name : ts.isIdentifier(callee) ? callee : undefined;
    if (named === undefined || (ts.isPropertyAccessExpression(callee) && assertedReceiver(callee.expression))) return undefined;
    // Any value typed `any` (a cast, an annotation) says nothing about what runs.
    if (checker.getTypeAtLocation(callee).flags & ts.TypeFlags.Any) return undefined;
    let symbol = checker.getSymbolAtLocation(named);
    if (symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    const declarations = symbol?.declarations;
    if (symbol === undefined || declarations === undefined) return undefined;
    const assigned = this.assigned(checker);
    if (assigned.has(symbol)) return undefined;
    // A member written through brackets (`o["run"] = ...`) marks the whole object: nothing called through it is known.
    if (ts.isPropertyAccessExpression(callee) && receiverSymbols(checker, callee.expression).some((owner) => assigned.has(owner))) return undefined;
    const bodies = new Set<ts.Node>();
    let others = 0;
    for (const declaration of declarations) {
      const body = bodyOf(declaration);
      if (body !== undefined) bodies.add(body);
      // Overload signatures beside the one body are fine; any other second declaration (a merge) is a guess between them.
      else if (!isOverload(declaration)) others += 1;
    }
    if (bodies.size !== 1 || others > 0) return undefined;
    const declaration = [...bodies][0]!;
    const sourceFile = declaration.getSourceFile();
    const path = sourceFile.fileName.slice(1);
    if (!this.tree.has(path)) return undefined;
    return this.indexOf(path, sourceFile).byStart.get(declaration.getStart(sourceFile));
  }

  /** Every symbol the program assigns to anywhere (`f = ...`, `f++`, `[f] = ...`, `o.f = ...`): none of them names one function. */
  private assigned(checker: ts.TypeChecker): Set<ts.Symbol> {
    if (this.reassigned !== undefined) return this.reassigned;
    const found = new Set<ts.Symbol>();
    const mark = (target: ts.Node): void => {
      if (ts.isParenthesizedExpression(target)) mark(target.expression);
      else if (ts.isIdentifier(target)) {
        const symbol = checker.getSymbolAtLocation(target);
        if (symbol !== undefined) found.add(symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);
      } else if (ts.isPropertyAccessExpression(target)) mark(target.name);
      else if (ts.isElementAccessExpression(target)) {
        // Any member of the object may now be something else.
        for (const owner of receiverSymbols(checker, target.expression)) found.add(owner);
      }
      else if (ts.isArrayLiteralExpression(target)) target.elements.forEach(mark);
      else if (ts.isObjectLiteralExpression(target)) {
        for (const property of target.properties) {
          if (ts.isShorthandPropertyAssignment(property)) {
            const symbol = checker.getShorthandAssignmentValueSymbol(property);
            if (symbol !== undefined) found.add(symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);
          }
          else if (ts.isPropertyAssignment(property)) mark(property.initializer);
          else if (ts.isSpreadAssignment(property)) mark(property.expression);
        }
      } else if (ts.isSpreadElement(target)) mark(target.expression);
      else if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken) mark(target.left);
    };
    for (const file of this.programOver().getSourceFiles()) {
      if (!this.tree.has(file.fileName.slice(1)) || file.isDeclarationFile) continue;
      const visit = (node: ts.Node): void => {
        if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) mark(node.left);
        else if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) mark(node.operand);
        else if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && !ts.isVariableDeclarationList(node.initializer)) mark(node.initializer);
        node.forEachChild(visit);
      };
      visit(file);
    }
    this.reassigned = found;
    return found;
  }

  /** The extractor's own ids, spans and starts for the file, so identity is never worked out twice. */
  private indexOf(path: string, source: ts.SourceFile): CodeNodes {
    const known = this.indexes.get(path);
    if (known !== undefined) return known;
    const made = codeNodes(path, this.tree.get(path) ?? "", outline(source));
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

const oneLine = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT - 1)}…` : flat;
};

/** `import("x")` and `super(...)` are not calls to a block, nor is `require("x")` when nothing declares `require`: imports have their own edges. A `require` the code declares itself is an ordinary call. */
function isModuleLoad(call: ts.CallExpression | ts.NewExpression, checker: ts.TypeChecker): boolean {
  if (ts.isNewExpression(call)) return false;
  const callee = call.expression;
  if (callee.kind === ts.SyntaxKind.ImportKeyword || callee.kind === ts.SyntaxKind.SuperKeyword) return true;
  return ts.isIdentifier(callee) && callee.text === "require" && (checker.getSymbolAtLocation(callee)?.declarations?.length ?? 0) === 0;
}

/** The code a declaration stands for: a function or method with a body, a class, a default-exported function, or a `const` bound to a function. Not a getter. */
function bodyOf(declaration: ts.Declaration): ts.Node | undefined {
  if (ts.isGetAccessor(declaration) || ts.isSetAccessor(declaration)) return undefined;
  if (ts.isVariableDeclaration(declaration)) {
    if (!(ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) || declaration.initializer === undefined) return undefined;
    let held = declaration.initializer;
    while (ts.isParenthesizedExpression(held)) held = held.expression;
    return isCodeSyntax(held) ? held : undefined;
  }
  if (ts.isExportAssignment(declaration)) {
    let held = declaration.expression;
    while (ts.isParenthesizedExpression(held)) held = held.expression;
    return isCodeSyntax(held) ? held : undefined;
  }
  return isCodeSyntax(declaration) ? declaration : undefined;
}

/** A function or method signature written without a body, ahead of the one that has it. */
const isOverload = (declaration: ts.Declaration): boolean => (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) && declaration.body === undefined;

/** True when an assertion (`as`, `<T>`, `satisfies`, `!`) sits anywhere in the receiver chain: the type it names is not what runs. */
function assertedReceiver(receiver: ts.Expression): boolean {
  for (let at: ts.Expression = receiver; ; ) {
    if (ts.isAsExpression(at) || ts.isTypeAssertionExpression(at) || ts.isSatisfiesExpression(at) || ts.isNonNullExpression(at)) return true;
    if (ts.isParenthesizedExpression(at) || ts.isPropertyAccessExpression(at) || ts.isElementAccessExpression(at) || ts.isCallExpression(at)) at = at.expression;
    else return false;
  }
}

/** The symbols of the names along a receiver (`a.b.c` gives c, b and a): an assignment through any of them reaches the rest. */
function receiverSymbols(checker: ts.TypeChecker, receiver: ts.Expression): ts.Symbol[] {
  const found: ts.Symbol[] = [];
  for (let at: ts.Expression = receiver; ; ) {
    if (ts.isParenthesizedExpression(at)) at = at.expression;
    else if (ts.isPropertyAccessExpression(at) || ts.isElementAccessExpression(at)) {
      const symbol = ts.isPropertyAccessExpression(at) ? checker.getSymbolAtLocation(at.name) : undefined;
      if (symbol !== undefined) found.push(symbol);
      at = at.expression;
    } else {
      const symbol = ts.isIdentifier(at) ? checker.getSymbolAtLocation(at) : undefined;
      if (symbol !== undefined) found.push(symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);
      return found;
    }
  }
}
