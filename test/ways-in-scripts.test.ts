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

describe("round-2 edge cases (#126)", () => {
  test("exports null exclusions and more specific keys override a pattern", () => {
    const files = ["src/a.js", "src/private/secret.js", "src/special.js"];
    expect(pathsOf({ exports: { "./*": "./src/*.js", "./private/*": null } }, files)).toEqual(["src/a.js", "src/special.js"]);
    expect(pathsOf({ exports: { "./*": "./src/*.js", "./special": null } }, files)).toEqual(["src/a.js", "src/private/secret.js"]);
    expect(pathsOf({ exports: { "./*": "./src/*.js", "./private/*": "./src/special.js" } }, files)).toEqual(["src/a.js", "src/special.js"]);
    expect(pathsOf({ exports: { "./*": "./src/*.js", "./private/*": { import: null } } }, files)).toEqual(["src/a.js", "src/special.js"]);
  });
  test("every * in an exports target stands for the same text", () => {
    expect(pathsOf({ exports: { "./*": "./src/*/*.js" } }, ["src/a/a.js", "src/a/b.js", "src/c/c.js"])).toEqual(["src/a/a.js", "src/c/c.js"]);
  });
  test("a runner's flags are told from its script, and what follows the script is its arguments", () => {
    const files = ["app.js", "data.js", "setup.js"];
    expect(scripts("node missing.js data.js", files)).toEqual([]);
    expect(scripts("node app.js --test data.js", files)).toEqual(["app.js"]);
    expect(scripts("node --require setup.js app.js", files)).toEqual(["app.js"]);
    expect(scripts("node -r setup.js --import=data.js app.js", files)).toEqual(["app.js"]);
    expect(scripts("node --test data.js app.js", files)).toEqual(["app.js", "data.js"]);
    expect(scripts("node -e 'x' app.js", files)).toEqual([]);
    expect(scripts("deno run app.js data.js", files)).toEqual(["app.js"]);
  });
  test("a cd in a pipeline or in the background moves nothing", () => {
    const files = ["sub/app.js", "app.js"];
    expect(scripts("cd sub | cat; node app.js", files)).toEqual(["app.js"]);
    expect(scripts("cd sub & node app.js", files)).toEqual(["app.js"]);
    expect(scripts("cat | cd sub; node app.js", files)).toEqual(["app.js"]);
    expect(scripts("cd $X | cat; node app.js", files)).toEqual(["app.js"]);
  });
  test("trailing slashes name a folder", () => {
    expect(scripts("cd sub/ && node app.js", ["sub/app.js", "app.js"])).toEqual(["sub/app.js"]);
    expect(pathsOf({ main: "./lib/" }, ["lib/index.js"])).toEqual(["lib/index.js"]);
    expect(pathsOf({ main: "./lib/" }, ["lib.js"])).toEqual([]);
    expect(pathsOf({ bin: "./lib/" }, ["lib/index.js"])).toEqual([]);
    expect(pathsOf({ main: "." }, ["index.js"])).toEqual(["index.js"]);
  });
  test("a comment ends the command line, a # inside a word does not start one", () => {
    expect(scripts("echo ok # ; node unused.js", ["unused.js"])).toEqual([]);
    expect(scripts("node a.js # note\nnode b.js", ["a.js", "b.js"])).toEqual(["a.js", "b.js"]);
    expect(scripts("node a.js#x", ["a.js"])).toEqual([]);
    expect(scripts("node 'a.js' \"#\"", ["a.js"])).toEqual(["a.js"]);
  });
  test("a runner tries only the extensions it tries", () => {
    expect(scripts("node a", ["a.ts"])).toEqual([]);
    expect(scripts("node a", ["a.js"])).toEqual(["a.js"]);
    expect(scripts("node a", ["a/index.js"])).toEqual(["a/index.js"]);
    expect(scripts("tsx a", ["a.ts"])).toEqual(["a.ts"]);
    expect(scripts("tsx a", ["a.json"])).toEqual([]);
    expect(scripts("deno run a", ["a.ts"])).toEqual([]);
  });
  test("a command word holding a / is a path from the working folder", () => {
    expect(scripts("bin/tool.js --x", ["bin/tool.js"])).toEqual(["bin/tool.js"]);
    expect(scripts("cd sub && bin/run.js", ["sub/bin/run.js"])).toEqual(["sub/bin/run.js"]);
    expect(scripts("tool.js", ["tool.js"])).toEqual([]);
    expect(scripts("/abs/tool.js", ["abs/tool.js"])).toEqual([]);
  });
  test("a backslash in double quotes escapes only a dollar, a backtick, a double quote and a backslash", () => {
    expect(scripts(String.raw`node "dir\file.js"`, ["dirfile.js", String.raw`dir\file.js`])).toEqual([String.raw`dir\file.js`]);
    expect(scripts(String.raw`node "a\\b.js"`, [String.raw`a\b.js`])).toEqual([String.raw`a\b.js`]);
    expect(scripts(String.raw`node "a\"b.js"`, ['a"b.js'])).toEqual(['a"b.js']);
  });
});
