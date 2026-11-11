import { posix } from "node:path";
import ts from "typescript";
import type { ImportSite, ImportSiteTarget } from "./adapters.ts";
import type { FileTree, ImportSyntax } from "../graph.ts";

/**
 * Resolves module specifiers against the tree with the TypeScript compiler's own algorithm
 * (bundler flavour: relative paths, index files, extension mapping, package.json `exports` and
 * `main`, `#imports`). The host sees the tree and nothing else, so the answer is a function of
 * the tree. A package of this tree is found by the `name` in its package.json and answers as if
 * it were installed under node_modules, which is how a workspace links it. Nothing outside the
 * tree is read, and `paths` from a tsconfig are not applied.
 */
export class ImportResolver {
  private readonly tree: FileTree;
  private readonly directories = new Set<string>();
  /** In-repo package name to its directory ("" for the root). */
  private readonly workspaces = new Map<string, string>();
  private readonly host: ts.ModuleResolutionHost;
  private readonly cache: ts.ModuleResolutionCache;
  private readonly options: ts.CompilerOptions = {
    allowJs: true,
    resolveJsonModule: true,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.Latest,
    noEmit: true,
    types: [],
  };

  constructor(tree: FileTree) {
    this.tree = tree;
    for (const [path, text] of tree) {
      for (let dir = posix.dirname(path); dir !== "." && dir !== "/" && !this.directories.has(`/${dir}`); dir = posix.dirname(dir)) {
        this.directories.add(`/${dir}`);
      }
      if (posix.basename(path) !== "package.json") continue;
      const name = packageName(text);
      const dir = posix.dirname(path);
      if (name !== undefined && !this.workspaces.has(name)) this.workspaces.set(name, dir === "." ? "" : dir);
    }
    this.directories.add("/");
    this.host = {
      fileExists: (name) => this.tree.has(this.real(name)),
      readFile: (name) => this.tree.get(this.real(name)),
      directoryExists: (name) => this.directoryExists(name),
      getCurrentDirectory: () => "/",
      useCaseSensitiveFileNames: true,
    };
    this.cache = ts.createModuleResolutionCache("/", (name) => name, this.options);
  }

  resolve(specifier: string, from: string): ImportSiteTarget {
    // A query or fragment on a relative path (`./x.mjs?fresh`) names the same file to the runtime.
    const clean = /^\.\.?\//.test(specifier) ? specifier.replace(/[?#].*$/, "") : specifier;
    const found = ts.resolveModuleName(clean, `/${from}`, this.options, this.host, this.cache).resolvedModule;
    if (found !== undefined) {
      const path = this.real(found.resolvedFileName);
      if (this.tree.has(path)) return { file: path };
    }
    if (/^(\.\.?(\/|$)|\/)/.test(specifier)) {
      // Not code TypeScript resolves (a stylesheet, an image): the file is still the target.
      const path = posix.normalize(clean.startsWith("/") ? clean.slice(1) : posix.join(posix.dirname(from), clean));
      return this.tree.has(path) ? { file: path } : { unresolved: true };
    }
    if (specifier.startsWith("#")) return { unresolved: true };
    if (specifier.startsWith("node:")) return { external: specifier };
    const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!;
    return this.workspaces.has(name) ? { unresolved: true } : { external: name };
  }

  // Path in the host's world ("/a/b" or ".../node_modules/<workspace>/x") to a tree path.
  private real(name: string): string {
    const at = name.lastIndexOf("/node_modules/");
    if (at < 0) return name.slice(1);
    const rest = name.slice(at + "/node_modules/".length);
    for (const [pkg, dir] of this.workspaces) {
      if (rest === pkg) return dir;
      if (rest.startsWith(`${pkg}/`)) return posix.join(dir, rest.slice(pkg.length + 1));
    }
    return name.slice(1);
  }

  private directoryExists(name: string): boolean {
    if (name.endsWith("/node_modules")) return true;
    const at = name.lastIndexOf("/node_modules/");
    if (at < 0) return this.directories.has(name);
    const rest = name.slice(at + "/node_modules/".length);
    if ([...this.workspaces.keys()].some((pkg) => pkg.startsWith(`${rest}/`))) return true;
    const dir = this.real(name);
    return dir !== name.slice(1) && (dir === "" || this.directories.has(`/${dir}`));
  }
}

function packageName(text: string): string | undefined {
  try {
    const name = (JSON.parse(text) as { name?: unknown } | null)?.name;
    return typeof name === "string" && name !== "" ? name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Every static `import`, `export ... from`, `import x = require()`, and `require` or `import()`
 * whose argument is a string literal. `require` counts only when it is the global one; a
 * `require` made by createRequire is a resolution, not an import. A non-literal specifier is no
 * import edge.
 */
export function importSites(file: ts.SourceFile, checker: ts.TypeChecker, resolver: ImportResolver, path: string): ImportSite[] {
  const sites: ImportSite[] = [];
  const add = (node: ts.Node, spec: ts.Node | undefined, syntax: ImportSyntax, typeOnly: boolean): void => {
    if (spec === undefined || !ts.isStringLiteralLike(spec)) return;
    sites.push({
      specifier: spec.text,
      syntax,
      typeOnly,
      target: resolver.resolve(spec.text, path),
      start: node.getStart(file),
      end: node.end,
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) add(node, node.moduleSpecifier, "import", node.importClause?.isTypeOnly ?? false);
    else if (ts.isExportDeclaration(node)) add(node, node.moduleSpecifier, "export from", node.isTypeOnly);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node, node.moduleReference.expression, "import", node.isTypeOnly);
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword) add(node, node.arguments[0], "import()", false);
      else if (ts.isIdentifier(callee) && callee.text === "require" && (checker.getSymbolAtLocation(callee)?.declarations ?? []).every((declaration) => declaration.getSourceFile() !== file)) {
        add(node, node.arguments[0], "require", false);
      }
    }
    node.forEachChild(visit);
  };
  visit(file);
  return sites;
}
