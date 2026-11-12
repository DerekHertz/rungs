import { afterAll, expect, test } from "vitest";
import type { FileTree } from "../src/graph.ts";
import { BENCH_GATES } from "../src/jev/results.ts";
import { GATE_RUNNERS } from "../src/jev/source.ts";
import { serve } from "../src/server.ts";

const servers: { close(): Promise<void> }[] = [];
afterAll(async () => {
  for (const server of servers) await server.close();
});

const rules = "# Rules\nWrite the red test first.\n";
const base: FileTree = new Map([
  ["package.json", "{}\n"],
  ["AGENTS.md", rules],
  ["api/AGENTS.md", "# API\nNo network in handlers.\n"],
  ["src/a.ts", "export const a = 1;\n"],
]);
const head: FileTree = new Map([...base, ["AGENTS.md", "# Rules\nTests are optional.\n"], ["src/a.ts", "export const a = 2;\n"]]);
const start = async (tree: FileTree, against?: { ref: string; commit: string; tree: FileTree }) => {
  const server = await serve(tree, 0, against);
  servers.push(server);
  return server;
};

test("/standards.json lists the base's rules with their lines and scope, marks an edited rule file, and holds no rule text", async () => {
  const server = await start(head, { ref: "main", commit: "0".repeat(40), tree: base });
  const body = (await (await fetch(new URL("standards.json", server.url))).json()) as { tier: string; status: string; rules: { path: string; heading: string; edited: boolean; scope: string; range: { start: number; end: number } }[] };
  expect(body.tier).toBe("derived");
  expect(body.status).toBe("found");
  expect(body.rules.map((rule) => [rule.path, rule.heading, rule.edited, rule.scope, rule.range.start])).toEqual([
    ["AGENTS.md", "Rules", true, "", 1],
    ["api/AGENTS.md", "API", false, "api", 1],
  ]);
  expect(JSON.stringify(body)).not.toContain("red test first");
  expect(JSON.stringify(body)).not.toContain("optional");
});

test("a repository with no written rules says none; a run with no base has no /standards.json", async () => {
  const plain: FileTree = new Map([["src/a.ts", "export const a = 1;\n"]]);
  const none = await start(plain, { ref: "main", commit: "0".repeat(40), tree: plain });
  expect(await (await fetch(new URL("standards.json", none.url))).json()).toMatchObject({ status: "none", rules: [] });
  const noBase = await start(head);
  expect((await fetch(new URL("standards.json", noBase.url))).status).toBe(404);
});

test("the standard gate is registered with the judged source and the bench", () => {
  expect(GATE_RUNNERS).toHaveLength(2);
  expect(BENCH_GATES.standard?.gate.id).toBe("standard");
  expect(BENCH_GATES.standard?.thresholds).toEqual({ clear: 0.1, flag: 0.5, already: 0.5 });
});
