import { describe, expect, test } from "vitest";
import { extract } from "../src/extract/extract.ts";
import { waysIn } from "../src/ways-in.ts";

const tree = new Map<string, string>([
  ["package.json", JSON.stringify({ main: "./src/index.js", bin: { tool: "bin/tool.js" }, exports: { ".": { import: "./src/index.js", require: "./src/cjs.js" }, "./x": "./src/x.js", "./gone": "./dist/none.js" }, scripts: { start: "node src/start.js --flag && tsx scripts/build.ts", test: "vitest run", lint: "eslint src/index.js" } })],
  ["src/index.js", "export const a = 1;\n"],
  ["src/cjs.js", "exports.a = 1;\n"],
  ["src/x.js", "export const x = 1;\n"],
  ["src/start.js", "export const s = 1;\n"],
  ["bin/tool.js", "console.log(1);\n"],
  ["scripts/build.ts", "export const b = 1;\n"],
  ["test/a.test.js", "export const t = 1;\n"],
  ["packages/p/package.json", JSON.stringify({ main: "lib/main", scripts: { go: "node ./go.js" } })],
  ["packages/p/lib/main.js", "export const m = 1;\n"],
  ["packages/p/go.js", "export const g = 1;\n"],
  ["lonely.js", "export const l = 1;\n"],
]);

describe("waysIn", () => {
  const found = new Map(waysIn(tree, extract(tree)).map((way) => [way.path, way.reasons]));

  test("reads main, bin, exports (any condition) and scripts, each relative to its own package.json", () => {
    expect(found.get("src/index.js")).toEqual(["package.json exports", "package.json main"]);
    expect(found.get("bin/tool.js")).toEqual(["package.json bin"]);
    expect(found.get("src/cjs.js")).toEqual(["package.json exports"]);
    expect(found.get("src/x.js")).toEqual(["package.json exports"]);
    expect(found.get("src/start.js")).toEqual(["package.json scripts.start"]);
    expect(found.get("scripts/build.ts")).toEqual(["package.json scripts.start"]);
    expect(found.get("packages/p/lib/main.js")).toEqual(["package.json main"]);
    expect(found.get("packages/p/go.js")).toEqual(["package.json scripts.go"]);
  });

  test("includes test files and nothing the repo does not declare", () => {
    expect(found.get("test/a.test.js")).toEqual(["test file"]);
    expect(found.has("lonely.js")).toBe(false);
    expect(found.has("dist/none.js")).toBe(false);
    // `eslint src/index.js` is not a runner.
    expect(found.get("src/index.js")).not.toContain("package.json scripts.lint");
  });

  test("is sorted and survives a package.json that is not JSON", () => {
    const paths = [...found.keys()];
    expect(paths).toEqual([...paths].sort());
    const bad = new Map([["package.json", "{"], ["a.js", "x\n"]]);
    expect(waysIn(bad, extract(bad))).toEqual([]);
  });
});
