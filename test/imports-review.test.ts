import { describe, expect, test } from "vitest";
import { extract } from "../src/extract/extract.ts";
import { nodeId } from "../src/graph.ts";
import type { ImportEdge } from "../src/graph.ts";

const importsOf = (files: Record<string, string>): ImportEdge[] => [...extract(new Map(Object.entries(files))).imports];
const targets = (files: Record<string, string>) => importsOf(files).map((e) => e.target);
const file = (path: string) => nodeId("file", path, "");

describe("import edges, review round 1", () => {
  test("require and import pick their own export condition", () => {
    expect(
      targets({
        "package.json": '{"name":"root"}',
        "p/package.json": '{"name":"pkg","exports":{"import":"./esm.js","require":"./cjs.js"}}',
        "p/esm.js": "",
        "p/cjs.js": "",
        "a.cjs": 'require("pkg");',
        "b.mjs": 'import "pkg";\nawait import("pkg");\nexport * from "pkg";',
      }),
    ).toEqual([{ file: file("p/cjs.js") }, { file: file("p/esm.js") }, { file: file("p/esm.js") }, { file: file("p/esm.js") }]);
  });

  test("tsconfig paths and baseUrl resolve aliases; a miss on a paths pattern is unresolved, not external", () => {
    const edges = targets({
      "tsconfig.json": '{"compilerOptions":{"baseUrl":".","paths":{"@app/*":["src/*"]}}}',
      "a.ts": 'import "@app/b";\nimport "@app/nope";\nimport "src/b";\nimport "lodash";\n',
      "src/b.ts": "",
    });
    expect(edges[0]).toEqual({ file: file("src/b.ts") });
    expect(edges[1]).toMatchObject({ unresolved: true });
    expect(edges[2]).toEqual({ file: file("src/b.ts") });
    expect(edges[3]).toEqual({ external: "lodash" });
  });

  test("the nearest config applies and extends is followed inside the tree", () => {
    expect(
      targets({
        "base.json": '{"compilerOptions":{"baseUrl":".","paths":{"~/*":["lib/*"]}}}',
        "pkg/tsconfig.json": '{"extends":"../base.json"}',
        "pkg/a.ts": 'import "~/x";\n',
        "lib/x.ts": "",
        "other/b.ts": 'import "~/x";\n',
      }),
    ).toEqual([{ external: "~" }, { file: file("lib/x.ts") }]);
  });

  test("two packages with one name are ambiguous whatever the tree order", () => {
    const x = '{"name":"dup","main":"i.js"}';
    const one = targets({ "x/package.json": x, "x/i.js": "", "y/package.json": x, "y/i.js": "", "u.ts": 'import "dup";' });
    const two = targets({ "u.ts": 'import "dup";', "y/i.js": "", "y/package.json": x, "x/i.js": "", "x/package.json": x });
    expect(one).toEqual(two);
    expect(one[0]).toMatchObject({ unresolved: true });
  });

  test("a path that leaves the tree is unresolved", () => {
    expect(targets({ "a.ts": 'import "../x";', "x.ts": "" })[0]).toMatchObject({ unresolved: true });
    expect(targets({ "d/a.ts": 'import "../../x";', "x.ts": "" })[0]).toMatchObject({ unresolved: true });
  });

  test("a query is stripped for ESM syntax only", () => {
    expect(targets({ "a.cjs": 'require("./b.js?fresh");', "b.js": "" })).toEqual([{ unresolved: true }]);
    expect(targets({ "c.mjs": 'import "./b.js?fresh";', "b.js": "" })).toEqual([{ file: file("b.js") }]);
  });

  test("a require declared in another script is not the global one", () => {
    expect(importsOf({ "a.ts": "function require(x: string) {}", "b.ts": 'require("./c");', "c.ts": "" })).toEqual([]);
  });

  test("inline type specifiers make a type-only import", () => {
    const edges = importsOf({
      "a.ts": 'import {type B} from "./b";\nexport {type B} from "./b";\nimport {type B as C, d} from "./b";\nimport D, {type B as E} from "./b";\nimport {} from "./b";\n',
      "b.ts": "",
    });
    expect(edges.map((e) => e.typeOnly)).toEqual([true, true, false, false, false]);
  });
});
