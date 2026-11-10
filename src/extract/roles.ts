import { posix } from "node:path";
import type { Role } from "../graph.ts";

interface RoleRule {
  readonly role: Role;
  /** `analysed` is whether a language adapter read the file. */
  readonly matches: (path: string, analysed: boolean) => boolean;
}

const LOCKFILES: ReadonlySet<string> = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
]);

const CONFIG_BASENAMES: ReadonlySet<string> = new Set([
  "package.json",
  ".gitignore",
  ".gitattributes",
  ".npmrc",
  ".nvmrc",
  ".editorconfig",
]);

const base = (path: string): string => posix.basename(path);
const inDirectory = (path: string, ...names: string[]): boolean =>
  posix.dirname(path).split("/").some((segment) => names.includes(segment));

// The order is the table: the first rule that matches decides, so a test under docs/ is tests.
// Versioned with the extractor: a change to any rule changes the output, so it bumps
// EXTRACTOR_VERSION.
const ROLE_RULES: readonly RoleRule[] = [
  { role: "generated", matches: (path) => LOCKFILES.has(base(path)) },
  { role: "tests", matches: (path) => inDirectory(path, "test", "tests", "__tests__") },
  { role: "tests", matches: (path) => /\.(test|spec)\./.test(base(path)) },
  { role: "docs", matches: (path) => posix.extname(path) === ".md" },
  { role: "docs", matches: (path) => inDirectory(path, "docs") },
  { role: "config", matches: (path) => CONFIG_BASENAMES.has(base(path)) },
  { role: "config", matches: (path) => /^tsconfig.*\.json$/.test(base(path)) },
  { role: "config", matches: (path) => /\.config\.(js|ts|mjs|cjs|json)$/.test(base(path)) },
  { role: "config", matches: (path) => inDirectory(path, ".github") },
  { role: "source", matches: (_path, analysed) => analysed },
];

export function roleOf(path: string, analysed: boolean): Role | null {
  return ROLE_RULES.find((rule) => rule.matches(path, analysed))?.role ?? null;
}
