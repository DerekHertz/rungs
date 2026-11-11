import { describe, expect, test } from "vitest";
import { extract } from "../src/extract/extract.ts";
import { waysIn } from "../src/ways-in.ts";

/** The declared ways in of a tree whose package.json is `manifest` and whose other files are `files`. */
function pathsOf(manifest: object, files: string[]): string[] {
  const made = new Map<string, string>([["package.json", JSON.stringify(manifest)], ...files.map((file): [string, string] => [file, "export const x = 1;\n"])]);
  return waysIn(made, extract(made)).filter((way) => !way.reasons.includes("test file")).map((way) => way.path).sort();
}
const scripts = (script: string, files: string[]): string[] => pathsOf({ scripts: { s: script } }, files);

describe("exports patterns", () => {
  test("a * in the target expands against the tree, the matched part may hold /", () => {
    expect(pathsOf({ exports: { "./*": "./src/*.js" } }, ["src/a.js", "src/deep/b.js", "src/c.ts", "other/d.js", "node_modules/p/src/e.js"])).toEqual(["src/a.js", "src/deep/b.js"]);
  });
  test("exports targets are exact: no extension is guessed", () => {
    expect(pathsOf({ exports: "./entry" }, ["entry.js"])).toEqual([]);
    expect(pathsOf({ exports: "./entry.js" }, ["entry.js"])).toEqual(["entry.js"]);
  });
  test("bin is exact, main keeps Node's fallbacks", () => {
    expect(pathsOf({ bin: "./entry" }, ["entry.js"])).toEqual([]);
    expect(pathsOf({ main: "./entry" }, ["entry.js"])).toEqual(["entry.js"]);
    expect(pathsOf({ main: "./entry" }, ["entry/index.js"])).toEqual(["entry/index.js"]);
  });
});

describe("script commands", () => {
  test("only the command word is a runner", () => {
    expect(scripts("echo node unused.js", ["unused.js"])).toEqual([]);
    expect(scripts("npm run node x.js", ["x.js"])).toEqual([]);
    expect(scripts("FOO=1 env BAR=2 node a.js", ["a.js"])).toEqual(["a.js"]);
  });
  test("quoting is honoured, and a command that cannot be parsed is skipped", () => {
    expect(scripts('node "src/my app.js"', ["src/my app.js"])).toEqual(["src/my app.js"]);
    expect(scripts("node 'a.js' && echo \"x && node b.js\"", ["a.js", "b.js"])).toEqual(["a.js"]);
    expect(scripts("node $(echo a.js)", ["a.js"])).toEqual([]);
    expect(scripts("node `echo a.js`", ["a.js"])).toEqual([]);
    expect(scripts('node "a.js', ["a.js"])).toEqual([]);
    expect(scripts("node src/*.js", ["src/a.js"])).toEqual([]);
  });
  test("cd moves later commands in the chain, an unresolvable cd skips them", () => {
    expect(scripts("cd sub && node app.js", ["sub/app.js", "app.js"])).toEqual(["sub/app.js"]);
    expect(scripts("cd nowhere && node app.js", ["app.js"])).toEqual([]);
    expect(scripts("cd $DIR && node app.js", ["app.js"])).toEqual([]);
  });
  test("a command word that is a relative path to a file is a way in", () => {
    expect(scripts("./bin/tool.js --x", ["bin/tool.js"])).toEqual(["bin/tool.js"]);
    expect(scripts("cd sub && ./run.js", ["sub/run.js", "run.js"])).toEqual(["sub/run.js"]);
  });
  test("arguments after the script are not ways in", () => {
    expect(scripts("node a.js b.js", ["a.js", "b.js"])).toEqual(["a.js"]);
    expect(scripts("node --test p.js q.js", ["p.js", "q.js"])).toEqual(["p.js", "q.js"]);
  });
});
