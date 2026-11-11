import { posix } from "node:path";
import ts from "typescript";
import type { ImportSite, ImportSiteTarget } from "./adapters.ts";
import type { FileTree, ImportSyntax } from "../graph.ts";

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
      const { baseUrl, paths, pathsBasePath } = content.options;
      options = { ...this.base, baseUrl, paths, pathsBasePath };
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

/**
 * Every static `import`, `export ... from`, `import x = require()`, and `require` or `import()`
 * whose argument is a string literal. `require` counts only when it is the global one: any
 * declaration of the name, in this file or another script, makes it something else. A `require`
 * made by createRequire is a resolution, not an import. A non-literal specifier is no import edge.
 */
export function importSites(file: ts.SourceFile, checker: ts.TypeChecker, resolver: ImportResolver, path: string): ImportSite[] {
  const sites: ImportSite[] = [];
  const add = (node: ts.Node, spec: ts.Node | undefined, syntax: ImportSyntax, mode: ResolutionMode, typeOnly: boolean): void => {
    if (spec === undefined || !ts.isStringLiteralLike(spec)) return;
    sites.push({
      specifier: spec.text,
      syntax,
      typeOnly,
      target: resolver.resolve(spec.text, path, mode),
      start: node.getStart(file),
      end: node.end,
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) add(node, node.moduleSpecifier, "import", "esm", importIsTypeOnly(node));
    else if (ts.isExportDeclaration(node)) add(node, node.moduleSpecifier, "export from", "esm", exportIsTypeOnly(node));
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node, node.moduleReference.expression, "import", "cjs", node.isTypeOnly);
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword) add(node, node.arguments[0], "import()", "esm", false);
      else if (ts.isIdentifier(callee) && callee.text === "require" && (checker.getSymbolAtLocation(callee)?.declarations ?? []).length === 0) {
        add(node, node.arguments[0], "require", "cjs", false);
      }
    }
    node.forEachChild(visit);
  };
  visit(file);
  return sites;
}
