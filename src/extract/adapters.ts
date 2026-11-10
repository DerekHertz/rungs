import { posix } from "node:path";
import type { CodeLevel } from "../graph.ts";
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
  /** The signature as written, with layout, comments and trailing commas left out; see
   *  src/extract/javascript-contract.ts. Never inferred: a missing return type stays missing. */
  readonly signature: string;
  /** The declarations whose syntax is inside this one. */
  readonly children: readonly Declaration[];
}

// The language seam in SPEC.md: files of one language in, an outline of each file out.
export interface LanguageAdapter {
  readonly language: string;
  analyse(files: readonly SourceFile[]): ReadonlyMap<string, readonly Declaration[]>;
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
