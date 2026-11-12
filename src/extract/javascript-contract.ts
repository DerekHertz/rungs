import ts from "typescript";
import type { TypeContract } from "../graph.ts";

/**
 * What a file exports and how each export reads, for the JavaScript and TypeScript adapter. It
 * describes only what the syntax says: nothing is inferred from types, JSDoc or other files.
 */

const hasModifier = (node: ts.Node, kind: ts.SyntaxKind): boolean =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false);

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
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

// A function or class, the nodes an export of a name moves onto; a variable, enum or namespace is a constant.
const isCodeNode = (node: ts.Node | undefined): boolean =>
  node !== undefined && !ts.isVariableDeclaration(node) && !ts.isBindingElement(node) && !ts.isEnumDeclaration(node) && !ts.isModuleDeclaration(node);

/** The variables a declaration binds: the declaration itself for a plain name, each bound name of a destructuring pattern. */
function variableTargets(declaration: ts.VariableDeclaration): { readonly node: ts.VariableDeclaration | ts.BindingElement; readonly name: string }[] {
  if (ts.isIdentifier(declaration.name)) return [{ node: declaration, name: declaration.name.text }];
  const found: { node: ts.BindingElement; name: string }[] = [];
  const walk = (pattern: ts.BindingName): void => {
    if (ts.isIdentifier(pattern)) return;
    for (const element of pattern.elements) {
      if (ts.isOmittedExpression(element)) continue;
      if (ts.isIdentifier(element.name)) found.push({ node: element, name: element.name.text });
      else walk(element.name);
    }
  };
  walk(declaration.name);
  return found;
}

const isCodeValue = (expression: ts.Expression): expression is ts.FunctionExpression | ts.ArrowFunction | ts.ClassExpression =>
  ts.isFunctionExpression(expression) || ts.isArrowFunction(expression) || ts.isClassExpression(expression);

/** An access chain as its list of keys: `exports["a.b"]` is ["exports", "a.b"], never the text `exports.a.b`. */
function chainKeys(target: ts.Expression): string[] | undefined {
  if (ts.isIdentifier(target)) return [target.text];
  if (ts.isPropertyAccessExpression(target)) {
    const object = chainKeys(target.expression);
    return object === undefined ? undefined : [...object, target.name.text];
  }
  if (ts.isElementAccessExpression(target)) {
    const key = unwrap(target.argumentExpression);
    const object = chainKeys(target.expression);
    return object === undefined || !ts.isStringLiteralLike(key) ? undefined : [...object, key.text];
  }
  return undefined;
}

/** Keys as a name: dotted, except a key that is empty or holds a dot, which is written `["a.b"]` so no chain reads like another. */
function keysText(keys: readonly string[]): string {
  return keys.map((key, index) => (index === 0 ? key : key === "" || key.includes(".") ? `[${JSON.stringify(key)}]` : `.${key}`)).join("");
}

const isModuleExports = (keys: readonly string[]): boolean => keys.length === 2 && keys[0] === "module" && keys[1] === "exports";

/** The key a property is exported under, when the source writes it; undefined for a computed name. */
const propertyKey = (name: ts.PropertyName): string | undefined => {
  if (ts.isComputedPropertyName(name)) {
    const key = unwrap(name.expression);
    return ts.isStringLiteralLike(key) ? key.text : undefined;
  }
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name) ? name.text : undefined;
};

/**
 * The class and function syntax nodes a file exports from its top level: `export` declarations,
 * `export default`, `export { f }` and `export = f`, and in plain JavaScript `module.exports = ...`,
 * `module.exports.f = ...` and `exports.f = ...`. A name resolves only to a top-level function or
 * class declaration, or a top-level variable initialised with a function or class expression.
 * Exported variables whose value is not a function or class are nodes too: the variable's
 * declaration, `exports.X = value` and `module.exports.X = value`, a non-function property of
 * `module.exports = { ... }`, `export default value`, `export declare const`, and enums and
 * namespaces with values in them; see constantSignature. Each
 * node comes with the names it is exported under: `default`, the name a specifier or `exports.f` gives, or `*` when
 * any name may reach it (`module.exports = ...`, `export =`).
 */
export function exportedNodes(file: ts.SourceFile): ReadonlyMap<ts.Node, readonly string[]> {
  const locals = new Map<string, ts.Node>();
  const typeNames = new Set<string>();
  const namespaces = new Map<string, ts.ModuleDeclaration>();
  for (const statement of file.statements) {
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) typeNames.add(statement.name.text);
    if (ts.isImportDeclaration(statement) && statement.importClause !== undefined) {
      const clause = statement.importClause;
      const bindings = clause.namedBindings;
      if (clause.name !== undefined && clause.isTypeOnly) typeNames.add(clause.name.text);
      if (bindings !== undefined && ts.isNamespaceImport(bindings) && clause.isTypeOnly) typeNames.add(bindings.name.text);
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const specifier of bindings.elements) if (clause.isTypeOnly || specifier.isTypeOnly) typeNames.add(specifier.name.text);
      }
    }
    if (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name) && !namespaces.has(statement.name.text)) namespaces.set(statement.name.text, statement);
    if ((ts.isFunctionDeclaration(statement) && statement.body !== undefined) || ts.isClassDeclaration(statement)) {
      if (statement.name !== undefined) locals.set(statement.name.text, statement);
    } else if (ts.isEnumDeclaration(statement) || (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name))) {
      // A function or class of the same name stays what the name means.
      if (!locals.has(statement.name.text)) locals.set(statement.name.text, statement);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const value = declaration.initializer === undefined ? undefined : unwrap(declaration.initializer);
        if (ts.isIdentifier(declaration.name) && value !== undefined && isCodeValue(value)) locals.set(declaration.name.text, value);
        else for (const target of variableTargets(declaration)) locals.set(target.name, target.node);
      }
    }
  }

  const exported = new Map<ts.Node, string[]>();
  const mark = (node: ts.Node, as: string): void => {
    const names = exported.get(node) ?? [];
    if (!names.includes(as)) names.push(as);
    exported.set(node, names);
  };
  const markLocal = (name: string, as: string): void => {
    const node = locals.get(name);
    if (node !== undefined) mark(node, as);
    // A function, class or enum merged with a namespace exports that namespace's values too.
    const space = namespaces.get(name);
    if (node !== undefined && space !== undefined && space !== node) mark(space, as);
  };
  // An export of a value that is not code is itself the export: a constant named `as`. A function
  // or class it names is exported under that name instead, as before; a constant it names is not
  // exported, so one export is one contract.
  const markBinding = (value: ts.Expression, constant: ts.Node, as: string): void => {
    if (isCodeValue(value)) mark(value, as);
    else if (ts.isIdentifier(value) && isCodeNode(locals.get(value.text))) markLocal(value.text, as);
    else mark(constant, as);
  };
  // `commonjs` is set for `module.exports = { ... }`, whose properties are named exports: one that is
  // not a function, class or local is a constant under its key.
  const markValue = (expression: ts.Expression, objects: boolean, as: string, commonjs = false): void => {
    const value = unwrap(expression);
    if (isCodeValue(value)) mark(value, as);
    else if (ts.isIdentifier(value)) markLocal(value.text, as);
    else if (objects && ts.isObjectLiteralExpression(value)) {
      for (const property of value.properties) {
        if (ts.isShorthandPropertyAssignment(property)) {
          const name = property.name.text;
          if (commonjs && name !== "__proto__" && !locals.has(name) && !typeNames.has(name)) for (const exportedName of [name, "default"]) mark(property, exportedName);
          else markLocal(name, as);
        }
        else if (ts.isPropertyAssignment(property)) {
          // `__proto__: value` sets the prototype and is no property; a computed ["__proto__"] is one.
          if (!ts.isComputedPropertyName(property.name) && propertyKey(property.name) === "__proto__") continue;
          const inner = unwrap(property.initializer);
          const key = propertyKey(property.name);
          if (commonjs && key !== undefined && !isCodeValue(inner) && !(ts.isIdentifier(inner) && locals.has(inner.text))) {
            for (const exportedName of [key, "default"]) mark(property, exportedName);
          } else markValue(property.initializer, false, as);
        } else if (ts.isMethodDeclaration(property) || ts.isAccessor(property)) mark(property, as);
      }
    }
  };

  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      if (hasModifier(statement, ts.SyntaxKind.ExportKeyword) && !hasModifier(statement, ts.SyntaxKind.DeclareKeyword)) {
        if (!ts.isFunctionDeclaration(statement) || statement.body !== undefined) {
          mark(statement, hasModifier(statement, ts.SyntaxKind.DefaultKeyword) ? "default" : (statement.name?.text ?? "default"));
        }
      }
    } else if (ts.isEnumDeclaration(statement) || (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name))) {
      if (hasModifier(statement, ts.SyntaxKind.ExportKeyword)) mark(statement, statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue;
      for (const declaration of statement.declarationList.declarations) {
        const value = declaration.initializer === undefined ? undefined : unwrap(declaration.initializer);
        if (ts.isIdentifier(declaration.name) && value !== undefined) markBinding(value, declaration, declaration.name.text);
        else for (const target of variableTargets(declaration)) mark(target.node, target.name);
      }
    } else if (ts.isExportAssignment(statement)) {
      markValue(statement.expression, true, statement.isExportEquals === true ? "*" : "default");
      // A default export that is no function or class, and names no local, is itself a constant: a
      // value, or a name this file does not declare (an import, `undefined`). A type is not one.
      const value = unwrap(statement.expression);
      if (statement.isExportEquals !== true && !isCodeValue(value) && !(ts.isIdentifier(value) && (locals.has(value.text) || typeNames.has(value.text)))) mark(statement, "default");
    } else if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      if (statement.moduleSpecifier !== undefined || statement.isTypeOnly || clause === undefined || !ts.isNamedExports(clause)) continue;
      for (const specifier of clause.elements) {
        if (!specifier.isTypeOnly) markLocal((specifier.propertyName ?? specifier.name).text, specifier.name.text);
      }
    } else if (ts.isExpressionStatement(statement)) {
      const targets: { readonly keys: readonly string[]; readonly assignment: ts.BinaryExpression }[] = [];
      let value = unwrap(statement.expression);
      while (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const keys = chainKeys(value.left);
        if (keys !== undefined) targets.push({ keys, assignment: value });
        value = unwrap(value.right);
      }
      if (targets.some((target) => isModuleExports(target.keys))) markValue(value, true, "*", true);
      else {
        for (const { keys, assignment } of targets) {
          // `exports.x` or `module.exports.x`, one key past the module object, whatever the key holds.
          const named = keys.length === 2 ? keys[0] === "exports" : keys.length === 3 && keys[0] === "module" && keys[1] === "exports";
          if (!named) continue;
          const as = keys[keys.length - 1]!;
          // An ES importer's `default` is the whole CommonJS module, so every export answers to it.
          for (const exportedName of [as, "default"]) {
            markBinding(value, assignment, exportedName);
          }
        }
      }
    }
  }
  return exported;
}

/** A literal whose text is its value: a string, number, bigint, boolean, null, regex or a template with no substitutions. */
function isPrimitiveLiteral(value: ts.Expression): boolean {
  if (ts.isPrefixUnaryExpression(value) && (value.operator === ts.SyntaxKind.MinusToken || value.operator === ts.SyntaxKind.PlusToken)) {
    return ts.isNumericLiteral(value.operand) || ts.isBigIntLiteral(value.operand);
  }
  return (
    ts.isStringLiteralLike(value) ||
    ts.isNumericLiteral(value) ||
    ts.isBigIntLiteral(value) ||
    ts.isRegularExpressionLiteral(value) ||
    value.kind === ts.SyntaxKind.TrueKeyword ||
    value.kind === ts.SyntaxKind.FalseKeyword ||
    value.kind === ts.SyntaxKind.NullKeyword
  );
}

/** Looks through parentheses, `satisfies`, `!` and assertions for an `as const`. */
function hasAsConst(expression: ts.Expression): boolean {
  let current = expression;
  for (;;) {
    if (ts.isAsExpression(current) && ts.isTypeReferenceNode(current.type) && current.type.typeName.getText() === "const") return true;
    if (!(ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isNonNullExpression(current) || ts.isTypeAssertionExpression(current))) return false;
    current = current.expression;
  }
}

/** The type of the outermost non-const assertion (`x as T`, `<T>x`), which is the type the value is exported at. */
function assertedType(expression: ts.Expression): ts.TypeNode | undefined {
  let current = expression;
  while (ts.isParenthesizedExpression(current) || ts.isSatisfiesExpression(current) || ts.isNonNullExpression(current) || ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)) {
    if ((ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)) && !(ts.isTypeReferenceNode(current.type) && current.type.typeName.getText() === "const")) return current.type;
    current = current.expression;
  }
  return undefined;
}

/**
 * What kind of value an initializer is, for the ones whose changes show as an altered block
 * anyway: an object or array not written `as const`, a call, a `new`, a function or class. Any
 * other expression has no kind, and its signature is its own text.
 */
function kindOf(value: ts.Expression): string | undefined {
  if (ts.isObjectLiteralExpression(value)) return "object";
  if (ts.isArrayLiteralExpression(value)) return "array";
  if (ts.isCallExpression(value)) return "call";
  if (ts.isNewExpression(value)) return "new";
  if (ts.isArrowFunction(value)) return "arrow function";
  if (ts.isFunctionExpression(value)) return "function";
  if (ts.isClassExpression(value)) return "class";
  if (ts.isIdentifier(value)) return "identifier";
  return undefined;
}

/** Tokens with layout and comments gone; a trailing comma after an element goes, a comma that makes an array hole stays. */
function literalTokens(expression: ts.Node, file: ts.SourceFile): string[] {
  return tokensOf(expression, file).filter((token, index, all) => !(token === "," && (all[index + 1] === "}" || all[index + 1] === "]") && all[index - 1] !== "," && all[index - 1] !== "["));
}

/** What `constantSignature` and `constantSites` take: a variable, a CommonJS assignment, an object property, a default export, an enum or a namespace. */
export type ConstantNode = ts.VariableDeclaration | ts.BindingElement | ts.BinaryExpression | ts.PropertyAssignment | ts.ShorthandPropertyAssignment | ts.ExportAssignment | ts.EnumDeclaration | ts.ModuleDeclaration;

/**
 * The signature of an exported constant, the first of these that applies: its declared type
 * annotation (or the type it is asserted at); its initializer's text as written when that is a
 * primitive literal; the text of an `as const` object or array literal, laid out the way type
 * text is; the kind of initializer ("object", "array", "call", ...) when a change inside it shows
 * as an altered block and not as a contract move; otherwise the initializer's own text, so no
 * change to something unreadable goes unseen. A destructured name reads "destructured from" and the signature of the whole initializer.
 * An enum reads as its members as written, `enum { A = 1, B }` or `const enum { ... }`; a
 * namespace as its exported values, see namespaceBody.
 */
export function constantSignature(node: ConstantNode, file: ts.SourceFile): string {
  if (ts.isEnumDeclaration(node)) return renderSignature(enumTokens(node, false, file));
  if (ts.isModuleDeclaration(node)) return renderSignature(namespaceTokens(node, false, file) ?? []);
  if (ts.isExportAssignment(node)) return initializerSignature(node.expression, file);
  if (ts.isPropertyAssignment(node)) return initializerSignature(node.initializer, file);
  if (ts.isShorthandPropertyAssignment(node)) return "identifier";
  const declaration = ts.isBindingElement(node) ? ts.walkUpBindingElementsAndPatterns(node) : node;
  const type = ts.isBinaryExpression(declaration) ? undefined : declaration.type;
  if (type !== undefined) return renderSignature(tokensOf(type, file));
  const initializer = ts.isBinaryExpression(declaration) ? declaration.right : declaration.initializer;
  if (ts.isBindingElement(node)) return initializer === undefined ? "destructured" : `destructured from ${initializerSignature(initializer, file)}`;
  if (initializer === undefined) return "uninitialised";
  return initializerSignature(initializer, file);
}

function initializerSignature(initializer: ts.Expression, file: ts.SourceFile): string {
  const asserted = assertedType(initializer);
  if (asserted !== undefined) return renderSignature(tokensOf(asserted, file));
  const value = unwrap(initializer);
  if (isPrimitiveLiteral(value)) return value.getText(file);
  if (hasAsConst(initializer) && (ts.isObjectLiteralExpression(value) || ts.isArrayLiteralExpression(value))) return renderSignature(literalTokens(value, file));
  return kindOf(value) ?? literalTokens(value, file).join(" ");
}

/** An enum as tokens: `const enum`, the name when asked, and the members as written, comma separated whatever the layout. */
function enumTokens(node: ts.EnumDeclaration, named: boolean, file: ts.SourceFile): string[] {
  const blocks = enumBlocks(node);
  return [...(hasModifier(blocks[0]!, ts.SyntaxKind.ConstKeyword) ? ["const"] : []), "enum", ...(named ? [node.name.text] : []), ...listOf(blocks.flatMap((block) => [...block.members]), "{", "}", file)];
}

/** The declarations of an enum: every block of that name beside it, which merge in source order. */
function enumBlocks(node: ts.EnumDeclaration): ts.EnumDeclaration[] {
  const siblings: readonly ts.Node[] = (node.parent as { statements?: ts.NodeArray<ts.Statement> }).statements ?? [node];
  return siblings.filter((statement): statement is ts.EnumDeclaration => ts.isEnumDeclaration(statement) && statement.name.text === node.name.text);
}

/** The declarations of a namespace: every block of that name beside it, since blocks of one name merge. */
function namespaceBlocks(node: ts.ModuleDeclaration): ts.ModuleDeclaration[] {
  const siblings: readonly ts.Node[] = (node.parent as { statements?: ts.NodeArray<ts.Statement> }).statements ?? [node];
  return siblings.filter((statement): statement is ts.ModuleDeclaration => ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name) && statement.name.text === node.name.text);
}

/** The exported values of a namespace; undefined when it holds none, since a namespace of types only is no node. */
function namespaceTokens(node: ts.ModuleDeclaration, named: boolean, file: ts.SourceFile): string[] | undefined {
  return namespaceBody(node.name.text, namespaceBlocks(node).map((block) => ({ block, implicit: hasModifier(block, ts.SyntaxKind.DeclareKeyword) })), named, file);
}

/**
 * A namespace as the values it exports, in source order across all its blocks, each kind as its
 * own syntax reads: `const a = 1`, `function f(x: number): string`, `class C<T> { ... }`, an
 * enum, a nested namespace. Types are left out, since they are contracts of their own (see
 * exportedTypes), and so is what is not exported. In an ambient namespace everything is exported.
 */
function namespaceBody(name: string, blocks: readonly { readonly block: ts.ModuleDeclaration; readonly implicit: boolean }[], named: boolean, file: ts.SourceFile): string[] | undefined {
  const members: string[][] = [];
  const seen = new Set<string>();
  const nested = new Map<string, { block: ts.ModuleDeclaration; implicit: boolean }[]>();
  const order: string[] = [];
  for (const { block, implicit } of blocks) {
    const body = block.body;
    if (body === undefined) continue;
    const statements: readonly ts.Statement[] = ts.isModuleBlock(body) ? body.statements : [body as ts.Statement];
    // A namespace written `A.B` holds B, which is exported whatever it says.
    const dotted = !ts.isModuleBlock(body);
    for (const statement of statements) {
      if (!(dotted || implicit || hasModifier(statement, ts.SyntaxKind.ExportKeyword))) continue;
      if (ts.isVariableStatement(statement)) {
        const keyword = statement.declarationList.flags & ts.NodeFlags.Const ? "const" : statement.declarationList.flags & ts.NodeFlags.BlockScoped ? "let" : "var";
        for (const declaration of statement.declarationList.declarations) {
          for (const target of variableTargets(declaration)) {
            const origin = ts.isBindingElement(target.node) ? ts.walkUpBindingElementsAndPatterns(target.node) : target.node;
            const initializer = ts.isVariableDeclaration(target.node) && origin.type === undefined && target.node.initializer !== undefined ? unwrap(target.node.initializer) : undefined;
            // A function or class value reads as its own signature, as a top-level one does.
            const value = initializer !== undefined && isCodeValue(initializer) ? renderSignature(signatureTokens(initializer, file)) : constantSignature(target.node, file);
            members.push([keyword, target.name, origin.type !== undefined ? ":" : "=", value]);
            order.push(`m${members.length - 1}`);
          }
        }
      } else if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
        if (seen.has(statement.name.text)) continue;
        seen.add(statement.name.text);
        members.push(["function", statement.name.text, ...signatureTokens(statement, file)]);
        order.push(`m${members.length - 1}`);
      } else if (ts.isClassDeclaration(statement) && statement.name !== undefined) {
        members.push(["class", statement.name.text, ...signatureTokens(statement, file)]);
        order.push(`m${members.length - 1}`);
      } else if (ts.isEnumDeclaration(statement)) {
        if (enumBlocks(statement)[0] !== statement) continue;
        members.push(enumTokens(statement, true, file));
        order.push(`m${members.length - 1}`);
      } else if (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name)) {
        const group = nested.get(statement.name.text) ?? [];
        if (group.length === 0) order.push(`n${statement.name.text}`);
        group.push({ block: statement, implicit: implicit || hasModifier(statement, ts.SyntaxKind.DeclareKeyword) });
        nested.set(statement.name.text, group);
      }
    }
  }
  const parts: string[][] = [];
  for (const entry of order) {
    if (entry.startsWith("m")) parts.push(members[Number(entry.slice(1))]!);
    else {
      const inner = namespaceBody(entry.slice(1), nested.get(entry.slice(1))!, true, file);
      if (inner !== undefined) parts.push(inner);
    }
  }
  if (parts.length === 0) return undefined;
  const out = ["namespace", ...(named ? [name] : []), "{"];
  parts.forEach((member, index) => {
    if (index > 0) out.push(";");
    out.push(...member);
  });
  out.push("}");
  return out;
}

/** A constant as the outline records it: the node it is, what to name it, and the node whose text it spans. */
export interface ConstantSite {
  readonly node: ConstantNode;
  readonly text: string;
  readonly span: ts.Node;
}

/**
 * The constants among a file's exported nodes: a variable that is not a function or class, a
 * CommonJS `exports.X = value`, a non-function property of `module.exports = { ... }`, a default
 * export of a value, an enum, or a namespace with values. A lone declaration spans its whole
 * statement, `export` included.
 */
export function constantSites(exported: ReadonlyMap<ts.Node, readonly string[]>, file: ts.SourceFile): ConstantSite[] {
  const sites: ConstantSite[] = [];
  for (const node of exported.keys()) {
    if (ts.isVariableDeclaration(node) || ts.isBindingElement(node)) {
      const declaration = ts.isBindingElement(node) ? ts.walkUpBindingElementsAndPatterns(node) : node;
      const statement = declaration.parent.parent;
      const lone = ts.isVariableStatement(statement) && (declaration.parent as ts.VariableDeclarationList).declarations.length === 1;
      const name = (node.name as ts.Identifier).text;
      sites.push({ node, text: name, span: lone ? statement : declaration });
    } else if (ts.isBinaryExpression(node)) {
      const statement = node.parent;
      const keys = chainKeys(node.left);
      sites.push({ node, text: keys === undefined ? node.left.getText(file) : keysText(keys), span: ts.isExpressionStatement(statement) ? statement : node });
    } else if (ts.isPropertyAssignment(node)) {
      const key = propertyKey(node.name);
      if (key !== undefined) sites.push({ node, text: `module.exports{${key}}`, span: node });
    } else if (ts.isShorthandPropertyAssignment(node)) {
      sites.push({ node, text: `module.exports{${node.name.text}}`, span: node });
    } else if (ts.isExportAssignment(node)) {
      sites.push({ node, text: "default", span: node });
    } else if (ts.isEnumDeclaration(node)) {
      if (enumBlocks(node)[0] === node) sites.push({ node, text: node.name.text, span: node });
    } else if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name) && namespaceBlocks(node)[0] === node && namespaceTokens(node, false, file) !== undefined) {
      sites.push({ node, text: node.name.text, span: node });
    }
  }
  return sites;
}

function leaves(node: ts.Node, file: ts.SourceFile, out: string[]): void {
  if (ts.isJSDoc(node)) return;
  if (ts.isTypeLiteralNode(node)) {
    out.push(...membersOf(node.members, file));
    return;
  }
  if (ts.isTupleTypeNode(node)) {
    out.push(...listOf(node.elements, "[", "]", file));
    return;
  }
  const children = node.getChildren(file);
  if (children.length === 0) {
    const text = node.getText(file);
    if (text !== "") out.push(text);
    return;
  }
  // The `;` that ends a mapped type's body is layout, as it is in a type literal.
  for (const child of children) if (!(ts.isMappedTypeNode(node) && child.kind === ts.SyntaxKind.SemicolonToken)) leaves(child, file, out);
}

const tokensOf = (node: ts.Node, file: ts.SourceFile): string[] => {
  const out: string[] = [];
  leaves(node, file, out);
  return out;
};

function listOf(nodes: readonly ts.Node[], open: string, close: string, file: ts.SourceFile): string[] {
  const out = [open];
  nodes.forEach((node, index) => {
    if (index > 0) out.push(",");
    out.push(...tokensOf(node, file));
  });
  out.push(close);
  return out;
}

function flavour(node: ts.SignatureDeclaration): string[] {
  const out: string[] = [];
  if (ts.canHaveModifiers(node) && hasModifier(node, ts.SyntaxKind.AsyncKeyword)) out.push("async");
  if ("asteriskToken" in node && node.asteriskToken !== undefined) out.push("*");
  return out;
}

function shape(node: ts.SignatureDeclaration, file: ts.SourceFile): string[] {
  const out: string[] = [];
  if (node.typeParameters !== undefined) out.push(...listOf(node.typeParameters, "<", ">", file));
  out.push(...listOf(node.parameters, "(", ")", file));
  if (node.type !== undefined) out.push(":", ...tokensOf(node.type, file));
  return out;
}

const callable = (node: ts.SignatureDeclaration, file: ts.SourceFile): string[] => [...flavour(node), ...shape(node, file)];

const isPublic = (member: ts.ClassElement): boolean =>
  !hasModifier(member, ts.SyntaxKind.PrivateKeyword) &&
  !hasModifier(member, ts.SyntaxKind.ProtectedKeyword) &&
  !(member.name !== undefined && ts.isPrivateIdentifier(member.name));

// A field reads as its modifiers, name and annotation. Without an annotation, a function-valued
// initialiser reads as its parameter list and return annotation; any other initialiser says
// nothing, since its type is not written.
function fieldSignature(member: ts.PropertyDeclaration, file: ts.SourceFile): string[] {
  const out: string[] = [];
  for (const [kind, word] of [
    [ts.SyntaxKind.StaticKeyword, "static"],
    [ts.SyntaxKind.AbstractKeyword, "abstract"],
    [ts.SyntaxKind.ReadonlyKeyword, "readonly"],
  ] as const) {
    if (hasModifier(member, kind)) out.push(word);
  }
  out.push(...tokensOf(member.name, file));
  if (member.questionToken !== undefined) out.push("?");
  if (member.exclamationToken !== undefined) out.push("!");
  const value = member.initializer === undefined ? undefined : unwrap(member.initializer);
  if (member.type !== undefined) out.push(":", ...tokensOf(member.type, file));
  else if (value !== undefined && (ts.isArrowFunction(value) || ts.isFunctionExpression(value))) {
    out.push("=", ...callable(value, file));
  }
  return out;
}

function memberSignature(member: ts.ClassElement, file: ts.SourceFile): string[] | undefined {
  if (!isPublic(member)) return undefined;
  if (ts.isConstructorDeclaration(member)) return ["constructor", ...shape(member, file)];
  if (ts.isPropertyDeclaration(member)) return fieldSignature(member, file);
  if (!ts.isMethodDeclaration(member) && !ts.isAccessor(member)) return undefined;
  const out: string[] = [];
  if (hasModifier(member, ts.SyntaxKind.StaticKeyword)) out.push("static");
  if (hasModifier(member, ts.SyntaxKind.AbstractKeyword)) out.push("abstract");
  if (ts.isGetAccessorDeclaration(member)) out.push("get");
  if (ts.isSetAccessorDeclaration(member)) out.push("set");
  out.push(...flavour(member), ...tokensOf(member.name, file));
  if (member.questionToken !== undefined) out.push("?");
  out.push(...shape(member, file));
  return out;
}

/**
 * The tokens of a class or function's signature as written. A function reads as its modifiers,
 * type parameters, parameter list and return type annotation; a class as its type parameters,
 * heritage clauses and its public methods, constructor and accessors, in source order, each as
 * above. A function with overload signatures reads as its overloads, the only ones callers see.
 * Parameters are separated the same way whatever the source's layout, comments are dropped, and
 * no return type is guessed when none is written.
 */
export function signatureTokens(node: ts.ClassLikeDeclaration | ts.FunctionLikeDeclaration, file: ts.SourceFile): string[] {
  if (ts.isClassLike(node)) {
    const out: string[] = [];
    if (node.typeParameters !== undefined) out.push(...listOf(node.typeParameters, "<", ">", file));
    for (const clause of node.heritageClauses ?? []) out.push(...tokensOf(clause, file));
    out.push("{");
    let first = true;
    for (const member of node.members) {
      const tokens = memberSignature(member, file);
      if (tokens === undefined) continue;
      if (!first) out.push(";");
      first = false;
      out.push(...tokens);
    }
    out.push("}");
    return out;
  }
  if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
    const siblings: readonly ts.Statement[] = (node.parent as { statements?: ts.NodeArray<ts.Statement> }).statements ?? [];
    const overloads = siblings.filter(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.body === undefined && statement.name?.text === node.name!.text,
    );
    if (overloads.length > 0) {
      return overloads.flatMap((overload, index) => [...(index === 0 ? [] : [";"]), ...callable(overload, file)]);
    }
  }
  return callable(node, file);
}

const NO_SPACE_BEFORE = new Set([",", ")", "]", ";", ":", ".", "?.", "<", ">", "?"]);
const NO_SPACE_AFTER = new Set(["(", "[", ".", "?.", "<", "..."]);

/** Single spaces where the source had a token boundary a reader needs, so layout never shows. */
export function renderSignature(tokens: readonly string[]): string {
  let out = "";
  tokens.forEach((token, index) => {
    const previous = tokens[index - 1];
    if (previous !== undefined) {
      const afterName =
        /^[\p{ID_Continue}$]/u.test(previous) || [">", ")", "?"].includes(previous) || /["'`]$/.test(previous);
      const callOpen = (token === "(" || token === "[") && afterName && previous !== "async";
      const emptyBraces = token === "}" && previous === "{";
      if (!NO_SPACE_BEFORE.has(token) && !NO_SPACE_AFTER.has(previous) && !callOpen && !emptyBraces) out += " ";
    }
    out += token;
  });
  return out;
}

/**
 * The members of a type literal or interface as tokens, one `;` between them whatever the source
 * used (`;`, `,` or a line break), so layout never shows.
 */
function membersOf(members: readonly ts.TypeElement[], file: ts.SourceFile): string[] {
  const out = ["{"];
  members.forEach((member, index) => {
    if (index > 0) out.push(";");
    const tokens = tokensOf(member, file);
    const last = tokens[tokens.length - 1];
    out.push(...(last === ";" || last === "," ? tokens.slice(0, -1) : tokens));
  });
  out.push("}");
  return out;
}

/** What an exported name stands for in a file: an interface or type alias, or a re-export of another file's. */
interface Local {
  readonly kind: "interface" | "type";
  readonly declarations: (ts.InterfaceDeclaration | ts.TypeAliasDeclaration)[];
}

/** Declarations sharing a name (interface merging) read as one member list; the extends clauses of all of them are one set. */
function typeSignature(local: Local, file: ts.SourceFile): string {
  const [first] = local.declarations;
  const out: string[] = [];
  if (first?.typeParameters !== undefined) out.push(...listOf(first.typeParameters, "<", ">", file));
  if (first !== undefined && ts.isTypeAliasDeclaration(first)) out.push("=", ...tokensOf(first.type, file));
  else {
    const interfaces = local.declarations.filter(ts.isInterfaceDeclaration);
    // Which interfaces an interface extends is a set: how many clauses say so, and in what order, is layout.
    const parents = new Map<string, string[]>();
    for (const declaration of interfaces) {
      for (const clause of declaration.heritageClauses ?? []) {
        for (const parent of clause.types) {
          const tokens = tokensOf(parent, file);
          parents.set(renderSignature(tokens), tokens);
        }
      }
    }
    const sorted = [...parents.keys()].sort();
    if (sorted.length > 0) {
      out.push("extends");
      sorted.forEach((key, index) => out.push(...(index === 0 ? [] : [","]), ...parents.get(key)!));
    }
    out.push(...membersOf(interfaces.flatMap((declaration) => [...declaration.members]), file));
  }
  return renderSignature(out);
}

const nameText = (name: ts.Node): string => (ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : name.getText());

/** A statement to read for contracts: `implicit` when it is exported without saying so (inside an ambient namespace), `ambient` when it sits in a declaration context. */
interface Entry {
  readonly statement: ts.Statement;
  readonly implicit: boolean;
  readonly ambient: boolean;
}

/** An import of a type, which a re-export of the name passes on without resolving it. */
interface TypeImport {
  readonly from: string;
  readonly imported: string;
  readonly typeOnly: boolean;
}

function typeImportsOf(statements: readonly ts.Statement[]): Map<string, TypeImport> {
  const found = new Map<string, TypeImport>();
  for (const statement of statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.importClause === undefined) continue;
    const from = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    const bindings = clause.namedBindings;
    if (clause.name !== undefined) found.set(clause.name.text, { from, imported: "default", typeOnly: clause.isTypeOnly });
    if (bindings !== undefined && ts.isNamespaceImport(bindings)) found.set(bindings.name.text, { from, imported: "*", typeOnly: clause.isTypeOnly });
    else if (bindings !== undefined) {
      for (const specifier of bindings.elements) found.set(specifier.name.text, { from, imported: nameText(specifier.propertyName ?? specifier.name), typeOnly: clause.isTypeOnly || specifier.isTypeOnly });
    }
  }
  return found;
}

function scan(entries: readonly Entry[], file: ts.SourceFile, prefix: string, found: Map<string, TypeContract>, imports: ReadonlyMap<string, TypeImport> = new Map()): void {
  const locals = new Map<string, Local>();
  const names = new Map<string, string>();
  const typeOnlyNames = new Set<string>();
  // Blocks of one namespace name merge into one: their contents are read together. A namespace
  // is read when it is exported, or named by `export { N }`, `export = N` or `export default N`.
  const spaces = new Map<string, { entries: Entry[]; direct: boolean }>();
  const spaceExports: [prefix: string, local: string][] = [];
  for (const { statement, implicit, ambient } of entries) {
    const exportedAs = (local: string): void => {
      if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) names.set("default", local);
      else if (implicit || hasModifier(statement, ts.SyntaxKind.ExportKeyword)) names.set(local, local);
    };
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
      const name = statement.name.text;
      const local = locals.get(name) ?? { kind: ts.isInterfaceDeclaration(statement) ? "interface" : "type", declarations: [] };
      local.declarations.push(statement);
      locals.set(name, local);
      if (hasModifier(statement, ts.SyntaxKind.ExportKeyword) || implicit) exportedAs(name);
    } else if (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name) && statement.body !== undefined) {
      const space = spaces.get(statement.name.text) ?? { entries: [], direct: false };
      if (implicit || hasModifier(statement, ts.SyntaxKind.ExportKeyword)) space.direct = true;
      const inside = ambient || hasModifier(statement, ts.SyntaxKind.DeclareKeyword);
      const body = statement.body;
      const dotted = !ts.isModuleBlock(body);
      for (const inner of ts.isModuleBlock(body) ? body.statements : [body as ts.Statement]) space.entries.push({ statement: inner, implicit: inside || dotted, ambient: inside });
      spaces.set(statement.name.text, space);
    } else if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
      names.set(statement.isExportEquals === true ? "export=" : "default", statement.expression.text);
      // `export = N` makes the namespace the module, so its members are the file's own exports.
      spaceExports.push([statement.isExportEquals === true ? "" : "default.", statement.expression.text]);
    } else if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      const from = statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : undefined;
      if (from === undefined) {
        if (clause !== undefined && ts.isNamedExports(clause)) {
          for (const element of clause.elements) {
            names.set(nameText(element.name), nameText(element.propertyName ?? element.name));
            if (statement.isTypeOnly || element.isTypeOnly) typeOnlyNames.add(nameText(element.name));
            spaceExports.push([`${nameText(element.name)}.`, nameText(element.propertyName ?? element.name)]);
          }
        }
      } else if (clause === undefined) found.set(`${prefix}* from "${from}"`, { name: `${prefix}* from "${from}"`, kind: "re-export", signature: "*" });
      else if (ts.isNamespaceExport(clause)) found.set(prefix + nameText(clause.name), { name: prefix + nameText(clause.name), kind: "re-export", signature: `* from "${from}"` });
      else for (const element of clause.elements) found.set(prefix + nameText(element.name), { name: prefix + nameText(element.name), kind: "re-export", signature: `${nameText(element.propertyName ?? element.name)} from "${from}"` });
    }
  }
  for (const [exported, localName] of names) {
    const local = locals.get(localName);
    if (local !== undefined) found.set(prefix + exported, { name: prefix + exported, kind: local.kind, signature: typeSignature(local, file) });
    else {
      // A type imported here and exported again is passed on as written, as `export type { A } from` is.
      const source = imports.get(localName);
      if (source !== undefined && (source.typeOnly || typeOnlyNames.has(exported))) {
        found.set(prefix + exported, { name: prefix + exported, kind: "re-export", signature: source.imported === "*" ? `* from "${source.from}"` : `${source.imported} from "${source.from}"` });
      }
    }
  }
  const read = (space: { entries: Entry[] }, namespacePrefix: string): void => scan(space.entries, file, namespacePrefix, found);
  for (const [name, space] of spaces) if (space.direct) read(space, `${prefix}${name}.`);
  for (const [exported, localName] of spaceExports) {
    const space = spaces.get(localName);
    if (space !== undefined) read(space, `${prefix}${exported}`);
  }
}

/**
 * The interfaces and type aliases a file exports, keyed by the name an importer uses ("default"
 * for a default export), sorted by name: `export` declarations, `export default X`, `export { X as Y }`,
 * the members of exported or ambient namespaces (named `Namespace.Name`, also when the namespace
 * is exported by `export { N }` or `export default N`; `export = N` makes its members the file's own),
 * and re-exports from another file, which read as `Name from "./file"` since their shape is not
 * resolved here. Everything a global declaration file (one with no import or export) declares is public.
 */
export function exportedTypes(file: ts.SourceFile): TypeContract[] {
  const found = new Map<string, TypeContract>();
  const global = file.isDeclarationFile && !ts.isExternalModule(file);
  scan(file.statements.map((statement) => ({ statement, implicit: global, ambient: file.isDeclarationFile })), file, "", found, typeImportsOf(file.statements));
  return [...found.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
