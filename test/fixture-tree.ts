import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { FileTree } from "../src/graph.ts";

export function readFixtureTree(root: string): FileTree {
  const tree = new Map<string, string>();
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const absolute = join(entry.parentPath, entry.name);
    tree.set(relative(root, absolute).split(sep).join("/"), readFileSync(absolute, "utf8"));
  }
  return new Map([...tree].sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** A tree of `files` modules, each with 30 file-system effects and 30 calls: the shape the speed checks use. */
export function wideTree(files: number): Map<string, string> {
  const tree = new Map<string, string>();
  for (let i = 0; i < files; i++) {
    const calls = Array.from({ length: 30 }, (_, j) => `  fs.readFileSync(path.join(dir, "f${j}"));\n  helper${j}(a, b);`);
    tree.set(`src/m${i}.mjs`, `import fs from "node:fs";\nimport path from "node:path";\nexport function run${i}(dir, a, b) {\n${calls.join("\n")}\n}\n`);
  }
  return tree;
}
