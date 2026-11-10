import { posix } from "node:path";
import ts from "typescript";
import type { Declaration, LanguageAdapter, SourceFile } from "./adapters.ts";
import { effectSites } from "./javascript-effects.ts";
import { exportedNodes, renderSignature, signatureTokens } from "./javascript-contract.ts";

// Built over the tree's own files and nothing else, with no default library and no module
// resolution, so the binder's answers cannot depend on what is installed on this machine.
function programOver(files: readonly SourceFile[]): ts.Program {
  const byName = new Map(files.map((file) => [`/${file.path}`, file]));
  const host: ts.CompilerHost = {
    getSourceFile: (name, languageVersion) => {
      const file = byName.get(name);
      return file === undefined
        ? undefined
        : ts.createSourceFile(name, file.text, languageVersion, true, scriptKind(file.path));
    },
    getDefaultLibFileName: () => "/lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (name) => byName.has(name),
    readFile: (name) => byName.get(name)?.text,
  };
  return ts.createProgram({
    rootNames: [...byName.keys()],
    host,
    options: {
      allowJs: true,
      noLib: true,
      noResolve: true,
      types: [],
      noEmit: true,
      target: ts.ScriptTarget.Latest,
      jsx: ts.JsxEmit.Preserve,
    },
  });
}

export const javaScriptAndTypeScript: LanguageAdapter = {
  language: "JavaScript and TypeScript",
  analyse(files) {
    const program = programOver(files);
    const checker = program.getTypeChecker();
    return new Map(
      files.map((file) => {
        const source =
          program.getSourceFile(`/${file.path}`) ??
          ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true, scriptKind(file.path));
        return [file.path, { declarations: outline(source), effects: effectSites(source, checker) }];
      }),
    );
  },
};

export type CodeSyntax = ts.ClassLikeDeclaration | ts.FunctionLikeDeclaration;

const FUNCTION_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
]);

// Every class, and every function with a body, is a node. Overload signatures and abstract
// methods have no body, so they are not; nor is anything in a .d.ts file or under `declare`.
export function isCodeSyntax(node: ts.Node): node is CodeSyntax {
  if (ts.isClassLike(node)) return true;
  return FUNCTION_KINDS.has(node.kind) && (node as ts.FunctionLikeDeclaration).body !== undefined;
}

export function isAmbient(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && hasModifier(node, ts.SyntaxKind.DeclareKeyword);
}

function hasModifier(node: ts.HasModifiers, kind: ts.ModifierSyntaxKind): boolean {
  return ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false;
}

function outline(file: ts.SourceFile): Declaration[] {
  if (file.isDeclarationFile) return [];
  const exported = exportedNodes(file);
  const within = (node: ts.Node): Declaration[] => {
    const found: Declaration[] = [];
    node.forEachChild((child) => {
      if (isAmbient(child)) return;
      if (!isCodeSyntax(child)) {
        found.push(...within(child));
        return;
      }
      found.push({
        level: ts.isClassLike(child) ? "class" : "function",
        text: textOf(child, file),
        start: child.getStart(file),
        end: child.end,
        exported: exported.has(child),
        signature: renderSignature(signatureTokens(child, file)),
        children: within(child),
      });
    });
    return found;
  };
  return within(file);
}

// What the runtime calls the node in its scope: Function.name where the language gives one,
// extended the way V8 and editor outlines name anonymous functions. The first rule that applies
// wins; docs/adr/0001-code-node-identity.md lists them.
function textOf(node: CodeSyntax, file: ts.SourceFile): string {
  const named = ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassLike(node);
  if (named && node.name !== undefined) return inNamespace(node, node.name.text);
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if (ts.isMethodDeclaration(node) || ts.isAccessor(node)) {
    const key = keyText(node.name, file);
    if (ts.isObjectLiteralExpression(node.parent)) {
      return `${accessorPrefix(node)}${member(node.parent, key, file)}`;
    }
    const prefix = hasModifier(node, ts.SyntaxKind.StaticKeyword) ? "static " : "";
    return `${prefix}${accessorPrefix(node)}${key}`;
  }
  const path = accessPath(node, file);
  if (path !== undefined) return path;

  const site = outermost(node);
  const exportedAsDefault =
    (ts.isExportAssignment(site.parent) && !site.parent.isExportEquals) ||
    ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      hasModifier(node, ts.SyntaxKind.DefaultKeyword));
  if (exportedAsDefault) return "default";

  const call = site.parent;
  if ((ts.isCallExpression(call) || ts.isNewExpression(call)) && call.arguments !== undefined) {
    const callee = calleeName(call.expression);
    if (callee !== undefined && call.arguments.includes(site as ts.Expression)) {
      const [first] = call.arguments;
      const label = first && ts.isStringLiteralLike(first) ? JSON.stringify(first.text) : "";
      return `${callee}(${label}) callback`;
    }
  }
  return ts.isClassLike(node) ? "<class>" : "<function>";
}

// The name an expression is bound to: a variable, parameter, binding element or class field it
// initializes, an object literal property (through that literal's own path), or an assignment
// target made of identifiers and `this`.
function accessPath(expression: ts.Node, file: ts.SourceFile): string | undefined {
  const site = outermost(expression);
  const parent = site.parent;
  if (ts.isVariableDeclaration(parent) && parent.initializer === site && ts.isIdentifier(parent.name)) {
    return inNamespace(parent, parent.name.text);
  }
  if (ts.isParameter(parent) && parent.initializer === site) {
    return ts.isIdentifier(parent.name) ? parent.name.text : undefined;
  }
  if (ts.isBindingElement(parent) && parent.initializer === site) {
    if (!ts.isIdentifier(parent.name)) return undefined;
    const declaration = ts.walkUpBindingElementsAndPatterns(parent);
    return ts.isVariableDeclaration(declaration)
      ? inNamespace(declaration, parent.name.text)
      : parent.name.text;
  }
  if (ts.isPropertyDeclaration(parent) && parent.initializer === site) return keyText(parent.name, file);
  if (ts.isPropertyAssignment(parent) && parent.initializer === site) {
    return member(parent.parent, keyText(parent.name, file), file);
  }
  const isAssigned = ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
  if (isAssigned && parent.right === site) {
    return chainText(parent.left);
  }
  return undefined;
}

function member(object: ts.ObjectLiteralExpression, key: string, file: ts.SourceFile): string {
  const path = accessPath(object, file);
  return path === undefined ? key : `${path}.${key}`;
}

function accessorPrefix(node: ts.Node): string {
  if (ts.isGetAccessorDeclaration(node)) return "get ";
  if (ts.isSetAccessorDeclaration(node)) return "set ";
  return "";
}

function keyText(name: ts.PropertyName, file: ts.SourceFile): string {
  return ts.isComputedPropertyName(name) ? name.getText(file) : name.text;
}

function chainText(target: ts.Expression): string | undefined {
  if (ts.isIdentifier(target)) return target.text;
  if (target.kind === ts.SyntaxKind.ThisKeyword) return "this";
  if (ts.isPropertyAccessExpression(target)) {
    const object = chainText(target.expression);
    return object === undefined ? undefined : `${object}.${target.name.text}`;
  }
  return undefined;
}

function calleeName(callee: ts.Expression): string | undefined {
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
}

// Parentheses and type-only wrappers do not change what an expression is bound to.
function outermost(node: ts.Node): ts.Node {
  let site = node;
  while (
    ts.isParenthesizedExpression(site.parent) ||
    ts.isAsExpression(site.parent) ||
    ts.isSatisfiesExpression(site.parent) ||
    ts.isNonNullExpression(site.parent) ||
    ts.isTypeAssertionExpression(site.parent)
  ) {
    site = site.parent;
  }
  return site;
}

// A declaration directly inside `namespace N.M { }` is reached as N.M.name.
function inNamespace(declaration: ts.Node, name: string): string {
  const statement = ts.isVariableDeclaration(declaration) ? declaration.parent.parent : declaration;
  const namespaces: string[] = [];
  let scope = statement.parent;
  while (ts.isModuleBlock(scope) || ts.isModuleDeclaration(scope)) {
    if (ts.isModuleDeclaration(scope)) namespaces.unshift(scope.name.text);
    scope = scope.parent;
  }
  return [...namespaces, name].join(".");
}

export function scriptKind(path: string): ts.ScriptKind {
  switch (posix.extname(path)) {
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".js":
    case ".mjs":
    case ".cjs":
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}
