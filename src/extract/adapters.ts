import { posix } from "node:path";
import type { CodeLevel, TypeContract, EffectArg, EffectTarget, FileTree, ImportReexports, ImportSyntax, ImportedNames, ResourceKind } from "../graph.ts";
import { javaScriptAndTypeScript } from "./javascript.ts";

export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

/**
 * One class or function as its language sees it. Adapters describe; the extractor picks ids,
 * line numbers, ordinals and escaping, so no adapter can break identity or what a line is.
 */
export interface Declaration {
  readonly level: CodeLevel;
  /** What the language calls it in its scope, unescaped: "render", "static create", "#grow". */
  readonly text: string;
  /** UTF-16 offsets into the file text, end exclusive, from the first token (decorators and
   *  modifiers included, leading comments excluded) to the end of the body. */
  readonly start: number;
  readonly end: number;
  /** True when the file exports this declaration from its top level, by the language's own
   *  syntax; a binding that merely holds it elsewhere does not count. */
  readonly exported: boolean;
  /** The names the file exports it under (`*` for any: `module.exports = ...`); set when exported. */
  readonly exportedAs?: readonly string[];
  /** The signature as written, with layout, comments and trailing commas left out; see
   *  src/extract/javascript-contract.ts. Never inferred: a missing return type stays missing. */
  readonly signature: string;
  /** The declarations whose syntax is inside this one. */
  readonly children: readonly Declaration[];
}

/**
 * One call that reaches a resource. Like a Declaration it carries UTF-16 offsets and no ids; the
 * extractor decides which node owns it and which lines it covers.
 */
export interface EffectSite {
  readonly resource: ResourceKind;
  /** The catalog key, such as "child_process execFileSync". */
  readonly operation: string;
  readonly target: EffectTarget;
  readonly args: readonly EffectArg[];
  /** The whole call expression, end exclusive. */
  readonly start: number;
  readonly end: number;
}

/** One call that resolves a module name or path; owned like an EffectSite. */
export interface ResolutionSite {
  readonly operation: string;
  readonly args: readonly EffectArg[];
  readonly start: number;
  readonly end: number;
}

/** Where an import points: a tree path, a package outside the tree, or nothing that answers. */
export type ImportSiteTarget = { readonly file: string } | { readonly external: string } | { readonly unresolved: true; readonly reason?: string };

/** One import of a literal module name, already resolved against the tree. */
export interface ImportSite {
  readonly specifier: string;
  readonly syntax: ImportSyntax;
  readonly typeOnly: boolean;
  readonly target: ImportSiteTarget;
  readonly names: ImportedNames;
  readonly reexports?: ImportReexports;
  /** The whole statement or call, end exclusive. */
  readonly start: number;
  readonly end: number;
}

export interface FileOutline {
  readonly declarations: readonly Declaration[];
  /** The interfaces and type aliases the file exports. */
  readonly types: readonly TypeContract[];
  readonly effects: readonly EffectSite[];
  readonly resolutions: readonly ResolutionSite[];
  readonly imports: readonly ImportSite[];
}

// The language seam in SPEC.md: files of one language in, an outline of each file out.
export interface LanguageAdapter {
  readonly language: string;
  /** `tree` is every file of the tree, for resolving what a file imports. */
  analyse(files: readonly SourceFile[], tree: FileTree): ReadonlyMap<string, FileOutline>;
}

const ADAPTERS_BY_EXTENSION: ReadonlyMap<string, LanguageAdapter> = new Map([
  [".js", javaScriptAndTypeScript],
  [".jsx", javaScriptAndTypeScript],
  [".mjs", javaScriptAndTypeScript],
  [".cjs", javaScriptAndTypeScript],
  [".ts", javaScriptAndTypeScript],
  [".tsx", javaScriptAndTypeScript],
  [".mts", javaScriptAndTypeScript],
  [".cts", javaScriptAndTypeScript],
]);

export function adapterFor(path: string): LanguageAdapter | undefined {
  return ADAPTERS_BY_EXTENSION.get(posix.extname(path));
}
