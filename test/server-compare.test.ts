import { afterAll, expect, test } from "vitest";
import { compare, serializeComparison } from "../src/compare.ts";
import { extract } from "../src/extract/extract.ts";
import { serializeGraph } from "../src/graph.ts";
import type { FileTree } from "../src/graph.ts";
import { serve } from "../src/server.ts";

const base: FileTree = new Map([
  ["package.json", "{}\n"],
  ["src/keep.ts", "export function stay() {\n  return 1;\n}\n\nexport function gone() {\n  return 2;\n}\n"],
  ["src/old.ts", "export function oldOne() {\n  return 10;\n}\n"],
]);
const head: FileTree = new Map([
  ["package.json", "{}\n"],
  ["src/keep.ts", "export function stay() {\n  return 1;\n}\n"],
  ["src/new.ts", "export const fresh = () => 3;\n"],
]);
const against = { ref: "main", commit: "3f2a9c1d00000000000000000000000000000000", tree: base };

const comparing = await serve(head, 0, against);
const plain = await serve(head, 0);
const claimed = await serve(head, 0, against, "Adds <b>src/new.ts</b>.\n");
afterAll(async () => {
  await comparing.close();
  await plain.close();
  await claimed.close();
});

const get = (server: { url: string }, path: string) => fetch(new URL(path, server.url));
const source = (server: { url: string }, id: string) => get(server, `source?id=${encodeURIComponent(id)}`);

test("/comparison.json is the serialized comparison plus where it was made against", async () => {
  const response = await get(comparing, "comparison.json");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toMatch(/^application\/json/);
  const expected = {
    ...JSON.parse(serializeComparison(compare(extract(base), extract(head)))),
    against: { ref: "main", commit: against.commit },
  };
  expect(await response.json()).toEqual(expected);
});

test("/graph.json stays the head graph while comparing", async () => {
  expect(await (await get(comparing, "graph.json")).text()).toBe(serializeGraph(extract(head)));
});

test("without a base /comparison.json is 404 and /graph.json is the same", async () => {
  expect((await get(plain, "comparison.json")).status).toBe(404);
  expect(await (await get(plain, "graph.json")).text()).toBe(await (await get(comparing, "graph.json")).text());
});

test("a removed file is served from the base tree, byte for byte", async () => {
  const response = await source(comparing, "file:src/old.ts");
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(base.get("src/old.ts"));
});

test("a removed function of a removed file and of a surviving file serve base lines", async () => {
  expect(await (await source(comparing, "function:src/old.ts#oldOne")).text()).toBe(
    "export function oldOne() {\n  return 10;\n}",
  );
  expect(await (await source(comparing, "function:src/keep.ts#gone")).text()).toBe(
    "export function gone() {\n  return 2;\n}",
  );
});

test("a present module is still served from the head tree", async () => {
  expect(await (await source(comparing, "file:src/new.ts")).text()).toBe(head.get("src/new.ts"));
  expect(await (await source(comparing, "file:src/keep.ts")).text()).toBe(head.get("src/keep.ts"));
});

test("a removed id is 404 without a base, and a removed folder is 404 with one", async () => {
  expect((await source(plain, "file:src/old.ts")).status).toBe(404);
  expect((await source(comparing, "folder:src")).status).toBe(404);
  expect((await source(comparing, "file:nothing.ts")).status).toBe(404);
});

test("/claims.json carries the description as claimed text, and null when none was given", async () => {
  const given = await get(claimed, "claims.json");
  expect(given.status).toBe(200);
  expect(given.headers.get("content-type")).toMatch(/^application\/json/);
  expect(await given.json()).toEqual({ tier: "claimed", description: "Adds <b>src/new.ts</b>.\n" });
  expect(await (await get(comparing, "claims.json")).json()).toEqual({ tier: "claimed", description: null });
});

test("the description never reaches the graph or the comparison", async () => {
  expect(await (await get(claimed, "graph.json")).text()).toBe(await (await get(comparing, "graph.json")).text());
  expect(await (await get(claimed, "comparison.json")).text()).toBe(await (await get(comparing, "comparison.json")).text());
});

test("without a base there are no claims", async () => {
  expect((await get(plain, "claims.json")).status).toBe(404);
});
