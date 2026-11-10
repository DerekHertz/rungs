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
