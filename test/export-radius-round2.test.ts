import { describe, expect, test } from "vitest";
import { compare } from "../src/compare.ts";
import { extract } from "../src/extract/extract.ts";
import type { NodeId } from "../src/graph.ts";
import { exportRadiusOf } from "../src/importance.ts";
import { risksOf } from "../src/risks.ts";
import { testChanges } from "../src/test-changes.ts";
import { isTestFile } from "../src/test-files.ts";

// Whatever the extractor cannot name exactly counts as all: over-counting is allowed, under-counting is not.
const treeOf = (files: Record<string, string>): Map<string, string> => new Map(Object.entries({ "package.json": "{}\n", ...files }));
const contractsOfChange = (baseFiles: Record<string, string>, headFiles: Record<string, string>): string[][] => {
  const base = treeOf(baseFiles);
  const head = treeOf(headFiles);
  const [baseGraph, headGraph] = [extract(base), extract(head)];
  const items = risksOf(compare(baseGraph, headGraph, { base, head }), baseGraph, headGraph, testChanges(base, head), isTestFile);
  return items.filter((item) => item.kind === "contract").map((item) => [item.label, ...item.blast.files]);
};

describe("round 2 undercounts", () => {
  test("an `export =` type is reached by a default import (and any other)", () => {
    const use = { "use.ts": 'import type T from "./core";\nexport const t: T = { x: "" };\n' };
    const found = contractsOfChange({ ...use, "core.ts": "interface T {\n  x: string;\n}\nexport = T;\n" }, { ...use, "core.ts": "interface T {\n  x: number;\n}\nexport = T;\n" });
    expect(found.length).toBeGreaterThan(0);
    for (const item of found) expect(item).toContain("use.ts");
  });

  test("a self re-export alias passes its name on to the file's importers", () => {
    const graph = extract(
      treeOf({
        "core.ts": 'export function f(a) {}\nexport { f as g } from "./core.ts";\n',
        "use.ts": 'import { g } from "./core.ts";\nexport const u = g;\n',
      }),
    );
    expect(exportRadiusOf(graph)("file:core.ts" as NodeId, ["f"])).toEqual(["file:use.ts"]);
  });

  test("a dotted export name is not split into a namespace", () => {
    const use = { "use.ts": 'import { "api.f" as g } from "./index.ts";\nexport const u = g;\n' };
    const files = { "a.ts": "export const f = 1;\n", "b.ts": "export const f = 2;\n" };
    const found = contractsOfChange({ ...files, ...use, "index.ts": 'export { f as "api.f" } from "./a.ts";\n' }, { ...files, ...use, "index.ts": 'export { f as "api.f" } from "./b.ts";\n' });
    expect(found.length).toBeGreaterThan(0);
    for (const item of found) expect(item).toContain("use.ts");
  });
});
