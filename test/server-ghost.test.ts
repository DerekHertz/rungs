import { expect, test } from "vitest";
import type { FileTree } from "../src/graph.ts";
import { serve } from "../src/server.ts";

const imports = 'import { spawn } from "node:child_process";\n';
const before: FileTree = new Map([
  ["package.json", "{}\n"],
  ["src/a.mjs", `${imports}export function f() {\n  return 1;\n}\nexport function g() {\n  spawn("ls");\n}\n`],
  ["src/keep.mjs", `${imports}export function k() {\n  spawn("tar");\n}\n`],
]);
const after: FileTree = new Map([
  ["package.json", "{}\n"],
  ["src/b.mjs", "export function f() {\n  return 1;\n}\n"],
  ["src/keep.mjs", `${imports}export function k() {\n  spawn("tar");\n}\n`],
]);

test("/ghost-edges.json lists the base's outside calls in removed files, and a function that moved away has its base source", async () => {
  const server = await serve(after, 0, { ref: "main", commit: "3f2a9c1d00000000000000000000000000000000", tree: before });
  try {
    const { edges } = (await (await fetch(new URL("ghost-edges.json", server.url))).json()) as { edges: { from: string; operation: string }[] };
    expect(edges.map((edge) => [edge.from, edge.operation])).toEqual([["function:src/a.mjs#g", "child_process spawn"]]);
    const moved = await fetch(new URL(`source?id=${encodeURIComponent("function:src/a.mjs#f")}`, server.url));
    expect(moved.status).toBe(200);
    expect(await moved.text()).toBe("export function f() {\n  return 1;\n}");
  } finally {
    await server.close();
  }
});
