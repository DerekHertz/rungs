import { afterAll, expect, test } from "vitest";
import type { FileTree } from "../src/graph.ts";
import { serve } from "../src/server.ts";

const base: FileTree = new Map([
  ["package.json", "{}\n"],
  ["src/a.ts", "export function one() {\n  return 1;\n}\n\nexport function two() {\n  git(a);\n  return 2;\n}\n"],
  ["src/fold.ts", "export function f() {\n  x();\n}\nexport function g() {\n  y();\n}\n"],
  ["src/eol.ts", "export const k = 1;\n"],
  ["src/same.ts", "export const k = 1;\n"],
  ["src/old.ts", "export function oldOne() {\n  return 10;\n}\n"],
  ["src/gone.ts", "export const g = 1;\n"],
]);
const head: FileTree = new Map([
  ["package.json", "{}\n"],
  ["src/a.ts", "export function one() {\n  return 1;\n}\n\nexport function two() {\n  git(a, SAFE);\n  return 2;\n}\n"],
  ["src/fold.ts", "export function f() { x(); }\nexport function g() { y(); }\n"],
  ["src/eol.ts", "export const k = 1;"],
  ["src/same.ts", "export const k = 1;\n"],
  ["src/moved.ts", "export function oldOne() {\n  return 10;\n}\n"],
  ["src/new.ts", "export const fresh = () => 3;\n"],
]);
const against = { ref: "main", commit: "3f2a9c1d00000000000000000000000000000000", tree: base };
const comparing = await serve(head, 0, against);
const plain = await serve(head, 0);
afterAll(async () => {
  await comparing.close();
  await plain.close();
});

const changes = (server: { url: string }, id: string) => fetch(new URL(`changes?id=${encodeURIComponent(id)}`, server.url));

test("a changed function is its own rows: the removed line in place, no line number", async () => {
  const response = await changes(comparing, "function:src/a.ts#two");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toMatch(/^application\/json/);
  expect(await response.json()).toEqual({
    tier: "derived",
    id: "function:src/a.ts#two",
    added: 1,
    removed: 1,
    rows: [
      { kind: "same", line: 5, text: "export function two() {" },
      { kind: "removed", text: "  git(a);" },
      { kind: "added", line: 6, text: "  git(a, SAFE);" },
      { kind: "same", line: 7, text: "  return 2;" },
      { kind: "same", line: 8, text: "}" },
    ],
  });
});

test("the file is all its rows", async () => {
  const body = (await (await changes(comparing, "file:src/a.ts")).json()) as { rows: unknown[]; added: number; removed: number };
  expect(body.rows).toHaveLength(9);
  expect([body.added, body.removed]).toEqual([1, 1]);
});

test("a function of a changed file that did not change has no changes", async () => {
  expect((await changes(comparing, "function:src/a.ts#one")).status).toBe(404);
});

test("an added file is all added", async () => {
  const body = (await (await changes(comparing, "file:src/new.ts")).json()) as { rows: unknown[]; added: number; removed: number };
  expect([body.added, body.removed, body.rows.length]).toEqual([1, 0, 1]);
});

test("unchanged, moved, removed, folder and unknown modules have none; neither does a plain view", async () => {
  for (const id of ["file:src/same.ts", "file:src/moved.ts", "function:src/moved.ts#oldOne", "file:src/gone.ts", "folder:src", "file:nope.ts"]) {
    expect((await changes(comparing, id)).status, id).toBe(404);
  }
  expect((await changes(plain, "function:src/a.ts#two")).status).toBe(404);
  expect((await fetch(new URL("changes", comparing.url))).status).toBe(404);
});

test("removed lines are the function's own, from the base's ranges, not by position in the head", async () => {
  const rows = async (id: string) => ((await (await changes(comparing, id)).json()) as { rows: { kind: string; text: string }[] }).rows.map((r) => `${r.kind[0]}:${r.text}`);
  expect(await rows("function:src/fold.ts#f")).toEqual(["r:export function f() {", "r:  x();", "r:}", "a:export function f() { x(); }"]);
  expect(await rows("function:src/fold.ts#g")).toEqual(["r:export function g() {", "r:  y();", "r:}", "a:export function g() { y(); }"]);
});

test("losing the final newline is a change", async () => {
  const body = (await (await changes(comparing, "file:src/eol.ts")).json()) as { added: number; removed: number };
  expect([body.added, body.removed]).toEqual([1, 1]);
});
