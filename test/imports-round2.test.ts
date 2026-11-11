import { describe, expect, test } from "vitest";
import { extract } from "../src/extract/extract.ts";
import { nodeId } from "../src/graph.ts";

const targets = (files: Record<string, string>) => extract(new Map(Object.entries(files))).imports.map((e) => e.target);
const file = (path: string) => nodeId("file", path, "");

describe("import edges, review round 2", () => {
  test("moduleSuffixes from the tsconfig pick the platform file", () => {
    expect(
      targets({
        "tsconfig.json": '{"compilerOptions":{"moduleSuffixes":[".native",""]}}',
        "a.ts": 'import "./b";',
        "b.native.ts": "",
        "b.ts": "",
      }),
    ).toEqual([{ file: file("b.native.ts") }]);
  });

  test("customConditions from the tsconfig pick the exports branch", () => {
    expect(
      targets({
        "package.json": '{"name":"root"}',
        "tsconfig.json": '{"compilerOptions":{"customConditions":["source"]}}',
        "p/package.json": '{"name":"pkg","exports":{"source":"./src.ts","import":"./dist.js"}}',
        "p/src.ts": "",
        "p/dist.js": "",
        "a.ts": 'import "pkg";',
      }),
    ).toEqual([{ file: file("p/src.ts") }]);
  });

  test("an explicit resolution-mode on a type import picks its condition", () => {
    const pkg = {
      "package.json": '{"name":"root"}',
      "p/package.json": '{"name":"pkg","exports":{"import":"./esm.d.ts","require":"./cjs.d.ts"}}',
      "p/esm.d.ts": "",
      "p/cjs.d.ts": "",
    };
    expect(
      targets({
        ...pkg,
        "a.mts": 'import type { T } from "pkg" with { "resolution-mode": "require" };\nexport type { U } from "pkg" with { "resolution-mode": "require" };\nimport type { V } from "pkg";',
      }),
    ).toEqual([{ file: file("p/cjs.d.ts") }, { file: file("p/cjs.d.ts") }, { file: file("p/esm.d.ts") }]);
    expect(targets({ ...pkg, "b.cts": 'import type { T } from "pkg" with { "resolution-mode": "import" };' })).toEqual([{ file: file("p/esm.d.ts") }]);
  });
});
