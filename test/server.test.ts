import { afterAll, expect, test } from "vitest";
import { extract } from "../src/extract/extract.ts";
import { serializeGraph } from "../src/graph.ts";
import type { FileTree } from "../src/graph.ts";
import { serve } from "../src/server.ts";

const SHAPES = [
  "export class Square {",
  "  area(): number {",
  "    const squared = () => this.side * this.side;",
  "    return squared();",
  "  }",
  '  get "half size"(): number {',
  "    return 1;",
  "  }",
  "}",
  "",
  "export function scale(by: number): number {",
  "  return [1].map((n) => n * by).filter((n) => n > 0)[0] ?? 0;",
  "}",
  "",
  "[1].map((n) => n);",
  "[2].map((n) => n * 2);",
  'describe("it works", () => {',
  "  expect(1).toBe(1);",
  "});",
  "",
].join("\n");

const tree: FileTree = new Map([
  ["package.json", "{}\n"],
  ["src/shapes.ts", SHAPES],
  ["src/crlf.ts", "export function a() {\r\n  return 1;\r\n}\r\n\r\nexport function b() {\r\n  return 2;\r\n}\r\n"],
  ["src/bare.ts", "export function last() {\n  return 3;\n}"],
]);

const server = await serve(tree, 0);
afterAll(() => server.close());

async function source(id: string): Promise<Response> {
  return fetch(new URL(`source?id=${encodeURIComponent(id)}`, server.url));
}

async function sourceText(id: string): Promise<string> {
  const response = await source(id);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toMatch(/^text\/plain/);
  return response.text();
}

test("serves the page, its script and the graph of the snapshot", async () => {
  const page = await fetch(server.url);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain('src="/main.js"');

  const script = await fetch(new URL("main.js", server.url));
  expect(script.status).toBe(200);
  expect(script.headers.get("content-type")).toMatch(/^text\/javascript/);

  const served = await fetch(new URL("graph.json", server.url));
  expect(served.status).toBe(200);
  expect(await served.text()).toBe(serializeGraph(extract(tree)));
});

test("answers 404 for anything else", async () => {
  expect((await fetch(new URL("missing", server.url))).status).toBe(404);
});

test("a function is exactly its own lines", async () => {
  expect(await sourceText("function:src/shapes.ts#scale")).toBe(
    [
      "export function scale(by: number): number {",
      "  return [1].map((n) => n * by).filter((n) => n > 0)[0] ?? 0;",
      "}",
    ].join("\n"),
  );
});

test("a nested function is exactly its own line, not its parent's", async () => {
  expect(await sourceText("function:src/shapes.ts#Square.area.squared")).toBe(
    "    const squared = () => this.side * this.side;",
  );
});

test("a method is exactly its lines, and a class its whole range", async () => {
  expect(await sourceText('function:src/shapes.ts#Square."get half size"')).toBe(
    ['  get "half size"(): number {', "    return 1;", "  }"].join("\n"),
  );
  expect(await sourceText("class:src/shapes.ts#Square")).toBe(SHAPES.split("\n").slice(0, 9).join("\n"));
});

test("a file is its whole text", async () => {
  expect(await sourceText("file:src/shapes.ts")).toBe(SHAPES);
});

test("a qualified name with quotes, spaces, parentheses and @ survives the query string", async () => {
  expect(await sourceText('function:src/shapes.ts#"describe(\\"it works\\") callback"')).toBe(
    ['describe("it works", () => {', "  expect(1).toBe(1);", "});"].join("\n"),
  );
  expect(await sourceText('function:src/shapes.ts#"map() callback"@2')).toBe("[2].map((n) => n * 2);");
  expect(await sourceText('function:src/shapes.ts#"map() callback"')).toBe("[1].map((n) => n);");
  expect(await sourceText('function:src/shapes.ts#scale."filter() callback"')).toBe(
    "  return [1].map((n) => n * by).filter((n) => n > 0)[0] ?? 0;",
  );
});

test("CRLF lines keep their carriage returns and nothing from a neighbour", async () => {
  expect(await sourceText("function:src/crlf.ts#b")).toBe("export function b() {\r\n  return 2;\r\n}\r");
  expect(await sourceText("file:src/crlf.ts")).toBe(tree.get("src/crlf.ts"));
});

test("a file without a trailing newline serves its last line whole", async () => {
  expect(await sourceText("function:src/bare.ts#last")).toBe("export function last() {\n  return 3;\n}");
  expect(await sourceText("file:src/bare.ts")).toBe(tree.get("src/bare.ts"));
});

test("answers 404 for a package, a folder and an unknown id", async () => {
  expect((await source("package:")).status).toBe(404);
  expect((await source("folder:src")).status).toBe(404);
  expect((await source("function:src/shapes.ts#nothing")).status).toBe(404);
  expect((await fetch(new URL("source", server.url))).status).toBe(404);
});

test("serves the snapshot it was given, even if the caller's map changes later", async () => {
  const mutable = new Map([["a.ts", "function oldName() {}\n"]]);
  const own = await serve(mutable, 0);
  try {
    mutable.set("a.ts", "const unrelated = 99;\n");
    const response = await fetch(new URL(`source?id=${encodeURIComponent("function:a.ts#oldName")}`, own.url));
    expect(await response.text()).toBe("function oldName() {}");
  } finally {
    await own.close();
  }
});

test("serves the town sheet: its sizes and a sprite, and nothing else from /town/", async () => {
  const sizes = await fetch(`${server.url}town/sprites.json`);
  expect(sizes.status).toBe(200);
  const sheet = (await sizes.json()) as Record<string, { w: number; h: number; ox: number; oy: number }>;
  expect(Object.keys(sheet)).toContain("workshop-1");
  const sprite = await fetch(`${server.url}town/workshop-1.png`);
  expect(sprite.status).toBe(200);
  expect(sprite.headers.get("content-type")).toBe("image/png");
  expect((await fetch(`${server.url}town/make_sprites.py`)).status).toBe(404);
  expect((await fetch(`${server.url}town/..%2Fmake_sprites.py`)).status).toBe(404);
});
