import { afterAll, expect, test } from "vitest";
import type { FileTree } from "../src/graph.ts";
import { serve } from "../src/server.ts";

const base: FileTree = new Map([
  ["package.json", "{}\n"],
  ["src/a.ts", "export function f(x) {\n  return x;\n}\nfunction g() {\n  return 1;\n}\n"],
  ["src/b.ts", 'import { f } from "./a.ts";\nexport const h = f;\n'],
]);
const head: FileTree = new Map(base)
  .set("src/a.ts", "export function f(x, y) {\n  return x;\n}\nfunction g() {\n  return 2;\n}\n")
  .set("src/b.ts", 'import { f } from "./a.ts";\nexport function h(obj, name) {\n  f(1, 2);\n  obj[name]();\n}\n');
const comparing = await serve(head, 0, { ref: "main", commit: "0".repeat(40), tree: base });
const plain = await serve(head, 0);
afterAll(async () => {
  await comparing.close();
  await plain.close();
});

test("/file-why serves a file's why-line and defining blocks as a derived fact", async () => {
  const body = (await (await fetch(`${comparing.url}file-why?id=${encodeURIComponent("file:src/a.ts")}`)).json()) as {
    tier: string;
    why: { contracts: string[]; dependents: string[] };
    defining: { label: string }[];
    other: { label: string }[];
  };
  expect(body.tier).toBe("derived");
  expect(body.why.contracts).toEqual(["f signature changed"]);
  expect(body.why.dependents).toEqual(["src/b.ts"]);
  expect(body.defining.map((block) => block.label)).toEqual(["f"]);
  expect(body.other.map((block) => block.label)).toEqual(["g"]);
});

test("/file-why is 404 without a base, for a function and for an unknown id", async () => {
  expect((await fetch(`${plain.url}file-why?id=${encodeURIComponent("file:src/a.ts")}`)).status).toBe(404);
  expect((await fetch(`${comparing.url}file-why?id=${encodeURIComponent("function:src/a.ts#f")}`)).status).toBe(404);
  expect((await fetch(`${comparing.url}file-why?id=nope`)).status).toBe(404);
});

test("/file-why gives each block its callers and callees, resolved by the compiler, and unresolved calls apart", async () => {
  const body = (await (await fetch(`${comparing.url}file-why?id=${encodeURIComponent("file:src/a.ts")}`)).json()) as {
    defining: { label: string; reasons: string[]; callers: { label: string; path: string; at: { start: number }[] }[]; callees: unknown }[];
  };
  const f = body.defining.find((block) => block.label === "f")!;
  expect(f.callers.map((ref) => [ref.label, ref.path, ref.at])).toEqual([["h", "src/b.ts", [{ start: 3, end: 3 }]]]);
  expect(f.reasons).toContain("most callers (1)");
  expect(f.callees).toEqual({ resolved: [], unresolved: [] });
  const h = (await (await fetch(`${comparing.url}calls?id=${encodeURIComponent("function:src/b.ts#h")}`)).json()) as { tier: string; callees: { resolved: { label: string }[]; unresolved: { text: string }[] } };
  expect(h.tier).toBe("derived");
  expect(h.callees.resolved.map((ref) => ref.label)).toEqual(["f"]);
  expect(h.callees.unresolved.map((call) => call.text)).toEqual(["obj[name]"]);
});

test("/calls is 404 for a file and an unknown id, and works without a base", async () => {
  expect((await fetch(`${plain.url}calls?id=${encodeURIComponent("file:src/a.ts")}`)).status).toBe(404);
  expect((await fetch(`${plain.url}calls?id=nope`)).status).toBe(404);
  expect((await fetch(`${plain.url}calls?id=${encodeURIComponent("function:src/b.ts#h")}`)).status).toBe(200);
});
