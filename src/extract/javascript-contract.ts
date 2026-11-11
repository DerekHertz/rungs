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

const isCodeNode = (node: ts.Node | undefined): boolean => node !== undefined && !ts.isVariableDeclaration(node) && !ts.isBindingElement(node);

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

function chainText(target: ts.Expression): string | undefined {
  if (ts.isIdentifier(target)) return target.text;
  if (ts.isPropertyAccessExpression(target)) {
    const object = chainText(target.expression);
    return object === undefined ? undefined : `${object}.${target.name.text}`;
  }
  if (ts.isElementAccessExpression(target)) {
    const key = unwrap(target.argumentExpression);
    const object = chainText(target.expression);
    const literal = ts.isStringLiteralLike(key) ? key.text : undefined;
    return object === undefined || literal === undefined ? undefined : `${object}.${literal}`;
  }
  return undefined;
}

/**
 * The class and function syntax nodes a file exports from its top level: `export` declarations,
 * `export default`, `export { f }` and `export = f`, and in plain JavaScript `module.exports = ...`,
 * `module.exports.f = ...` and `exports.f = ...`. A name resolves only to a top-level function or
 * class declaration, or a top-level variable initialised with a function or class expression.
 * Exported variables whose value is not a function or class are nodes too: the variable's
 * declaration, `exports.X = value` and `module.exports.X = value`; see constantSignature. Each
 * node comes with the names it is exported under: `default`, the name a specifier or `exports.f` gives, or `*` when
 * any name may reach it (`module.exports = ...`, `export =`).
 */
export function exportedNodes(file: ts.SourceFile): ReadonlyMap<ts.Node, readonly string[]> {
  const locals = new Map<string, ts.Node>();
  for (const statement of file.statements) {
    if ((ts.isFunctionDeclaration(statement) && statement.body !== undefined) || ts.isClassDeclaration(statement)) {
      if (statement.name !== undefined) locals.set(statement.name.text, statement);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (hasModifier(statement, ts.SyntaxKind.DeclareKeyword)) continue;
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
  };
  // An export of a value that is not code is itself the export: a constant named `as`. A function
  // or class it names is exported under that name instead, as before; a constant it names is not
  // exported, so one export is one contract.
  const markBinding = (value: ts.Expression, constant: ts.Node, as: string): void => {
    if (isCodeValue(value)) mark(value, as);
    else if (ts.isIdentifier(value) && isCodeNode(locals.get(value.text))) markLocal(value.text, as);
    else mark(constant, as);
  };
  const markValue = (expression: ts.Expression, objects: boolean, as: string): void => {
    const value = unwrap(expression);
    if (isCodeValue(value)) mark(value, as);
    else if (ts.isIdentifier(value)) markLocal(value.text, as);
    else if (objects && ts.isObjectLiteralExpression(value)) {
      for (const property of value.properties) {
        if (ts.isShorthandPropertyAssignment(property)) markLocal(property.name.text, as);
        else if (ts.isPropertyAssignment(property)) markValue(property.initializer, false, as);
        else if (ts.isMethodDeclaration(property) || ts.isAccessor(property)) mark(property, as);
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
    } else if (ts.isVariableStatement(statement)) {
      if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue;
      if (hasModifier(statement, ts.SyntaxKind.DeclareKeyword)) continue;
      for (const declaration of statement.declarationList.declarations) {
        const value = declaration.initializer === undefined ? undefined : unwrap(declaration.initializer);
        if (ts.isIdentifier(declaration.name) && value !== undefined) markBinding(value, declaration, declaration.name.text);
        else for (const target of variableTargets(declaration)) mark(target.node, target.name);
      }
    } else if (ts.isExportAssignment(statement)) {
      markValue(statement.expression, true, statement.isExportEquals === true ? "*" : "default");
    } else if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      if (statement.moduleSpecifier !== undefined || statement.isTypeOnly || clause === undefined || !ts.isNamedExports(clause)) continue;
      for (const specifier of clause.elements) {
        if (!specifier.isTypeOnly) markLocal((specifier.propertyName ?? specifier.name).text, specifier.name.text);
      }
    } else if (ts.isExpressionStatement(statement)) {
      const targets: { readonly name: string; readonly assignment: ts.BinaryExpression }[] = [];
      let value = unwrap(statement.expression);
      while (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const target = chainText(value.left);
        if (target !== undefined) targets.push({ name: target, assignment: value });
        value = unwrap(value.right);
      }
      if (targets.some((target) => target.name === "module.exports")) markValue(value, true, "*");
      else {
        for (const { name, assignment } of targets) {
          if (!/^(module\.)?exports\.[^.]+$/.test(name)) continue;
          const as = name.slice(name.lastIndexOf(".") + 1);
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

/**
 * The signature of an exported constant, the first of these that applies: its declared type
 * annotation (or the type it is asserted at); its initializer's text as written when that is a
 * primitive literal; the text of an `as const` object or array literal, laid out the way type
 * text is; the kind of initializer ("object", "array", "call", ...) when a change inside it shows
 * as an altered block and not as a contract move; otherwise the initializer's own text, so no
 * change to something unreadable goes unseen. A destructured name reads "destructured".
 */
export function constantSignature(node: ts.VariableDeclaration | ts.BindingElement | ts.BinaryExpression, file: ts.SourceFile): string {
  const declaration = ts.isBindingElement(node) ? ts.walkUpBindingElementsAndPatterns(node) : node;
  const type = ts.isBinaryExpression(declaration) ? undefined : declaration.type;
  if (type !== undefined) return renderSignature(tokensOf(type, file));
  if (ts.isBindingElement(node)) return "destructured";
  const initializer = ts.isVariableDeclaration(node) ? node.initializer : (node as ts.BinaryExpression).right;
  if (initializer === undefined) return "uninitialised";
  const asserted = assertedType(initializer);
  if (asserted !== undefined) return renderSignature(tokensOf(asserted, file));
  const value = unwrap(initializer);
  if (isPrimitiveLiteral(value)) return value.getText(file);
  if (hasAsConst(initializer) && (ts.isObjectLiteralExpression(value) || ts.isArrayLiteralExpression(value))) return renderSignature(literalTokens(value, file));
  return kindOf(value) ?? literalTokens(value, file).join(" ");
}

/** A constant as the outline records it: the node it is, what to name it, and the node whose text it spans. */
export interface ConstantSite {
  readonly node: ts.VariableDeclaration | ts.BindingElement | ts.BinaryExpression;
  readonly text: string;
  readonly span: ts.Node;
}

/**
 * The constants among a file's exported nodes: a variable that is not a function or class, or a
 * CommonJS `exports.X = value`. A lone declaration spans its whole statement, `export` included.
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
      sites.push({ node, text: chainText(node.left) ?? node.left.getText(file), span: ts.isExpressionStatement(statement) ? statement : node });
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
  const children = node.getChildren(file);
  if (children.length === 0) {
    const text = node.getText(file);
    if (text !== "") out.push(text);
    return;
  }
  for (const child of children) leaves(child, file, out);
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

/** Declarations sharing a name (interface merging) read as one member list. */
function typeSignature(local: Local, file: ts.SourceFile): string {
  const [first] = local.declarations;
  const out: string[] = [];
  if (first?.typeParameters !== undefined) out.push(...listOf(first.typeParameters, "<", ">", file));
  if (first !== undefined && ts.isTypeAliasDeclaration(first)) out.push("=", ...tokensOf(first.type, file));
  else {
    const interfaces = local.declarations.filter(ts.isInterfaceDeclaration);
    for (const declaration of interfaces) for (const clause of declaration.heritageClauses ?? []) out.push(...tokensOf(clause, file));
    out.push(...membersOf(interfaces.flatMap((declaration) => [...declaration.members]), file));
  }
  return renderSignature(out);
}

const nameText = (name: ts.Node): string => (ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : name.getText());

function scan(statements: readonly ts.Statement[], file: ts.SourceFile, prefix: string, ambient: boolean, found: Map<string, TypeContract>, implicit = false): void {
  const locals = new Map<string, Local>();
  const names = new Map<string, string>();
  const exportedAs = (statement: ts.Statement, local: string): void => {
    if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) names.set("default", local);
    else if (implicit || hasModifier(statement, ts.SyntaxKind.ExportKeyword)) names.set(local, local);
  };
  for (const statement of statements) {
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
      const name = statement.name.text;
      const local = locals.get(name) ?? { kind: ts.isInterfaceDeclaration(statement) ? "interface" : "type", declarations: [] };
      local.declarations.push(statement);
      locals.set(name, local);
      if (hasModifier(statement, ts.SyntaxKind.ExportKeyword) || implicit) exportedAs(statement, name);
    } else if (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name) && statement.body !== undefined) {
      if (!implicit && !hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue;
      const inside = ambient || hasModifier(statement, ts.SyntaxKind.DeclareKeyword);
      scan(ts.isModuleBlock(statement.body) ? statement.body.statements : [statement.body as ts.Statement], file, `${prefix}${statement.name.text}.`, inside, found, inside || !ts.isModuleBlock(statement.body));
    } else if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
      names.set(statement.isExportEquals === true ? "export=" : "default", statement.expression.text);
    } else if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      const from = statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : undefined;
      if (from === undefined) {
        if (clause !== undefined && ts.isNamedExports(clause)) for (const element of clause.elements) names.set(nameText(element.name), nameText(element.propertyName ?? element.name));
      } else if (clause === undefined) found.set(`${prefix}* from "${from}"`, { name: `${prefix}* from "${from}"`, kind: "re-export", signature: "*" });
      else if (ts.isNamespaceExport(clause)) found.set(prefix + nameText(clause.name), { name: prefix + nameText(clause.name), kind: "re-export", signature: `* from "${from}"` });
      else for (const element of clause.elements) found.set(prefix + nameText(element.name), { name: prefix + nameText(element.name), kind: "re-export", signature: `${nameText(element.propertyName ?? element.name)} from "${from}"` });
    }
  }
  for (const [exported, localName] of names) {
    const local = locals.get(localName);
    if (local !== undefined) found.set(prefix + exported, { name: prefix + exported, kind: local.kind, signature: typeSignature(local, file) });
  }
}

/**
 * The interfaces and type aliases a file exports, keyed by the name an importer uses ("default"
 * for a default export), sorted by name: `export` declarations, `export default X`, `export { X as Y }`,
 * the members of exported or ambient namespaces (named `Namespace.Name`), and re-exports from
 * another file, which read as `Name from "./file"` since their shape is not resolved here.
 */
export function exportedTypes(file: ts.SourceFile): TypeContract[] {
  const found = new Map<string, TypeContract>();
  scan(file.statements, file, "", file.isDeclarationFile, found);
  return [...found.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
