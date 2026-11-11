import { afterAll, expect, test } from "vitest";
import type { FileTree } from "../src/graph.ts";
import { serve } from "../src/server.ts";

const base: FileTree = new Map([
  ["package.json", "{}\n"],
  ["src/a.ts", "export function stay(x: number) {\n  if (x > 1) return 1;\n  return 2;\n}\n\nexport function gone() {\n  while (true) break;\n}\n"],
]);
const head: FileTree = new Map([
  ["package.json", "{}\n"],
  ["src/a.ts", "export function stay(x: number) {\n  if (x > 1) return 1;\n  return 2;\n}\n"],
]);
const comparing = await serve(head, 0, { ref: "main", commit: "0".repeat(40), tree: base });
const plain = await serve(head, 0);
afterAll(async () => {
  await comparing.close();
  await plain.close();
});

const pseudocode = (server: { url: string }, id: string) => fetch(new URL(`pseudocode?id=${encodeURIComponent(id)}`, server.url));

test("/pseudocode?id= is a derived document of lines, each with its depth, kind, text and source range", async () => {
  const response = await pseudocode(plain, "function:src/a.ts#stay");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toMatch(/^application\/json/);
  expect(await response.json()).toEqual({
    tier: "derived",
    id: "function:src/a.ts#stay",
    lines: [
      { depth: 0, kind: "if", text: "if (x > 1)", range: { start: 2, end: 2 } },
      { depth: 1, kind: "return", text: "return 1;", range: { start: 2, end: 2 } },
      { depth: 0, kind: "return", text: "return 2;", range: { start: 3, end: 3 } },
    ],
  });
});

test("answers 404 for a file, a class, a package and an unknown id", async () => {
  for (const id of ["file:src/a.ts", "package:", "function:src/a.ts#nothing"]) {
    expect((await pseudocode(plain, id)).status).toBe(404);
  }
  expect((await fetch(new URL("pseudocode", plain.url))).status).toBe(404);
});

test("a function removed in the comparison is outlined from the base tree", async () => {
  const body = (await (await pseudocode(comparing, "function:src/a.ts#gone")).json()) as { lines: { text: string }[] };
  expect(body.lines.map((line) => line.text)).toEqual(["while (true)", "break;"]);
  expect((await pseudocode(plain, "function:src/a.ts#gone")).status).toBe(404);
});
