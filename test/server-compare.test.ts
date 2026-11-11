import { afterAll, expect, test } from "vitest";
import { compare, serializeComparison } from "../src/compare.ts";
import { extract } from "../src/extract/extract.ts";
import { serializeGraph } from "../src/graph.ts";
import type { FileTree, NodeId } from "../src/graph.ts";
import { candidatesOf } from "../src/link.ts";
import { serve } from "../src/server.ts";
import { placesOf } from "../src/tour.ts";

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
    shown: [{ text: "Adds fresh numbers.", restated: true, sources: [0], ids: ["file:src/new.ts" as NodeId] }],
    context: [1],
    dropped: { ids: 2, claims: 1, restatements: 0 },
    cached: false,
  };
});
const failedServer = await serve(head, 0, against, "Fresh numbers.\n", async () => ({ status: "failed", message: "claude CLI not found" }));
const toured: { texts: string[]; places: string[] }[] = [];
const tourServer = await serve(head, 0, against, "Fresh numbers.\n", undefined, async (comparison, claims, graph) => {
  toured.push({ texts: claims.map((claim) => claim.text), places: placesOf(comparison, graph).map((place) => place.id) });
  return {
    status: "ok",
    stops: [{ title: "New <b>numbers</b>", ids: ["file:src/new.ts" as NodeId], claims: [0], sentences: [{ text: "Adds fresh.", id: "file:src/new.ts" as NodeId, range: { start: 1, end: 1 } }] }],
    dropped: { stops: 1, ids: 2, claims: 0, sentences: 3 },
    model: "m",
    promptVersion: "t1",
    cached: false,
  };
});
const lostServer = await serve(head, 0, against, undefined, undefined, async () => ({ status: "failed", message: "claude CLI timed out after 600s" }));
afterAll(async () => {
  await tourServer.close();
  await lostServer.close();
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
    claims: [{ index: 0, text: "Adds <b>src/new.ts</b>.", restated: false, sources: [{ index: 0, text: "Adds <b>src/new.ts</b>.", start: 0, end: 23 }], ids: [] }],
    sentences: [{ index: 0, text: "Adds <b>src/new.ts</b>.", start: 0, end: 23 }],
    context: [],
    link: { status: "off" },
  });
  expect(await (await get(comparing, "claims.json")).json()).toEqual({ tier: "claimed", description: null, claims: [], sentences: [], context: [], link: { status: "off" } });
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
    effectsChanged: [],
  });
  expect((await get(plain, "contracts.json")).status).toBe(404);
});

test("/claims.json carries each shown claim's restatement, source sentences and linked ids, and the context lines dropped, and how the links were made, as claimed", async () => {
  const body = (await (await get(linkedServer, "claims.json")).json()) as Record<string, unknown>;
  expect(body).toEqual({
    tier: "claimed",
    description: "Fresh numbers.\n- Trims keep.\n",
    claims: [{ index: 0, text: "Adds fresh numbers.", restated: true, sources: [{ index: 0, text: "Fresh numbers.", start: 0, end: 14 }], ids: ["file:src/new.ts"] }],
    sentences: [
      { index: 0, text: "Fresh numbers.", start: 0, end: 14 },
      { index: 1, text: "Trims keep.", start: 17, end: 28 },
    ],
    context: [{ index: 1, text: "Trims keep.", start: 17, end: 28 }],
    link: { status: "ok", model: "m", promptVersion: "p1", dropped: { ids: 2, claims: 1, restatements: 0 }, cached: false },
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

test("/comparison.json lists the effect edges that appeared and /contracts.json says which exported function reaches more", async () => {
  const imports = 'import { spawn } from "node:child_process";\n';
  const before: FileTree = new Map([["package.json", "{}\n"], ["src/run.mjs", `${imports}export function run() {\n  return 1;\n}\n`]]);
  const after: FileTree = new Map([["package.json", "{}\n"], ["src/run.mjs", `${imports}export function run() {\n  spawn("git");\n}\n`]]);
  const server = await serve(after, 0, { ref: "main", commit: "3f2a9c1d00000000000000000000000000000000", tree: before });
  try {
    const comparison = (await (await get(server, "comparison.json")).json()) as { effects: { kind: string; edge: { from: string; operation: string; target: unknown } }[] };
    expect(comparison.effects.map((change) => [change.kind, change.edge.from, change.edge.operation, change.edge.target])).toEqual([
      ["added", "function:src/run.mjs#run", "child_process spawn", { literal: "git" }],
    ]);
    const contracts = (await (await get(server, "contracts.json")).json()) as { moves: unknown[] };
    expect(contracts.moves).toEqual([
      {
        kind: "effects",
        id: "function:src/run.mjs#run",
        before: "()",
        after: "()",
        effects: { added: ['process child_process spawn "git"'], removed: [] },
      },
    ]);
  } finally {
    await server.close();
  }
});

test("/walkthrough.json carries the tour as claimed, with how it was made and what was dropped", async () => {
  const body = (await (await get(tourServer, "walkthrough.json")).json()) as Record<string, unknown>;
  expect(body).toEqual({
    tier: "claimed",
    walkthrough: { status: "ok", model: "m", promptVersion: "t1", dropped: { stops: 1, ids: 2, claims: 0, sentences: 3 }, cached: false },
    stops: [{ title: "New <b>numbers</b>", ids: ["file:src/new.ts"], claims: [0], sentences: [{ text: "Adds fresh.", id: "file:src/new.ts", range: { start: 1, end: 1 } }] }],
  });
  expect(toured).toEqual([{ texts: ["Fresh numbers."], places: expect.arrayContaining(["file:src/new.ts", "file:src/keep.ts", "function:src/keep.ts#gone"]) }]);
});

test("/walkthrough.json says off when no tour was asked for, failed with the reason when it failed, and is 404 without a base", async () => {
  expect(await (await get(comparing, "walkthrough.json")).json()).toEqual({ tier: "claimed", walkthrough: { status: "off" }, stops: [] });
  expect(await (await get(lostServer, "walkthrough.json")).json()).toEqual({ tier: "claimed", walkthrough: { status: "failed", message: "claude CLI timed out after 600s" }, stops: [] });
  expect((await get(plain, "walkthrough.json")).status).toBe(404);
});

test("a tour stays out of the graph, the comparison and the claims", async () => {
  expect(await (await get(tourServer, "graph.json")).text()).toBe(await (await get(comparing, "graph.json")).text());
  expect(await (await get(tourServer, "comparison.json")).text()).toBe(await (await get(comparing, "comparison.json")).text());
  expect(await (await get(tourServer, "contracts.json")).text()).toBe(await (await get(comparing, "contracts.json")).text());
  expect(((await (await get(tourServer, "claims.json")).json()) as { link: unknown }).link).toEqual({ status: "off" });
});

test("/test-changes.json is the derived list of what the change did to the tests, and only when comparing", async () => {
  const text = 'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("one", () => { assert.equal(f(), 1); });\n';
  const server = await serve(
    new Map([["package.json", "{}\n"]]),
    0,
    { ref: "main", commit: "3f2a9c1d00000000000000000000000000000000", tree: new Map([["package.json", "{}\n"], ["test/a.test.mjs", text]]) },
  );
  try {
    expect(await (await fetch(new URL("test-changes.json", server.url))).json()).toEqual({
      tier: "derived",
      deletedFiles: [{ path: "test/a.test.mjs", tests: 1 }],
      removedTests: [],
      markers: [],
      weakened: [],
    });
  } finally {
    await server.close();
  }
  expect((await fetch(new URL("test-changes.json", plain.url))).status).toBe(404);
});
