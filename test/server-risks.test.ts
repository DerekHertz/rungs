import { afterAll, expect, test } from "vitest";
import type { FileTree } from "../src/graph.ts";
import { serve } from "../src/server.ts";

const base: FileTree = new Map([
  ["package.json", "{}\n"],
  ["src/a.ts", "export function f(x) {\n  return x;\n}\n"],
  ["src/b.ts", 'import { f } from "./a.ts";\nexport const g = f;\n'],
]);
const head: FileTree = new Map(base).set("src/a.ts", "export function f(x, y) {\n  return x;\n}\n");
const comparing = await serve(head, 0, { ref: "main", commit: "0".repeat(40), tree: base });
const plain = await serve(head, 0);
afterAll(async () => {
  await comparing.close();
  await plain.close();
});

test("/risks.json serves the ranked risks as a derived fact, and is 404 without a base", async () => {
  const body = (await (await fetch(`${comparing.url}risks.json`)).json()) as { tier: string; risks: { label: string; blast: { count: number; files: string[] } }[] };
  expect(body.tier).toBe("derived");
  expect(body.risks.map((risk) => risk.label)).toEqual(["f signature changed"]);
  expect(body.risks[0]!.blast).toEqual({ count: 1, files: ["src/b.ts"], unknown: 0 });
  expect((await fetch(`${plain.url}risks.json`)).status).toBe(404);
});
