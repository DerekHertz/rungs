import ts from "typescript";
import type { EffectSite, ResolutionSite } from "./adapters.ts";
import { GLOBAL_NAMESPACES, GLOBAL_OBJECTS, SUBMODULES, TRANSPARENT_WRAPPERS, effectKey, lookupEffect } from "./javascript-effects-catalog.ts";
import type { EffectEntry } from "./javascript-effects-catalog.ts";
import type { EffectArg, EffectTarget } from "../graph.ts";

/**
 * What a name provably stands for. Only binder facts decide it: an import, a `const` initialised
 * from `require`, another resolved name, or no declaration at all (a global). Nothing here type
 * checks, and nothing reads a file outside the one tree, so the answer is a function of the tree.
 */
type Ref =
  | { readonly kind: "namespace"; readonly module: string }
  | { readonly kind: "member"; readonly module: string | null; readonly name: string }
  | { readonly kind: "globals" };

const MAX_DEPTH = 4;

const moduleName = (specifier: string): string => (specifier.startsWith("node:") ? specifier.slice(5) : specifier);

function memberRef(module: string, name: string): Ref {
  if (name === "default") return { kind: "namespace", module };
  const sub = SUBMODULES.find(([parent, member]) => parent === module && member === name);
  return sub === undefined ? { kind: "member", module, name } : { kind: "namespace", module: sub[2] };
}

function globalRef(name: string): Ref {
  if (GLOBAL_OBJECTS.includes(name)) return { kind: "globals" };
  if (GLOBAL_NAMESPACES.includes(name)) return { kind: "namespace", module: name };
  return { kind: "member", module: null, name };
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function stringOf(node: ts.Node | undefined): string | undefined {
  return node !== undefined && ts.isStringLiteralLike(node) ? node.text : undefined;
}

class Resolver {
  private readonly file: ts.SourceFile;
  private readonly checker: ts.TypeChecker;

  constructor(file: ts.SourceFile, checker: ts.TypeChecker) {
    this.file = file;
    this.checker = checker;
  }

  /** `createRequire`, imported from "module", is the one resolver that is a function of a module. */
  isCreateRequire(call: ts.CallExpression): boolean {
    const ref = this.resolve(call.expression, 0);
    return ref?.kind === "member" && ref.module === "module" && ref.name === "createRequire";
  }

  /** A call of the global `require`, not one this file declares. */
  isGlobalRequire(call: ts.CallExpression): boolean {
    const callee = unwrap(call.expression);
    return ts.isIdentifier(callee) && callee.text === "require" && this.declarationsOf(callee).length === 0;
  }

  /** `require.resolve`, with the global `require`. */
  isRequireResolve(call: ts.CallExpression): boolean {
    const callee = unwrap(call.expression);
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "resolve") return false;
    const object = unwrap(callee.expression);
    return ts.isIdentifier(object) && object.text === "require" && this.declarationsOf(object).length === 0;
  }

  /**
   * The elements a spread stands for, when it spreads a module-level `const` of this file that is
   * an array literal; undefined for any other spread.
   */
  spreadElements(spread: ts.Expression, depth: number): readonly EffectArg[] | undefined {
    const node = unwrap(spread);
    if (depth > MAX_DEPTH || !ts.isIdentifier(node)) return undefined;
    const [declaration, ...rest] = this.declarationsOf(node);
    if (
      declaration === undefined ||
      rest.length > 0 ||
      !ts.isVariableDeclaration(declaration) ||
      !isConst(declaration) ||
      !ts.isIdentifier(declaration.name) ||
      declaration.initializer === undefined
    ) {
      return undefined;
    }
    const init = unwrap(declaration.initializer);
    if (!ts.isArrayLiteralExpression(init)) return undefined;
    const symbol = this.checker.getSymbolAtLocation(node);
    return symbol !== undefined && this.onlyRead(symbol, declaration.name) ? this.elements(init.elements, depth + 1) : undefined;
  }

  private references: Map<ts.Symbol, ts.Identifier[]> | undefined;

  private referencesOf(symbol: ts.Symbol): readonly ts.Identifier[] {
    if (this.references === undefined) {
      const found = new Map<ts.Symbol, ts.Identifier[]>();
      const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node)) {
          const target = ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
            ? this.checker.getShorthandAssignmentValueSymbol(node.parent)
            : this.checker.getSymbolAtLocation(node);
          if (target !== undefined) found.set(target, [...(found.get(target) ?? []), node]);
        }
        node.forEachChild(visit);
      };
      visit(this.file);
      this.references = found;
    }
    return this.references.get(symbol) ?? [];
  }

  /** True when every use of the array, besides its declaration, is a spread or an index read. */
  private onlyRead(symbol: ts.Symbol, declared: ts.Identifier): boolean {
    return this.referencesOf(symbol).every((use) => {
      if (use === declared) return true;
      const parent = use.parent;
      if (ts.isSpreadElement(parent) && parent.expression === use) return true;
      if (!ts.isElementAccessExpression(parent) || parent.expression !== use) return false;
      const outer = parent.parent;
      const written =
        (ts.isBinaryExpression(outer) && outer.left === parent && outer.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && outer.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
        ((ts.isPrefixUnaryExpression(outer) || ts.isPostfixUnaryExpression(outer)) && (outer.operator === ts.SyntaxKind.PlusPlusToken || outer.operator === ts.SyntaxKind.MinusMinusToken)) ||
        ts.isDeleteExpression(outer) ||
        ((ts.isForOfStatement(outer) || ts.isForInStatement(outer)) && outer.initializer === parent);
      return !written;
    });
  }

  /** Arguments or array elements as written; a spread of a known array is opened in place. */
  elements(nodes: readonly ts.Expression[], depth: number): EffectArg[] {
    return nodes.flatMap((node): EffectArg[] => {
      if (!ts.isSpreadElement(node)) return [this.arg(node, depth)];
      return [...(this.spreadElements(node.expression, depth) ?? [{ unknown: written(node.expression, this.file) }])];
    });
  }

  arg(expression: ts.Expression, depth: number): EffectArg {
    const node = unwrap(expression);
    const literal = stringOf(node);
    if (literal !== undefined) return { literal };
    if (ts.isArrayLiteralExpression(node)) return { list: this.elements(node.elements, depth) };
    return { unknown: written(node, this.file) };
  }

  /** The one place a callee becomes a catalog entry; a full type checker can replace it. */
  resolveCallee(call: ts.CallExpression | ts.NewExpression): EffectEntry | undefined {
    const ref = this.resolve(call.expression, 0);
    if (ref?.kind !== "member") return undefined;
    const entry = lookupEffect(ref.module, ref.name);
    return entry !== undefined && (entry.construct === true) === ts.isNewExpression(call) ? entry : undefined;
  }

  private resolve(expression: ts.Expression, depth: number): Ref | undefined {
    if (depth > MAX_DEPTH) return undefined;
    const node = unwrap(expression);
    if (ts.isIdentifier(node)) return this.identifier(node, depth);
    if (ts.isPropertyAccessExpression(node)) return this.member(node.expression, node.name.text, depth);
    if (ts.isElementAccessExpression(node)) {
      const name = stringOf(unwrap(node.argumentExpression));
      return name === undefined ? undefined : this.member(node.expression, name, depth);
    }
    if (ts.isCallExpression(node)) return this.call(node, depth);
    return undefined;
  }

  private member(object: ts.Expression, name: string, depth: number): Ref | undefined {
    return this.of(this.resolve(object, depth + 1), name);
  }

  private of(base: Ref | undefined, name: string): Ref | undefined {
    if (base?.kind === "namespace") return memberRef(base.module, name);
    if (base?.kind === "globals") return globalRef(name);
    return undefined;
  }

  private call(node: ts.CallExpression, depth: number): Ref | undefined {
    const callee = unwrap(node.expression);
    const [first] = node.arguments;
    if (ts.isIdentifier(callee) && callee.text === "require" && this.declarationsOf(callee).length === 0) {
      const specifier = stringOf(first);
      return specifier === undefined || node.arguments.length !== 1
        ? undefined
        : { kind: "namespace", module: moduleName(specifier) };
    }
    const wrapper = this.resolve(callee, depth + 1);
    if (wrapper?.kind !== "member" || first === undefined || ts.isSpreadElement(first)) return undefined;
    const wraps = TRANSPARENT_WRAPPERS.some((entry) => entry.module === wrapper.module && entry.name === wrapper.name);
    return wraps ? this.resolve(first, depth + 1) : undefined;
  }

  // What this file declares under the name. The checker also invents symbols with no declaration
  // for `require` and `globalThis`, and a `globalThis.fetch = ...` in another file declares a
  // global there, not in scope here.
  private declarationsOf(identifier: ts.Identifier): ts.Declaration[] {
    const symbol = this.checker.getSymbolAtLocation(identifier);
    return (symbol?.declarations ?? []).filter((declaration) => declaration.getSourceFile() === this.file);
  }

  // A script's `const fetch = ...` is a real declaration this file sees; only property
  // assignments onto a global object (`globalThis.fetch = ...`) leave the global a global.
  private declaredElsewhere(identifier: ts.Identifier): boolean {
    const declarations = this.checker.getSymbolAtLocation(identifier)?.declarations ?? [];
    return declarations.some(
      (declaration) =>
        !ts.isBinaryExpression(declaration) &&
        !ts.isPropertyAccessExpression(declaration) &&
        !ts.isElementAccessExpression(declaration),
    );
  }

  private identifier(node: ts.Identifier, depth: number): Ref | undefined {
    const here = this.declarationsOf(node);
    if (here.length === 0) return this.declaredElsewhere(node) ? undefined : globalRef(node.text);
    const [declaration] = here;
    if (here.length !== 1 || declaration === undefined) return undefined;

    if (ts.isImportSpecifier(declaration)) {
      if (declaration.isTypeOnly || declaration.parent.parent.isTypeOnly) return undefined;
      const module = this.moduleOf(declaration.parent.parent.parent);
      return module === undefined ? undefined : memberRef(module, (declaration.propertyName ?? declaration.name).text);
    }
    if (ts.isImportClause(declaration) || ts.isNamespaceImport(declaration)) {
      const clause = ts.isImportClause(declaration) ? declaration : declaration.parent;
      const module = this.moduleOf(clause.parent);
      return module === undefined || clause.isTypeOnly ? undefined : { kind: "namespace", module };
    }
    if (ts.isImportEqualsDeclaration(declaration)) {
      const reference = declaration.moduleReference;
      const module = ts.isExternalModuleReference(reference) ? stringOf(reference.expression) : undefined;
      return module === undefined || declaration.isTypeOnly ? undefined : { kind: "namespace", module: moduleName(module) };
    }
    if (ts.isVariableDeclaration(declaration)) {
      if (!isConst(declaration) || declaration.initializer === undefined || !ts.isIdentifier(declaration.name)) return undefined;
      return this.resolve(declaration.initializer, depth + 1);
    }
    if (ts.isBindingElement(declaration)) return this.destructured(declaration, depth);
    return undefined;
  }

  private destructured(element: ts.BindingElement, depth: number): Ref | undefined {
    const pattern = element.parent;
    const declaration = pattern.parent;
    if (
      !ts.isObjectBindingPattern(pattern) ||
      !ts.isVariableDeclaration(declaration) ||
      !isConst(declaration) ||
      declaration.initializer === undefined ||
      element.dotDotDotToken !== undefined ||
      element.initializer !== undefined ||
      !ts.isIdentifier(element.name)
    ) {
      return undefined;
    }
    const key = element.propertyName === undefined ? element.name.text : ts.isIdentifier(element.propertyName) || ts.isStringLiteral(element.propertyName) ? element.propertyName.text : undefined;
    return key === undefined ? undefined : this.of(this.resolve(declaration.initializer, depth + 1), key);
  }

  private moduleOf(declaration: ts.Node): string | undefined {
    if (!ts.isImportDeclaration(declaration)) return undefined;
    const specifier = stringOf(declaration.moduleSpecifier);
    return specifier === undefined ? undefined : moduleName(specifier);
  }
}

function isConst(declaration: ts.VariableDeclaration): boolean {
  return (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0;
}

/** The expression exactly as written; display shortens it, comparison never does. */
function written(node: ts.Node, file: ts.SourceFile): string {
  return node.getText(file);
}

function targetOf(call: ts.CallExpression | ts.NewExpression, index: number | null): EffectTarget {
  if (index === null) return "none";
  const args = call.arguments ?? [];
  if (args.slice(0, index + 1).some(ts.isSpreadElement)) return "unknown";
  const literal = stringOf(args[index] === undefined ? undefined : unwrap(args[index]));
  return literal === undefined ? "unknown" : { literal };
}

/**
 * Code loaded at run time: a `require` or `import()` whose first argument is not a string literal,
 * or a `createRequire`. Its target is always unknown, because what loads is decided at run time.
 */
function runTimeLoad(resolver: Resolver, call: ts.CallExpression): string | undefined {
  const [first] = call.arguments;
  const literal = first !== undefined && stringOf(unwrap(first)) !== undefined;
  if (ts.isToken(call.expression) && call.expression.kind === ts.SyntaxKind.ImportKeyword) return literal ? undefined : "import()";
  if (resolver.isCreateRequire(call)) return "module createRequire";
  return resolver.isGlobalRequire(call) && !literal ? "require" : undefined;
}

/** Every call in the file that reaches a catalog resource, in source order. */
export function effectSites(file: ts.SourceFile, checker: ts.TypeChecker): EffectSite[] {
  if (file.isDeclarationFile) return [];
  const resolver = new Resolver(file, checker);
  const sites: EffectSite[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const operation = runTimeLoad(resolver, node);
      if (operation !== undefined) {
        sites.push({
          resource: "code loaded at run time",
          operation,
          target: "unknown",
          args: resolver.elements(node.arguments, 0),
          start: node.getStart(file),
          end: node.end,
        });
      }
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const entry = resolver.resolveCallee(node);
      if (entry !== undefined) {
        sites.push({
          resource: entry.resource,
          operation: effectKey(entry),
          target: targetOf(node, entry.target),
          args: resolver.elements(node.arguments ?? [], 0),
          start: node.getStart(file),
          end: node.end,
        });
      }
    }
    node.forEachChild(visit);
  };
  visit(file);
  return sites;
}

/**
 * Calls that decide which file a module name or path means and load nothing at run time:
 * require.resolve and import() of a literal. The others are effects (see runTimeLoad).
 */
export function resolutionSites(file: ts.SourceFile, checker: ts.TypeChecker): ResolutionSite[] {
  if (file.isDeclarationFile) return [];
  const resolver = new Resolver(file, checker);
  const sites: ResolutionSite[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const isImport = ts.isToken(node.expression) && node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const operation = isImport
        ? runTimeLoad(resolver, node) === undefined ? "import()" : undefined
        : resolver.isRequireResolve(node)
          ? "require.resolve"
          : undefined;
      if (operation !== undefined) {
        sites.push({ operation, args: resolver.elements(node.arguments, 0), start: node.getStart(file), end: node.end });
      }
    }
    node.forEachChild(visit);
  };
  visit(file);
  return sites;
}
