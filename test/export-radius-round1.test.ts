import { describe, expect, test } from "vitest";
import { compare } from "../src/compare.ts";
import { extract } from "../src/extract/extract.ts";
import { risksOf } from "../src/risks.ts";
import { testChanges } from "../src/test-changes.ts";
import { isTestFile } from "../src/test-files.ts";

// Whatever the extractor cannot name exactly counts as all: over-counting is allowed, under-counting is not.
const treeOf = (files: Record<string, string>): Map<string, string> => new Map(Object.entries({ "package.json": "{}\n", ...files }));
const importsOf = (files: Record<string, string>, path: string): unknown =>
  extract(treeOf(files))
    .imports.filter((edge) => edge.from === `file:${path}`)
    .map((edge) => [edge.specifier, edge.names]);
const contractsOfChange = (baseFiles: Record<string, string>, headFiles: Record<string, string>): string[][] => {
  const base = treeOf(baseFiles);
  const head = treeOf(headFiles);
  const [baseGraph, headGraph] = [extract(base), extract(head)];
  const items = risksOf(compare(baseGraph, headGraph, { base, head }), baseGraph, headGraph, testChanges(base, head), isTestFile);
  return items.filter((item) => item.kind === "contract").map((item) => [item.label, ...item.blast.files]);
};

describe("round 1 undercounts", () => {
  test("a property read on an unawaited import() (then, catch, anything) is all; only an awaited value names an export", () => {
    expect(
      importsOf(
        {
          "u.js":
            'import("./c.js").then((m) => m.f(1));\nimport("./d.js").catch(() => 0);\nconst p = import("./e.js");\nexport { p };\nasync function g() {\n  const { a } = await import("./h.js");\n  return (await import("./i.js")).b + a;\n}\n',
        },
        "u.js",
      ),
    ).toEqual([
      ["./c.js", "all"],
      ["./d.js", "all"],
      ["./e.js", "all"],
      ["./h.js", ["a"]],
      ["./i.js", ["b"]],
    ]);
    const use = { "use.js": 'import("./core.js").then((m) => m.f(1));\n' };
    expect(contractsOfChange({ ...use, "core.js": "export function f(a) {}\n" }, { ...use, "core.js": "export function f(a, b) {}\n" })).toEqual([["f signature changed", "use.js"]]);
  });

  test("a CommonJS export answers to a default import of the whole module", () => {
    const use = { "use.mjs": 'import lib from "./core.cjs";\nlib.f(1);\n' };
    expect(contractsOfChange({ ...use, "core.cjs": "exports.f = function (a) {};\n" }, { ...use, "core.cjs": "exports.f = function (a, b) {};\n" })).toEqual([
      ["\"exports.f\" signature changed", "use.mjs"],
    ]);
  });

  test("a changed wildcard re-export counts the importers of the names it passed on", () => {
    const files = { "a.ts": "export const f = 1;\n", "b.ts": "export const f = 2;\n", "use.ts": 'import { f } from "./index.ts";\nexport const u = f;\n' };
    const found = contractsOfChange({ ...files, "index.ts": 'export * from "./a.ts";\n' }, { ...files, "index.ts": 'export * from "./b.ts";\n' });
    expect(found.length).toBeGreaterThan(0);
    for (const item of found) expect(item).toContain("use.ts");
  });
});
