import ts from "typescript";

const WITHHELD = "(signature withheld)";

/** Thrown for any syntax the allow-list below does not cover; the whole signature is then withheld. */
class Withheld extends Error {}
const outside = (): never => {
  throw new Withheld();
};

const KEYWORD_TYPES: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.AnyKeyword,
  ts.SyntaxKind.UnknownKeyword,
  ts.SyntaxKind.NumberKeyword,
  ts.SyntaxKind.BigIntKeyword,
  ts.SyntaxKind.ObjectKeyword,
  ts.SyntaxKind.BooleanKeyword,
  ts.SyntaxKind.StringKeyword,
  ts.SyntaxKind.SymbolKeyword,
  ts.SyntaxKind.VoidKeyword,
  ts.SyntaxKind.UndefinedKeyword,
  ts.SyntaxKind.NeverKeyword,
]);

const list = (nodes: readonly ts.Node[], print: (node: never) => string, separator = ", "): string => nodes.map((node) => print(node as never)).join(separator);

/** A name that is only an identifier or a number, as written; a string or computed name is a value and shows as a placeholder. */
function nameOf(name: ts.PropertyName | ts.BindingName): string {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isNumericLiteral(name)) return name.text.length === 0 ? outside() : name.getText();
  return ts.isComputedPropertyName(name) ? "[…]" : '"…"';
}

function entity(name: ts.EntityName | ts.Expression): string {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isQualifiedName(name)) return `${entity(name.left)}.${name.right.text}`;
  if (ts.isPropertyAccessExpression(name) && ts.isIdentifier(name.name)) return `${entity(name.expression)}.${name.name.text}`;
  return outside();
}

const typeArguments = (args: readonly ts.TypeNode[] | undefined): string => (args === undefined || args.length === 0 ? "" : `<${list(args, type)}>`);

/** A type, only where it holds no expression: a string or template literal type, or a typeof query, shows as a placeholder. */
function type(node: ts.TypeNode): string {
  if (KEYWORD_TYPES.has(node.kind)) return node.getText();
  if (ts.isThisTypeNode(node)) return "this";
  if (ts.isTypeReferenceNode(node)) return entity(node.typeName) + typeArguments(node.typeArguments);
  if (ts.isArrayTypeNode(node)) return `${type(node.elementType)}[]`;
  if (ts.isTupleTypeNode(node)) return `[${list(node.elements, type)}]`;
  if (ts.isNamedTupleMember(node)) return `${node.dotDotDotToken === undefined ? "" : "..."}${nameOf(node.name)}${node.questionToken === undefined ? "" : "?"}: ${type(node.type)}`;
  if (ts.isOptionalTypeNode(node)) return `${type(node.type)}?`;
  if (ts.isRestTypeNode(node)) return `...${type(node.type)}`;
  if (ts.isUnionTypeNode(node)) return list(node.types, type, " | ");
  if (ts.isIntersectionTypeNode(node)) return list(node.types, type, " & ");
  if (ts.isParenthesizedTypeNode(node)) return `(${type(node.type)})`;
  if (ts.isFunctionTypeNode(node)) return `${typeParameters(node.typeParameters)}${parameters(node.parameters)} => ${type(node.type)}`;
  if (ts.isConstructorTypeNode(node)) return `${node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AbstractKeyword) ? "abstract " : ""}new ${typeParameters(node.typeParameters)}${parameters(node.parameters)} => ${type(node.type)}`;
  if (ts.isTypeLiteralNode(node)) return node.members.length === 0 ? "{}" : `{ ${list(node.members, member, "; ")} }`;
  if (ts.isLiteralTypeNode(node)) {
    const literal = node.literal;
    if (literal.kind === ts.SyntaxKind.NullKeyword || literal.kind === ts.SyntaxKind.TrueKeyword || literal.kind === ts.SyntaxKind.FalseKeyword) return literal.getText();
    if (ts.isNumericLiteral(literal) || ts.isBigIntLiteral(literal)) return literal.getText();
    if (ts.isPrefixUnaryExpression(literal) && ts.isNumericLiteral(literal.operand)) return literal.getText();
    if (ts.isStringLiteral(literal) || ts.isNoSubstitutionTemplateLiteral(literal)) return '"…"';
    return outside();
  }
  if (ts.isTemplateLiteralTypeNode(node)) return "`…`";
  if (ts.isTypeQueryNode(node)) return "typeof …";
  if (ts.isTypeOperatorNode(node)) return `${ts.tokenToString(node.operator) ?? outside()} ${type(node.type)}`;
  if (ts.isIndexedAccessTypeNode(node)) return `${type(node.objectType)}[${type(node.indexType)}]`;
  if (ts.isConditionalTypeNode(node)) return `${type(node.checkType)} extends ${type(node.extendsType)} ? ${type(node.trueType)} : ${type(node.falseType)}`;
  if (ts.isInferTypeNode(node)) return `infer ${node.typeParameter.name.text}`;
  if (ts.isTypePredicateNode(node)) return `${node.assertsModifier === undefined ? "" : "asserts "}${ts.isThisTypeNode(node.parameterName) ? "this" : node.parameterName.text}${node.type === undefined ? "" : ` is ${type(node.type)}`}`;
  return outside();
}

const annotation = (node: ts.TypeNode | undefined): string => (node === undefined ? "" : `: ${type(node)}`);

function typeParameter(node: ts.TypeParameterDeclaration): string {
  return `${node.name.text}${node.constraint === undefined ? "" : ` extends ${type(node.constraint)}`}${node.default === undefined ? "" : " = …"}`;
}

const typeParameters = (nodes: readonly ts.TypeParameterDeclaration[] | undefined): string => (nodes === undefined || nodes.length === 0 ? "" : `<${list(nodes, typeParameter)}>`);

const MODIFIERS: ReadonlyMap<ts.SyntaxKind, string> = new Map([
  [ts.SyntaxKind.PublicKeyword, "public"],
  [ts.SyntaxKind.PrivateKeyword, "private"],
  [ts.SyntaxKind.ProtectedKeyword, "protected"],
  [ts.SyntaxKind.ReadonlyKeyword, "readonly"],
  [ts.SyntaxKind.StaticKeyword, "static"],
  [ts.SyntaxKind.AbstractKeyword, "abstract"],
  [ts.SyntaxKind.AsyncKeyword, "async"],
  [ts.SyntaxKind.OverrideKeyword, "override"],
]);

const modifiers = (node: ts.Node): string[] => (ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []).flatMap((modifier) => MODIFIERS.get(modifier.kind) ?? []) : []);
const words = (...parts: readonly (string | undefined)[]): string => parts.filter((part) => part !== undefined && part !== "").join(" ");

/** A parameter: its modifiers, rest marker, name (a pattern shows as a placeholder), optional marker and annotation; a default is `= …`. */
function parameter(node: ts.ParameterDeclaration): string {
  const name = ts.isIdentifier(node.name) ? node.name.text : "…";
  return `${words(...modifiers(node))}${modifiers(node).length > 0 ? " " : ""}${node.dotDotDotToken === undefined ? "" : "..."}${name}${node.questionToken === undefined ? "" : "?"}${annotation(node.type)}${node.initializer === undefined ? "" : " = …"}`;
}

const parameters = (nodes: readonly ts.ParameterDeclaration[]): string => `(${list(nodes, parameter)})`;
const shape = (node: ts.SignatureDeclarationBase): string => `${typeParameters(node.typeParameters)}${parameters(node.parameters)}${annotation(node.type)}`;
const flavour = (node: ts.Node, extra: readonly string[] = []): string[] => [...modifiers(node), ...("asteriskToken" in node && node.asteriskToken !== undefined ? ["*"] : []), ...extra];
const marked = (node: { readonly questionToken?: ts.QuestionToken; readonly exclamationToken?: ts.ExclamationToken }): string => `${node.questionToken === undefined ? "" : "?"}${node.exclamationToken === undefined ? "" : "!"}`;

/** A member of a type literal or a class: what a caller sees, never a body or an initializer. */
function member(node: ts.TypeElement | ts.ClassElement): string {
  if (ts.isCallSignatureDeclaration(node)) return shape(node);
  if (ts.isConstructSignatureDeclaration(node)) return `new ${shape(node)}`;
  if (ts.isConstructorDeclaration(node)) return `constructor${shape(node)}`;
  if (ts.isMethodSignature(node) || ts.isMethodDeclaration(node)) return `${words(...flavour(node), `${nameOf(node.name)}${marked(node)}`)}${shape(node)}`;
  if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) return `${words(...flavour(node, [ts.isGetAccessorDeclaration(node) ? "get" : "set"]), nameOf(node.name))}${shape(node)}`;
  if (ts.isPropertySignature(node) || ts.isPropertyDeclaration(node)) {
    const initial = "initializer" in node && node.initializer !== undefined ? " = …" : "";
    return `${words(...flavour(node), `${nameOf(node.name)}${marked(node)}`)}${node.type === undefined ? initial : annotation(node.type)}`;
  }
  if (ts.isIndexSignatureDeclaration(node)) return `${words(...flavour(node))}${words(...flavour(node)) === "" ? "" : " "}[${list(node.parameters, parameter)}]${annotation(node.type)}`;
  return outside();
}

function heritage(clause: ts.HeritageClause): string {
  const keyword = clause.token === ts.SyntaxKind.ExtendsKeyword ? "extends" : "implements";
  return `${keyword} ${list(clause.types, (node: ts.ExpressionWithTypeArguments) => entity(node.expression) + typeArguments(node.typeArguments))}`;
}

/** Statements that are not members of a class a caller sees (a static block, a semicolon) say nothing. */
const callerSees = (node: ts.ClassElement): boolean => !ts.isClassStaticBlockDeclaration(node) && !ts.isSemicolonClassElement(node);

function render(source: string): string | undefined {
  const parsed = (text: string): ts.SourceFile | undefined => {
    const file = ts.createSourceFile("signature.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    return ((file as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics ?? []).length === 0 ? file : undefined;
  };
  const flavoured = /^(async\s+)?(\*\s*)?/.exec(source)?.[0] ?? "";
  const call = parsed(`type T = { ${source.slice(flavoured.length)} }`);
  const literal = call?.statements[0];
  if (literal !== undefined && ts.isTypeAliasDeclaration(literal) && ts.isTypeLiteralNode(literal.type) && literal.type.members.length > 0 && literal.type.members.every(ts.isCallSignatureDeclaration)) {
    return flavoured + list(literal.type.members, member, "; ");
  }
  const declaration = parsed(`class C ${source}`)?.statements[0];
  if (declaration !== undefined && ts.isClassDeclaration(declaration)) {
    const head = [typeParameters(declaration.typeParameters), ...(declaration.heritageClauses ?? []).map(heritage)].filter((part) => part !== "");
    const members = declaration.members.filter(callerSees).map(member);
    return `${head.join(" ")}${head.length > 0 ? " " : ""}${members.length === 0 ? "{}" : `{ ${members.join("; ")} }`}`;
  }
  return undefined;
}

/**
 * A node's signature as an agent may see it. A signature holds expressions (defaults, computed
 * names, initializers, literal and typeof types), which are source text, so it is rebuilt from an
 * allow-list: parameter names, rest and optional markers, modifiers, and type annotations without
 * expressions. A default or an initializer is `= …`, a pattern or computed name `…`, a string or
 * template literal type `"…"`. Whatever the list does not cover, or does not parse, withholds the
 * whole signature.
 */
export function promptSignature(signature: string): string {
  try {
    return render(signature) ?? WITHHELD;
  } catch (error) {
    if (error instanceof Withheld) return WITHHELD;
    throw error;
  }
}
