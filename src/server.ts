import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { Base } from "./checkout.ts";
import { compare, serializeComparison } from "./compare.ts";
import type { Comparison } from "./compare.ts";
import { extract } from "./extract/extract.ts";
import { isCodeNode, serializeGraph } from "./graph.ts";
import type { FileTree, ModuleNode, NodeId } from "./graph.ts";
import { sliceLines } from "./lines.ts";
import { splitClaims } from "./claims.ts";
import type { Claim } from "./claims.ts";
import type { LinkOutcome } from "./link.ts";

/** What the checkout is compared against: the merge base's tree and commit, and the ref the user wrote. */
export interface Against extends Base {
  readonly ref: string;
}

export interface RunningServer {
  readonly url: string;
  /** Present when comparing. */
  readonly comparison: Comparison | undefined;
  close(): Promise<void>;
}

interface Resource {
  readonly contentType: string;
  readonly body: string;
}

/**
 * Serves one snapshot: the page, its script, the graph extracted from `tree`, and `GET /source?id=`,
 * which answers with exactly the lines of the node with that id from the same snapshot. Packages,
 * folders and unknown ids have no source and get 404.
 *
 * Given `base`, it also serves `GET /comparison.json` and `GET /claims.json` (404 otherwise), and a
 * module the comparison lists as removed has its source read from the base tree, not the head.
 * The claims are the person's `description` as a claimed fact, kept apart from the graph and the
 * comparison; `description` is null in them when none was given. The description is split into
 * claims by rules, and `link`, when given, is asked once for the agent's links from each claim to
 * the modules it describes; they are served beside the claims as claimed facts, and a failure is
 * served as a failure with no links.
 */
export async function serve(
  given: FileTree,
  port: number,
  base?: Against,
  description?: string,
  link?: (comparison: Comparison, claims: readonly Claim[]) => Promise<LinkOutcome>,
): Promise<RunningServer> {
  const tree: FileTree = new Map(given);
  const graph = extract(tree);
  const baseTree = base === undefined ? undefined : new Map(base.tree);
  const baseGraph = baseTree === undefined ? undefined : extract(baseTree);
  const comparison = baseGraph === undefined ? undefined : compare(baseGraph, graph);
  const removed = new Map<NodeId, ModuleNode>();
  for (const change of comparison?.changes ?? []) {
    if (change.kind === "removed") removed.set(change.node.id, change.node);
  }
  const nodes = new Map<NodeId, ModuleNode>(graph.nodes.map((node) => [node.id, node]));
  const [html, script] = await Promise.all([
    readFile(new URL("page/index.html", import.meta.url), "utf8"),
    bundlePage(),
  ]);
  const resources = new Map<string, Resource>([
    ["/", { contentType: "text/html; charset=utf-8", body: html }],
    ["/main.js", { contentType: "text/javascript; charset=utf-8", body: script }],
    ["/graph.json", { contentType: "application/json; charset=utf-8", body: serializeGraph(graph) }],
  ]);
  if (base !== undefined && comparison !== undefined) {
    const body = `${JSON.stringify({ ...JSON.parse(serializeComparison(comparison)), against: { ref: base.ref, commit: base.commit } }, null, 2)}\n`;
    resources.set("/comparison.json", { contentType: "application/json; charset=utf-8", body });
    const claims = splitClaims(description ?? "");
    const outcome: LinkOutcome = link === undefined || claims.length === 0 ? { status: "off" } : await link(comparison, claims);
    const { status, ...rest } = outcome;
    const how =
      outcome.status === "ok"
        ? { status, model: outcome.model, promptVersion: outcome.promptVersion, dropped: outcome.dropped, cached: outcome.cached }
        : { status, ...rest };
    const document = {
      tier: "claimed",
      description: description ?? null,
      claims: claims.map((claim, index) => ({ ...claim, ids: outcome.status === "ok" ? (outcome.byClaim[index] ?? []) : [] })),
      link: how,
    };
    resources.set("/claims.json", { contentType: "application/json; charset=utf-8", body: `${JSON.stringify(document, null, 2)}\n` });
  }

  function sourceOf(id: string | null): string | undefined {
    const ghost = id === null ? undefined : removed.get(id as NodeId);
    const node = ghost ?? (id === null ? undefined : nodes.get(id as NodeId));
    if (node === undefined) return undefined;
    const from = ghost === undefined ? tree : baseTree;
    const text = node.level === "package" || node.level === "folder" ? undefined : from?.get(node.path);
    if (text === undefined) return undefined;
    return isCodeNode(node) ? sliceLines(text, node.range) : text;
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/source") {
      const text = sourceOf(url.searchParams.get("id"));
      if (text === undefined) response.writeHead(404).end();
      else response.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(text);
      return;
    }
    const resource = resources.get(url.pathname);
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
    comparison,
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
