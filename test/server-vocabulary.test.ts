import { afterAll, expect, test } from "vitest";
import type { FileTree } from "../src/graph.ts";
import { serve } from "../src/server.ts";
import type { StoredRead } from "../src/setup.ts";

const servers: { close(): Promise<void> }[] = [];
afterAll(async () => {
  for (const server of servers) await server.close();
});

const base: FileTree = new Map([
  ["package.json", "{}\n"],
  ["src/a.ts", "export function a(): number {\n  return 1;\n}\n"],
]);
const head: FileTree = new Map([...base, ["src/a.ts", "export function a(): number {\n  return 2;\n}\n"]]);
const against = { ref: "main", commit: "0".repeat(40), tree: base };

const start = async (tree: FileTree, withBase: boolean, read?: StoredRead) => {
  const server = await serve(tree, 0, withBase ? against : undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, read);
  servers.push(server);
  return server;
};
const get = async (server: { url: string }) => fetch(new URL("vocabulary.json", server.url));

test("/vocabulary.json says there is no vocabulary when none was stored, derived and with no terms", async () => {
  const server = await start(head, true, { kind: "missing" });
  const response = await get(server);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ tier: "derived", state: "none", terms: [], files: [] });
});

test("/vocabulary.json is 'none' when the host did not read one, never an empty vocabulary", async () => {
  const server = await start(head, true);
  expect(await (await get(server)).json()).toMatchObject({ state: "none" });
});

test("an unreadable stored vocabulary is served as unreadable with the reason", async () => {
  const server = await start(head, true, { kind: "unreadable", why: "it is not JSON" });
  expect(await (await get(server)).json()).toMatchObject({ state: "unreadable", why: "it is not JSON" });
});

test("a run with no base has no /vocabulary.json: the file card is a comparison's", async () => {
  const server = await start(head, false);
  expect((await get(server)).status).toBe(404);
});
