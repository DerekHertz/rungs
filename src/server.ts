import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { serializeGraph } from "./graph.ts";
import type { Graph } from "./graph.ts";

export interface RunningServer {
  readonly url: string;
  close(): Promise<void>;
}

interface Resource {
  readonly contentType: string;
  readonly body: string;
}

export async function serveGraph(graph: Graph, port: number): Promise<RunningServer> {
  const [html, script] = await Promise.all([
    readFile(new URL("page/index.html", import.meta.url), "utf8"),
    bundlePage(),
  ]);
  const resources: ReadonlyMap<string, Resource> = new Map([
    ["/", { contentType: "text/html; charset=utf-8", body: html }],
    ["/main.js", { contentType: "text/javascript; charset=utf-8", body: script }],
    ["/graph.json", { contentType: "application/json; charset=utf-8", body: serializeGraph(graph) }],
  ]);

  const server = createServer((request, response) => {
    const resource = resources.get(new URL(request.url ?? "/", "http://localhost").pathname);
    if (resource === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": resource.contentType }).end(resource.body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () =>
      new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function bundlePage(): Promise<string> {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("page/main.ts", import.meta.url))],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    logLevel: "silent",
  });
  const [output] = result.outputFiles;
  if (output === undefined) throw new Error("esbuild produced no page bundle");
  return output.text;
}
