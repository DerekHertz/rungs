import { describe, expect, test } from "vitest";
import { extract } from "../src/extract/extract.ts";
import { nodeId } from "../src/graph.ts";
import type { ImportEdge } from "../src/graph.ts";

const importsOf = (files: Record<string, string>): ImportEdge[] => [...extract(new Map(Object.entries(files))).imports];
const targets = (files: Record<string, string>) => importsOf(files).map((e) => e.target);
const file = (path: string) => nodeId("file", path, "");

describe("import edges, review round 2", () => {
  test("a config baseUrl that leaves the tree finds no file inside it", () => {
    const edges = targets({ "tsconfig.json": '{"compilerOptions":{"baseUrl":".."}}', "a.ts": 'import "x";', "x.ts": "" });
    expect(edges[0]).toMatchObject({ unresolved: true });
  });

  test("an extends that leaves the tree is not read from inside it", () => {
    const edges = targets({
      "d/tsconfig.json": '{"extends":"../../base.json"}',
      "base.json": '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["lib/*"]}}}',
      "d/a.ts": 'import "@/x";',
      "lib/x.ts": "",
    });
    expect(edges[0]).not.toEqual({ file: file("lib/x.ts") });
    expect(edges[0]).toMatchObject({ unresolved: true });
  });

  test("a config inside the tree still works under the virtual root", () => {
    const edges = targets({ "tsconfig.json": '{"compilerOptions":{"baseUrl":"src"}}', "a.ts": 'import "x";', "src/x.ts": "" });
    expect(edges[0]).toEqual({ file: file("src/x.ts") });
  });
});
