import { posix } from "node:path";

export interface LanguageAdapter {
  readonly language: string;
}

const javaScriptAndTypeScript: LanguageAdapter = { language: "JavaScript and TypeScript" };

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
