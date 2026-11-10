import { posix } from "node:path";
import ts from "typescript";
import type { ModuleNode } from "../graph.ts";

export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

// The language seam in SPEC.md: files of one language in, nodes and edges out.
export interface LanguageAdapter {
  readonly language: string;
  analyse(files: readonly SourceFile[]): readonly ModuleNode[];
}

const javaScriptAndTypeScript: LanguageAdapter = {
  language: "JavaScript and TypeScript",
  analyse(files) {
    for (const file of files) {
      ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, false, scriptKind(file.path));
    }
    return [];
  },
};

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

function scriptKind(path: string): ts.ScriptKind {
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
