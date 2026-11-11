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
 * Exported bindings that are not functions or classes are left out.
 */
export function exportedNodes(file: ts.SourceFile): ReadonlySet<ts.Node> {
  const locals = new Map<string, ts.Node>();
  for (const statement of file.statements) {
    if ((ts.isFunctionDeclaration(statement) && statement.body !== undefined) || ts.isClassDeclaration(statement)) {
      if (statement.name !== undefined) locals.set(statement.name.text, statement);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const value = declaration.initializer === undefined ? undefined : unwrap(declaration.initializer);
        if (ts.isIdentifier(declaration.name) && value !== undefined && isCodeValue(value)) {
          locals.set(declaration.name.text, value);
        }
      }
    }
  }

  const exported = new Set<ts.Node>();
  const markLocal = (name: string): void => {
    const node = locals.get(name);
    if (node !== undefined) exported.add(node);
  };
  const markValue = (expression: ts.Expression, objects: boolean): void => {
    const value = unwrap(expression);
    if (isCodeValue(value)) exported.add(value);
    else if (ts.isIdentifier(value)) markLocal(value.text);
    else if (objects && ts.isObjectLiteralExpression(value)) {
      for (const property of value.properties) {
        if (ts.isShorthandPropertyAssignment(property)) markLocal(property.name.text);
        else if (ts.isPropertyAssignment(property)) markValue(property.initializer, false);
        else if (ts.isMethodDeclaration(property) || ts.isAccessor(property)) exported.add(property);
      }
    }
  };

  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      if (hasModifier(statement, ts.SyntaxKind.ExportKeyword) && !hasModifier(statement, ts.SyntaxKind.DeclareKeyword)) {
        if (!ts.isFunctionDeclaration(statement) || statement.body !== undefined) exported.add(statement);
      }
    } else if (ts.isVariableStatement(statement)) {
      if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (declaration.initializer !== undefined) markValue(declaration.initializer, false);
      }
    } else if (ts.isExportAssignment(statement)) {
      markValue(statement.expression, true);
    } else if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      if (statement.moduleSpecifier !== undefined || statement.isTypeOnly || clause === undefined || !ts.isNamedExports(clause)) continue;
      for (const specifier of clause.elements) {
        if (!specifier.isTypeOnly) markLocal((specifier.propertyName ?? specifier.name).text);
      }
    } else if (ts.isExpressionStatement(statement)) {
      const targets: string[] = [];
      let value = unwrap(statement.expression);
      while (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const target = chainText(value.left);
        if (target !== undefined) targets.push(target);
        value = unwrap(value.right);
      }
      if (targets.includes("module.exports")) markValue(value, true);
      else if (targets.some((target) => /^(module\.)?exports\.[^.]+$/.test(target))) markValue(value, false);
    }
  }
  return exported;
}

function leaves(node: ts.Node, file: ts.SourceFile, out: string[]): void {
  if (ts.isJSDoc(node)) return;
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

/** A member as written without the separator that ends it, so `;` against `,` is not a change. */
function interfaceMember(member: ts.TypeElement, file: ts.SourceFile): string[] {
  const tokens = tokensOf(member, file);
  const last = tokens[tokens.length - 1];
  return last === ";" || last === "," ? tokens.slice(0, -1) : tokens;
}

function typeSignature(node: ts.InterfaceDeclaration | ts.TypeAliasDeclaration, file: ts.SourceFile): string {
  const out: string[] = [];
  if (node.typeParameters !== undefined) out.push(...listOf(node.typeParameters, "<", ">", file));
  if (ts.isTypeAliasDeclaration(node)) out.push("=", ...tokensOf(node.type, file));
  else {
    for (const clause of node.heritageClauses ?? []) out.push(...tokensOf(clause, file));
    out.push("{");
    node.members.forEach((member, index) => out.push(...(index === 0 ? [] : [";"]), ...interfaceMember(member, file)));
    out.push("}");
  }
  // A separator before a closing brace is layout (`{ a: 1; }` reads as `{ a: 1 }`).
  return renderSignature(out.filter((token, index) => !((token === ";" || token === ",") && out[index + 1] === "}")));
}

/**
 * The top-level interfaces and type aliases a file exports, by `export` or by an `export { X }`
 * or `export type { X }` clause, sorted by name. Declarations sharing a name (interface merging)
 * read as one signature, joined in source order.
 */
export function exportedTypes(file: ts.SourceFile): TypeContract[] {
  const found = new Map<string, { kind: TypeContract["kind"]; signatures: string[]; exported: boolean }>();
  const listed = new Set<string>();
  for (const statement of file.statements) {
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
      const name = statement.name.text;
      const entry = found.get(name) ?? { kind: ts.isInterfaceDeclaration(statement) ? "interface" : "type", signatures: [], exported: false };
      entry.signatures.push(typeSignature(statement, file));
      entry.exported ||= hasModifier(statement, ts.SyntaxKind.ExportKeyword);
      found.set(name, entry);
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier === undefined && statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)) {
      for (const specifier of statement.exportClause.elements) listed.add((specifier.propertyName ?? specifier.name).text);
    }
  }
  return [...found]
    .filter(([name, entry]) => entry.exported || listed.has(name))
    .map(([name, entry]): TypeContract => ({ name, kind: entry.kind, signature: entry.signatures.join(" ; ") }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
