import { posix } from "node:path";
import ts from "typescript";
import type { ImportSite, ImportSiteTarget } from "./adapters.ts";
import type { FileTree, ImportReexports, ImportSyntax, ImportedNames } from "../graph.ts";

// The tree is mounted here, not at "/", so a path that climbs out of it stays outside: the
// host answers "no such file" for anything not under this root, where "/" would clamp it back in.
const ROOT = "/__tree__";

/** How the runtime reads the specifier: `import` and `import()` are ESM, `require` is CommonJS. */
export type ResolutionMode = "esm" | "cjs";

interface Settings {
  readonly options: ts.CompilerOptions;
  readonly cache: ts.ModuleResolutionCache;
  /** The `paths` patterns, so a miss on one is never taken for a package outside the tree. */
  readonly patterns: readonly string[];
  /** Why bare names cannot be trusted to be outside the tree, when a config points out of it. */
  readonly blind?: string;
}

/**
 * Resolves module specifiers against the tree with the TypeScript compiler's own algorithm
 * (bundler flavour: relative paths, index files, extension mapping, package.json `exports` and
 * `main` with the export condition of the syntax, `#imports`, and `paths` and `baseUrl` from the
 * nearest tsconfig.json or jsconfig.json, following `extends` inside the tree). The host sees the
 * tree and nothing else, so the answer is a function of the tree. A package of this tree is found
 * by the `name` in its package.json and answers as if it were installed under node_modules,
 * which is how a workspace links it; a name two packages share resolves to neither.
 */
export class ImportResolver {
  private readonly tree: FileTree;
  private readonly directories = new Set<string>();
  /** In-repo package name to its directory ("" for the root). Ambiguous names are not here. */
  private readonly workspaces = new Map<string, string>();
  private readonly ambiguous = new Set<string>();
  private readonly host: ts.ModuleResolutionHost;
  private readonly settings = new Map<string, Settings>();
  private readonly base: ts.CompilerOptions = {
    allowJs: true,
    resolveJsonModule: true,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.Latest,
    noEmit: true,
    types: [],
    ignoreDeprecations: "6.0",
  };

  constructor(tree: FileTree) {
    this.tree = tree;
    const named = new Map<string, string[]>();
    for (const [path, text] of tree) {
      for (let dir = posix.dirname(path); dir !== "." && dir !== "/" && !this.directories.has(`${ROOT}/${dir}`); dir = posix.dirname(dir)) {
        this.directories.add(`${ROOT}/${dir}`);
      }
      if (posix.basename(path) !== "package.json") continue;
      const name = packageName(text);
      const dir = posix.dirname(path);
      if (name !== undefined) named.set(name, [...(named.get(name) ?? []), dir === "." ? "" : dir]);
    }
    for (const [name, dirs] of named) {
      if (dirs.length === 1) this.workspaces.set(name, dirs[0]!);
      else this.ambiguous.add(name);
    }
    this.directories.add(ROOT);
    this.host = {
      fileExists: (name) => this.tree.has(this.real(name)),
      readFile: (name) => this.tree.get(this.real(name)),
      directoryExists: (name) => this.directoryExists(name),
      getCurrentDirectory: () => ROOT,
      useCaseSensitiveFileNames: true,
    };
  }

  resolve(specifier: string, from: string, mode: ResolutionMode): ImportSiteTarget {
    const relative = /^\.\.?(\/|$)/.test(specifier);
    // A query or fragment on a relative path (`./x.mjs?fresh`) names the same file to an ES
    // module loader. `require` takes the name as written.
    const clean = relative && mode === "esm" ? specifier.replace(/[?#].*$/, "") : specifier;
    if (relative) {
      const place = posix.normalize(posix.join(posix.dirname(from), clean));
      if (place === ".." || place.startsWith("../")) return { unresolved: true, reason: "the path leaves the tree" };
    }
    const settings = this.settingsFor(from);
    const found = ts.resolveModuleName(
      clean,
      `${ROOT}/${from}`,
      settings.options,
      this.host,
      settings.cache,
      undefined,
      mode === "esm" ? ts.ModuleKind.ESNext : ts.ModuleKind.CommonJS,
    ).resolvedModule;
    if (found !== undefined) {
      const path = this.real(found.resolvedFileName);
      if (this.tree.has(path)) return { file: path };
    }
    // moduleSuffixes make TypeScript reject a code file it would otherwise find; that answer stands.
    const rejected = settings.options.moduleSuffixes !== undefined && CODE_EXTENSION.test(clean);
    if ((relative || specifier.startsWith("/")) && rejected) return { unresolved: true };
    if (relative || specifier.startsWith("/")) {
      // Not code TypeScript resolves (a stylesheet, an image): the file is still the target.
      const path = posix.normalize(clean.startsWith("/") ? clean.slice(1) : posix.join(posix.dirname(from), clean));
      return this.tree.has(path) ? { file: path } : { unresolved: true };
    }
    if (specifier.startsWith("#")) return { unresolved: true };
    if (settings.patterns.some((pattern) => matches(pattern, specifier))) {
      return { unresolved: true, reason: "it matches a tsconfig paths pattern that names no file" };
    }
    if (specifier.startsWith("node:")) return { external: specifier };
    if (settings.blind !== undefined) return { unresolved: true, reason: settings.blind };
    const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!;
    if (this.ambiguous.has(name)) return { unresolved: true, reason: `two packages of the tree are named ${name}` };
    return this.workspaces.has(name) ? { unresolved: true } : { external: name };
  }

  // The options of the nearest tsconfig.json or jsconfig.json above the file, or none.
  private settingsFor(from: string): Settings {
    let config: string | undefined;
    for (let dir = posix.dirname(from); config === undefined; dir = posix.dirname(dir)) {
      const prefix = dir === "." ? "" : `${dir}/`;
      config = [`${prefix}tsconfig.json`, `${prefix}jsconfig.json`].find((path) => this.tree.has(path));
      if (dir === ".") break;
    }
    const key = config ?? "";
    const known = this.settings.get(key);
    if (known !== undefined) return known;
    let options = this.base;
    let patterns: string[] = [];
    let blind: string | undefined;
    if (config !== undefined) {
      const dir = posix.dirname(config);
      const parsed = ts.parseConfigFileTextToJson(`${ROOT}/${config}`, this.tree.get(config) ?? "");
      const extended = (parsed.config as { extends?: unknown } | undefined)?.extends;
      for (const name of typeof extended === "string" ? [extended] : Array.isArray(extended) ? extended : []) {
        if (typeof name === "string" && name.startsWith(".") && leaves(posix.join(dir, name))) {
          blind = `${config} extends a file outside the tree`;
        }
      }
      const content = ts.parseJsonConfigFileContent(
        parsed.config ?? {},
        { useCaseSensitiveFileNames: true, readDirectory: () => [], fileExists: this.host.fileExists, readFile: this.host.readFile! },
        dir === "." ? ROOT : `${ROOT}/${dir}`,
        undefined,
        `${ROOT}/${config}`,
      );
      const { baseUrl, paths, pathsBasePath, moduleSuffixes, customConditions } = content.options;
      options = { ...this.base, baseUrl, paths, pathsBasePath, moduleSuffixes, customConditions };
      patterns = Object.keys(paths ?? {});
      if (baseUrl !== undefined && baseUrl !== ROOT && !baseUrl.startsWith(`${ROOT}/`)) blind = `${config} sets a baseUrl outside the tree`;
    }
    const made: Settings = { options, patterns, blind, cache: ts.createModuleResolutionCache(ROOT, (name) => name, options) };
    this.settings.set(key, made);
    return made;
  }

  // Path in the host's world (under ROOT, or ".../node_modules/<workspace>/x") to a tree path.
  // Anything outside ROOT maps to a path no tree has.
  private real(name: string): string {
    if (name !== ROOT && !name.startsWith(`${ROOT}/`)) return OUTSIDE;
    const at = name.lastIndexOf("/node_modules/");
    if (at < 0) return name.slice(ROOT.length + 1);
    const rest = name.slice(at + "/node_modules/".length);
    for (const [pkg, dir] of this.workspaces) {
      if (rest === pkg) return dir;
      if (rest.startsWith(`${pkg}/`)) return posix.join(dir, rest.slice(pkg.length + 1));
    }
    return name.slice(ROOT.length + 1);
  }

  private directoryExists(name: string): boolean {
    if (name.endsWith("/node_modules")) return true;
    const at = name.lastIndexOf("/node_modules/");
    if (at < 0) return this.directories.has(name);
    const rest = name.slice(at + "/node_modules/".length);
    if ([...this.workspaces.keys()].some((pkg) => pkg.startsWith(`${rest}/`))) return true;
    const dir = this.real(name);
    return dir !== name.slice(ROOT.length + 1) && dir !== OUTSIDE && (dir === "" || this.directories.has(`${ROOT}/${dir}`));
  }
}

// Not a path any tree has: a file named so would need a NUL in it.
const CODE_EXTENSION = /\.(?:[cm]?[jt]sx?|json)$/;

const OUTSIDE = "\0outside";

const leaves = (path: string): boolean => {
  const place = posix.normalize(path);
  return place === ".." || place.startsWith("../");
};

// A tsconfig `paths` key holds at most one `*`.
function matches(pattern: string, specifier: string): boolean {
  const star = pattern.indexOf("*");
  if (star < 0) return pattern === specifier;
  const head = pattern.slice(0, star);
  const tail = pattern.slice(star + 1);
  return specifier.length >= head.length + tail.length && specifier.startsWith(head) && specifier.endsWith(tail);
}

function packageName(text: string): string | undefined {
  try {
    const name = (JSON.parse(text) as { name?: unknown } | null)?.name;
    return typeof name === "string" && name !== "" ? name : undefined;
  } catch {
    return undefined;
  }
}

const allTypeNamed = (elements: readonly (ts.ImportSpecifier | ts.ExportSpecifier)[]): boolean =>
  elements.length > 0 && elements.every((element) => element.isTypeOnly);

/** `import type`, or only `type` specifiers and no default or namespace binding. */
function importIsTypeOnly(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (clause === undefined) return false;
  if (clause.isTypeOnly) return true;
  return clause.name === undefined && clause.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings) && allTypeNamed(clause.namedBindings.elements);
}

function exportIsTypeOnly(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true;
  return node.exportClause !== undefined && ts.isNamedExports(node.exportClause) && allTypeNamed(node.exportClause.elements);
}

/** `with { "resolution-mode": "require" | "import" }`: TypeScript honours it on type-only imports and exports. */
function explicitMode(attributes: ts.ImportAttributes | undefined): ResolutionMode | undefined {
  for (const attribute of attributes?.elements ?? []) {
    const name = attribute.name.text;
    if (name !== "resolution-mode" || !ts.isStringLiteralLike(attribute.value)) continue;
    if (attribute.value.text === "require") return "cjs";
    if (attribute.value.text === "import") return "esm";
  }
  return undefined;
}

const nameOf = (name: ts.ModuleExportName | ts.PropertyName): string | undefined =>
  ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isPrivateIdentifier(name) ? name.text : undefined;

const unique = (names: readonly string[]): string[] => [...new Set(names)].sort();

/** The names an `import` declaration takes from the module: `default`, each named one, all for `* as ns`, none for a bare import. */
function importedNames(node: ts.ImportDeclaration): ImportedNames {
  const clause = node.importClause;
  if (clause === undefined) return [];
  const names: string[] = clause.name === undefined ? [] : ["default"];
  const bindings = clause.namedBindings;
  if (bindings !== undefined) {
    if (ts.isNamespaceImport(bindings)) return "all";
    for (const element of bindings.elements) names.push(nameOf(element.propertyName ?? element.name) ?? "*");
  }
  return names.includes("*") ? "all" : unique(names);
}

/** What `export ... from` takes from the module and passes on. `export *` takes and passes all (never `default`). */
function reexported(node: ts.ExportDeclaration): { names: ImportedNames; reexports: ImportReexports } {
  const clause = node.exportClause;
  if (clause === undefined) return { names: "all", reexports: "star" };
  if (ts.isNamespaceExport(clause)) return { names: "all", reexports: [{ name: "*", as: nameOf(clause.name) ?? "*" }] };
  const pairs = clause.elements.map((element) => ({ name: nameOf(element.propertyName ?? element.name) ?? "*", as: nameOf(element.name) ?? "*" }));
  return {
    names: pairs.some((pair) => pair.name === "*") ? "all" : unique(pairs.map((pair) => pair.name)),
    reexports: pairs.sort((a, b) => (a.as < b.as ? -1 : a.as > b.as ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  };
}

const bindingNames = (pattern: ts.ObjectBindingPattern): ImportedNames => {
  const names: string[] = [];
  for (const element of pattern.elements) {
    const key = element.propertyName ?? element.name;
    const name = element.dotDotDotToken === undefined && (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) ? key.text : undefined;
    if (name === undefined) return "all";
    names.push(name);
  }
  return unique(names);
};

/**
 * The names a `require()` or `import()` call takes, where the code says so: a destructuring
 * binding, a property read straight off the call, or none when the call stands alone as a
 * statement. Anything else (the module bound to a name, passed on, awaited into a `.then`) is all.
 */
function calledNames(call: ts.Expression, promise: boolean): ImportedNames {
  let outer: ts.Node = call;
  let awaited = false;
  while (
    ts.isParenthesizedExpression(outer.parent) ||
    ts.isAwaitExpression(outer.parent) ||
    ts.isAsExpression(outer.parent) ||
    ts.isNonNullExpression(outer.parent) ||
    ts.isSatisfiesExpression(outer.parent)
  ) {
    outer = outer.parent;
    if (ts.isAwaitExpression(outer)) awaited = true;
  }
  const parent = outer.parent;
  if (ts.isExpressionStatement(parent)) return [];
  // An import() is a promise: a read or a destructuring names an export only on its awaited value (`.then`, `.catch` and the rest are the promise's).
  if (promise && !awaited) return "all";
  if (ts.isVariableDeclaration(parent) && parent.initializer === outer && ts.isObjectBindingPattern(parent.name)) return bindingNames(parent.name);
  if (ts.isPropertyAccessExpression(parent) && parent.expression === outer) return nameOf(parent.name) === undefined ? "all" : [parent.name.text];
  if (ts.isElementAccessExpression(parent) && parent.expression === outer && ts.isStringLiteralLike(parent.argumentExpression)) return [parent.argumentExpression.text];
  return "all";
}

/**
 * Every static `import`, `export ... from`, `import x = require()`, and `require` or `import()`
 * whose argument is a string literal. `require` counts only when it is the global one: any
 * declaration of the name, in this file or another script, makes it something else. A `require`
 * made by createRequire is a resolution, not an import. A non-literal specifier is no import edge.
 */
export function importSites(file: ts.SourceFile, checker: ts.TypeChecker, resolver: ImportResolver, path: string): ImportSite[] {
  const sites: ImportSite[] = [];
  const add = (
    node: ts.Node,
    spec: ts.Node | undefined,
    syntax: ImportSyntax,
    mode: ResolutionMode,
    typeOnly: boolean,
    attributes: ts.ImportAttributes | undefined,
    names: ImportedNames,
    reexports?: ImportReexports,
  ): void => {
    if (spec === undefined || !ts.isStringLiteralLike(spec)) return;
    sites.push({
      specifier: spec.text,
      syntax,
      typeOnly,
      target: resolver.resolve(spec.text, path, typeOnly ? (explicitMode(attributes) ?? mode) : mode),
      names,
      ...(reexports === undefined ? {} : { reexports }),
      start: node.getStart(file),
      end: node.end,
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) add(node, node.moduleSpecifier, "import", "esm", importIsTypeOnly(node), node.attributes, importedNames(node));
    else if (ts.isExportDeclaration(node)) {
      const passed = reexported(node);
      add(node, node.moduleSpecifier, "export from", "esm", exportIsTypeOnly(node), node.attributes, passed.names, passed.reexports);
    }
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node, node.moduleReference.expression, "import", "cjs", node.isTypeOnly, undefined, "all");
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword) add(node, node.arguments[0], "import()", "esm", false, undefined, calledNames(node, true));
      else if (ts.isIdentifier(callee) && callee.text === "require" && (checker.getSymbolAtLocation(callee)?.declarations ?? []).length === 0) {
        add(node, node.arguments[0], "require", "cjs", false, undefined, calledNames(node, false));
      }
    }
    node.forEachChild(visit);
  };
  visit(file);
  return sites;
}
