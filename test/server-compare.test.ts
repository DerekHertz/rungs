import { afterAll, expect, test } from "vitest";
import { compare, serializeComparison } from "../src/compare.ts";
import { extract } from "../src/extract/extract.ts";
import { serializeGraph } from "../src/graph.ts";
import type { FileTree, NodeId } from "../src/graph.ts";
import { candidatesOf } from "../src/link.ts";
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
const seen: { texts: string[]; candidates: string[] }[] = [];
const linkedServer = await serve(head, 0, against, "Fresh numbers.\n- Trims keep.\n", async (comparison, claims, graph) => {
  seen.push({ texts: claims.map((claim) => claim.text), candidates: candidatesOf(comparison, graph).map((candidate) => candidate.id) });
  return {
    status: "ok",
    byClaim: [["file:src/new.ts" as NodeId], ["file:src/keep.ts" as NodeId]],
    model: "m",
    promptVersion: "p1",
    dropped: { ids: 2, claims: 1 },
    cached: false,
  };
});
const failedServer = await serve(head, 0, against, "Fresh numbers.\n", async () => ({ status: "failed", message: "claude CLI not found" }));
afterAll(async () => {
  await linkedServer.close();
  await failedServer.close();
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
  expect(await given.json()).toEqual({
    tier: "claimed",
    description: "Adds <b>src/new.ts</b>.\n",
    claims: [{ index: 0, text: "Adds <b>src/new.ts</b>.", start: 0, end: 23, ids: [] }],
    link: { status: "off" },
  });
  expect(await (await get(comparing, "claims.json")).json()).toEqual({ tier: "claimed", description: null, claims: [], link: { status: "off" } });
});

test("the description never reaches the graph or the comparison", async () => {
  expect(await (await get(claimed, "graph.json")).text()).toBe(await (await get(comparing, "graph.json")).text());
  expect(await (await get(claimed, "comparison.json")).text()).toBe(await (await get(comparing, "comparison.json")).text());
});

test("without a base there are no claims", async () => {
  expect((await get(plain, "claims.json")).status).toBe(404);
});

test("/contracts.json carries the contracts that moved as a derived fact, and is 404 without a base", async () => {
  const response = await get(comparing, "contracts.json");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toMatch(/^application\/json/);
  expect(await response.json()).toEqual({
    tier: "derived",
    moves: [
      { kind: "removed", id: "function:src/keep.ts#gone", before: "()", after: null },
      { kind: "added", id: "function:src/new.ts#fresh", before: null, after: "()" },
      { kind: "removed", id: "function:src/old.ts#oldOne", before: "()", after: null },
    ],
  });
  expect((await get(plain, "contracts.json")).status).toBe(404);
});

test("/claims.json carries each claim's span and linked ids, and how the links were made, as claimed", async () => {
  const body = (await (await get(linkedServer, "claims.json")).json()) as Record<string, unknown>;
  expect(body).toEqual({
    tier: "claimed",
    description: "Fresh numbers.\n- Trims keep.\n",
    claims: [
      { index: 0, text: "Fresh numbers.", start: 0, end: 14, ids: ["file:src/new.ts"] },
      { index: 1, text: "Trims keep.", start: 17, end: 28, ids: ["file:src/keep.ts"] },
    ],
    link: { status: "ok", model: "m", promptVersion: "p1", dropped: { ids: 2, claims: 1 }, cached: false },
  });
  expect(seen).toEqual([{ texts: ["Fresh numbers.", "Trims keep."], candidates: expect.arrayContaining(["file:src/new.ts", "folder:src", "file:src/keep.ts"]) }]);
});

test("a failed link is said so in /claims.json, with no ids", async () => {
  const body = (await (await get(failedServer, "claims.json")).json()) as { claims: { ids: string[] }[]; link: unknown };
  expect(body.link).toEqual({ status: "failed", message: "claude CLI not found" });
  expect(body.claims.map((claim) => claim.ids)).toEqual([[]]);
});

test("links stay out of the graph and the comparison", async () => {
  expect(await (await get(linkedServer, "graph.json")).text()).toBe(await (await get(comparing, "graph.json")).text());
  expect(await (await get(linkedServer, "comparison.json")).text()).toBe(await (await get(comparing, "comparison.json")).text());
});
