import { afterAll, expect, test } from "vitest";
import type { FileTree } from "../src/graph.ts";
import { treeDigest } from "../src/observed.ts";
import { serve } from "../src/server.ts";

const tree: FileTree = new Map([["package.json", "{}\n"]]);
const named = await serve(tree, 0, undefined, undefined, undefined, undefined, undefined, undefined, "docviz");
const unnamed = await serve(tree, 0);
afterAll(async () => {
  await named.close();
  await unnamed.close();
});

test("/run.json names the repository the server was given, and null when it has none", async () => {
  expect(await (await fetch(`${named.url}run.json`)).json()).toEqual({ tier: "derived", repo: "docviz", tree: treeDigest(tree) });
  expect(await (await fetch(`${unnamed.url}run.json`)).json()).toEqual({ tier: "derived", repo: null, tree: treeDigest(tree) });
});
