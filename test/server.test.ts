import { afterAll, expect, test } from "vitest";
import { extract } from "../src/extract/extract.ts";
import { serveGraph } from "../src/server.ts";

const graph = extract(new Map([["package.json", "{}\n"], ["src/index.ts", "export {};\n"]]));
const server = await serveGraph(graph, 0);
afterAll(() => server.close());

test("serves the page, its script and the graph", async () => {
  const page = await fetch(server.url);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain('src="/main.js"');

  const script = await fetch(new URL("main.js", server.url));
  expect(script.status).toBe(200);
  expect(script.headers.get("content-type")).toMatch(/^text\/javascript/);

  const served = await fetch(new URL("graph.json", server.url));
  expect(served.status).toBe(200);
  expect(await served.json()).toEqual(JSON.parse(JSON.stringify(graph)));
});

test("answers 404 for anything else", async () => {
  expect((await fetch(new URL("missing", server.url))).status).toBe(404);
});
