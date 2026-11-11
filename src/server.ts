import { readdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { Base } from "./checkout.ts";
import { compare, contractsMoved, serializeComparison } from "./compare.ts";
import type { Comparison } from "./compare.ts";
import { extract } from "./extract/extract.ts";
import { canonicalEdge, isCodeNode, serializeGraph } from "./graph.ts";
import type { FileTree, Graph, ModuleNode, NodeId } from "./graph.ts";
import { changeCounts, diffText, rowsInRange } from "./diff.ts";
import type { LineOp } from "./diff.ts";
import { isBinary, sliceLines } from "./lines.ts";
import { waysIn } from "./ways-in.ts";
import { isStale } from "./narration.ts";
import type { NarratedDoc, Narration } from "./narration.ts";
import { pseudocode } from "./pseudocode.ts";
import { splitClaims } from "./claims.ts";
import type { Claim } from "./claims.ts";
import type { Asked, LinkOutcome } from "./link.ts";
import { observedDocument, treeDigest } from "./observed.ts";
import type { TestRun } from "./observed.ts";
import { testChanges } from "./test-changes.ts";
import { risksOf } from "./risks.ts";
import { isTestFile } from "./test-files.ts";
import type { TourOutcome } from "./walkthrough.ts";
import type { NarrateRequest } from "./narrate.ts";

/** Writes a function's narration; the seam the command line fills with the agent and tests fake. */
export type Narrator = (request: Pick<NarrateRequest, "node" | "outline" | "renarrate">) => Promise<Asked<Narration>>;

/** The most contract-moved functions narrated ahead of time: each is a model call. The rest wait for a request. */
export const AHEAD_LIMIT = 30;
const AHEAD_PARALLEL = 3;

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
 * `GET /pseudocode?id=` answers with one function's outline as a derived fact: its control
 * structure through a fixed template, each line with its source line range, computed from the
 * same snapshot on request and never stored (404 for anything but a function; a removed one is
 * outlined from the base tree). The page's source panel and the walkthrough's Code column read it.
 *
 * Given `base`, it also serves `GET /comparison.json`, `GET /contracts.json`, `GET /test-changes.json`, `GET /risks.json` (the ranked risks, derived: see src/risks.ts)
 * and `GET /claims.json` (404 otherwise). The test changes are what the change did to the tests,
 * derived from the two trees' text alone: deleted files, removed names, skips, weakened tests. The contracts are the comparison's contract moves as a derived fact, kept in
 * their own resource so `/comparison.json` stays the plain diff of the two graphs. A
 * module the comparison lists as removed has its source read from the base tree, not the head.
 * `GET /changes?id=` is what changed in the lines `/source` serves for that module, as rows of
 * added, removed and unchanged lines from a line diff of the base and head files (derived). It is
 * 404 without a base, for folders, removed and moved modules, and when nothing there changed.
 * The claims are the person's `description` as a claimed fact, kept apart from the graph and the
 * comparison; `description` is null in them when none was given. The description is split into
 * claims by rules, and `link`, when given, is asked once for the agent's links from each claim to
 * the modules it describes; they are served beside the claims as claimed facts, and a failure is
 * served as a failure with no links. `GET /walkthrough.json` is the tour `walk` returns, asked once
 * and at the same time as the links: claimed too, in its own resource, with no stops when it
 * failed or was not asked for.
 *
 * Given `tests`, one run of the tree's tests, it also serves `GET /observed.json`: the run as an
 * observed fact attached to the graph's test functions by id and keyed by the tree's digest, kept
 * apart from the graph and the comparison.

 * Given `tests`, one run of the tree's tests, it also serves `GET /observed.json`: the run as an
 * observed fact attached to the graph's test functions by id and keyed by the tree's digest, kept
 * apart from the graph and the comparison.
 *
 * Given `narrator` (and so `base`), narration is on offer: `GET /narrate.json` lists the
 * functions of "contracts moved" being narrated ahead of time, in the background after the server
 * is up, and `POST /narration?id=` answers with one function's narration as a claimed fact,
 * `stale` when the function's digest is no longer the narrated one (`&fresh=1` writes it again).
 * It is a POST because it spends a model call; every request must name the server's own address as Host, and this one also as Origin, or it is refused with 403. The agent
 * is shown the function's structure only (see narrationPrompt). Without `narrator` both are 404.
 */
export async function serve(
  given: FileTree,
  port: number,
  base?: Against,
  description?: string,
  link?: (comparison: Comparison, claims: readonly Claim[], graph: Graph) => Promise<LinkOutcome>,
  walk?: (comparison: Comparison, claims: readonly Claim[], graph: Graph) => Promise<TourOutcome>,
  narrator?: Narrator,
  tests?: TestRun,
): Promise<RunningServer> {
  const tree: FileTree = new Map(given);
  const graph = extract(tree);
  const baseTree = base === undefined ? undefined : new Map(base.tree);
  const baseGraph = baseTree === undefined ? undefined : extract(baseTree);
  const comparison = baseGraph === undefined || baseTree === undefined ? undefined : compare(baseGraph, graph, { base: baseTree, head: tree });
  const removed = new Map<NodeId, ModuleNode>();
  for (const change of comparison?.changes ?? []) {
    if (change.kind === "removed") removed.set(change.node.id, change.node);
  }
  const nodes = new Map<NodeId, ModuleNode>(graph.nodes.map((node) => [node.id, node]));
  // A function that moved away leaves a ghost in a removed file under its old id, which the head does not have: its source is the base's.
  for (const change of comparison?.changes ?? []) {
    if (change.kind === "moved" && !nodes.has(change.from.id)) removed.set(change.from.id, change.from);
  }
  const [html, script] = await Promise.all([
    readFile(new URL("page/index.html", import.meta.url), "utf8"),
    bundlePage(),
  ]);
  const sprites = await readSprites();
  const resources = new Map<string, Resource>([
    ["/", { contentType: "text/html; charset=utf-8", body: html }],
    ["/main.js", { contentType: "text/javascript; charset=utf-8", body: script }],
    ["/graph.json", { contentType: "application/json; charset=utf-8", body: serializeGraph(graph) }],
    ["/ways-in.json", { contentType: "application/json; charset=utf-8", body: `${JSON.stringify({ tier: "derived", waysIn: waysIn(tree, graph) }, null, 2)}\n` }],
  ]);
  if (base !== undefined && baseGraph !== undefined && comparison !== undefined) {
    const body = `${JSON.stringify({ ...JSON.parse(serializeComparison(comparison)), against: { ref: base.ref, commit: base.commit } }, null, 2)}\n`;
    resources.set("/comparison.json", { contentType: "application/json; charset=utf-8", body });
    // The base's outside calls in files the change removed, so a ghost's inside has its objects. Derived from the base graph alone.
    const removedPaths = new Set(comparison.changes.flatMap((change) => (change.kind === "removed" && change.node.level === "file" ? [change.node.path] : [])));
    const baseOwners = new Map<NodeId, ModuleNode>(baseGraph.nodes.map((node) => [node.id, node]));
    const ghostEdges = baseGraph.edges.filter((edge) => removedPaths.has(baseOwners.get(edge.from)?.path ?? ""));
    resources.set("/ghost-edges.json", { contentType: "application/json; charset=utf-8", body: `${JSON.stringify({ tier: "derived", edges: ghostEdges.map(canonicalEdge) }, null, 2)}\n` });
    const claims = splitClaims(description ?? "");
    const [outcome, tour] = await Promise.all([
      link === undefined || claims.length === 0 ? ({ status: "off" } satisfies LinkOutcome) : link(comparison, claims, graph),
      walk === undefined ? ({ status: "off" } satisfies TourOutcome) : walk(comparison, claims, graph),
    ]);
    const { stops, ...made } = tour.status === "ok" ? tour : { stops: [], ...tour };
    const walkthrough = `${JSON.stringify({ tier: "claimed", walkthrough: made, stops }, null, 2)}\n`;
    resources.set("/walkthrough.json", { contentType: "application/json; charset=utf-8", body: walkthrough });
    const { status, ...rest } = outcome;
    const how =
      outcome.status === "ok"
        ? { status, model: outcome.model, promptVersion: outcome.promptVersion, dropped: outcome.dropped, cached: outcome.cached }
        : { status, ...rest };
    const document = {
      tier: "claimed",
      description: description ?? null,
      claims:
        outcome.status === "ok"
          ? outcome.shown.map((row, index) => ({ index, text: row.text, restated: row.restated, sources: row.sources.map((source) => claims[source]!), ids: row.ids }))
          : claims.map((claim, index) => ({ index, text: claim.text, restated: false, sources: [claim], ids: [] })),
      sentences: claims,
      context: outcome.status === "ok" ? outcome.context.map((source) => claims[source]!) : [],
      link: how,
    };
    resources.set("/claims.json", { contentType: "application/json; charset=utf-8", body: `${JSON.stringify(document, null, 2)}\n` });
    const contracts = `${JSON.stringify({ tier: "derived", moves: contractsMoved(comparison, baseGraph, graph), effectsChanged: comparison.changedEffects }, null, 2)}\n`;
    resources.set("/contracts.json", { contentType: "application/json; charset=utf-8", body: contracts });
    const testsChanged = `${JSON.stringify({ tier: "derived", ...testChanges(baseTree ?? new Map(), tree, { places: true }) }, null, 2)}\n`;
    resources.set("/test-changes.json", { contentType: "application/json; charset=utf-8", body: testsChanged });
    const risks = `${JSON.stringify({ tier: "derived", risks: risksOf(comparison, baseGraph, graph, testChanges(baseTree ?? new Map(), tree), isTestFile) }, null, 2)}\n`;
    resources.set("/risks.json", { contentType: "application/json; charset=utf-8", body: risks });
  }

  const narrations = new Map<NodeId, Promise<NarratedDoc>>();
  const aheadIds: NodeId[] = [];
  if (narrator !== undefined && comparison !== undefined && baseGraph !== undefined) {
    const all = [...new Set(contractsMoved(comparison, baseGraph, graph).filter((move) => move.kind !== "removed").map((move) => move.id))].filter((id) => {
      const node = nodes.get(id);
      return node !== undefined && isCodeNode(node) && node.level === "function";
    });
    aheadIds.push(...all.slice(0, AHEAD_LIMIT));
    const skipped = all.length - aheadIds.length;
    const body = `${JSON.stringify({ tier: "claimed", ahead: aheadIds, skipped }, null, 2)}\n`;
    resources.set("/narrate.json", { contentType: "application/json; charset=utf-8", body });
  }

  function narrationOf(id: NodeId, fresh: boolean, refresh = false): Promise<NarratedDoc> | undefined {
    const node = nodes.get(id);
    if (narrator === undefined || node === undefined || !isCodeNode(node) || node.level !== "function") return undefined;
    const known = fresh ? undefined : narrations.get(id);
    if (known !== undefined) return known;
    const outline = pseudocode(graph, tree, id) ?? [];
    const asked = (renarrate: boolean): Promise<Asked<Narration>> => narrator({ node, outline, renarrate });
    const made = (async (): Promise<NarratedDoc> => {
      let outcome = await asked(fresh);
      // Ahead of time a stale cache entry is written again: nobody asked to see the old one.
      if (refresh && outcome.status === "ok" && isStale(outcome, node)) outcome = await asked(true);
      if (outcome.status === "failed") return { tier: "claimed", id, ...outcome };
      const { status, digest, ...rest } = outcome;
      return { tier: "claimed", id, status, narrated: digest, stale: isStale(outcome, node), ...rest };
    })();
    narrations.set(id, made);
    // A failure is not kept, so asking again tries again.
    void made.then((doc) => {
      if (doc.status === "failed" && narrations.get(id) === made) narrations.delete(id);
    });
    return made;
  }

  const queue = [...aheadIds];
  for (let worker = 0; worker < AHEAD_PARALLEL; worker++) {
    void (async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) await narrationOf(id, false, true);
    })();
  }

  if (tests !== undefined) {
    const body = `${JSON.stringify(observedDocument(tests, graph, treeDigest(tree)), null, 2)}\n`;
    resources.set("/observed.json", { contentType: "application/json; charset=utf-8", body });
  }

  function sourceOf(id: string | null): string | undefined {
    const ghost = id === null ? undefined : removed.get(id as NodeId);
    const node = ghost ?? (id === null ? undefined : nodes.get(id as NodeId));
    if (node === undefined) return undefined;
    const from = ghost === undefined ? tree : baseTree;
    const text = node.level === "package" || node.level === "folder" ? undefined : from?.get(node.path);
    if (text === undefined) return undefined;
    if (isBinary(text)) return "binary file";
    return isCodeNode(node) ? sliceLines(text, node.range) : text;
  }

  const opsByPath = new Map<string, LineOp[] | undefined>();
  const baseNodes = new Map<NodeId, ModuleNode>((baseGraph?.nodes ?? []).map((node) => [node.id, node]));
  const kindOf = new Map<NodeId, string>((comparison?.changes ?? []).map((change) => [change.node.id, change.kind]));

  /** What changed in the lines `sourceOf` serves: undefined without a base, and when nothing there changed. */
  function changesOf(id: string | null): string | undefined {
    const node = id === null ? undefined : nodes.get(id as NodeId);
    if (node === undefined || baseTree === undefined) return undefined;
    if (node.level === "package" || node.level === "folder" || kindOf.get(node.id) === "moved") return undefined;
    const text = tree.get(node.path);
    if (text === undefined || isBinary(text) || isBinary(baseTree.get(node.path) ?? "")) return undefined;
    if (!opsByPath.has(node.path)) {
      try {
        opsByPath.set(node.path, diffText(baseTree.get(node.path) ?? "", text));
      } catch {
        // Whatever goes wrong inside a diff, the page is told it is too large and the server stays up.
        opsByPath.set(node.path, undefined);
      }
    }
    const ops = opsByPath.get(node.path);
    if (ops === undefined) return `${JSON.stringify({ tier: "derived", id, tooLarge: true, added: 0, removed: 0, rows: [] }, null, 2)}\n`;
    const before = baseNodes.get(node.id);
    const baseRange = !isCodeNode(node) ? undefined : before !== undefined && isCodeNode(before) ? before.range : null;
    const rows = rowsInRange(ops, isCodeNode(node) ? node.range : undefined, baseRange);
    const counts = changeCounts(rows);
    if (counts.added + counts.removed === 0) return undefined;
    return `${JSON.stringify({ tier: "derived", id, ...counts, rows }, null, 2)}\n`;
  }

  function pseudocodeOf(id: string | null): string | undefined {
    if (id === null) return undefined;
    const ghost = removed.has(id as NodeId);
    const lines = ghost
      ? baseGraph === undefined || baseTree === undefined ? undefined : pseudocode(baseGraph, baseTree, id as NodeId)
      : pseudocode(graph, tree, id as NodeId);
    return lines === undefined ? undefined : `${JSON.stringify({ tier: "derived", id, lines }, null, 2)}\n`;
  }

  const server = createServer((request, response) => {
    // A rebound DNS name reaches this server with a Host and Origin of its own choosing, so both
    // are checked against the address this server listens on, never against each other.
    const hosts = ownHosts((server.address() as AddressInfo).port);
    if (!hosts.has(request.headers.host ?? "")) {
      response.writeHead(403).end();
      return;
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/narration") {
      if (narrator === undefined) response.writeHead(404).end();
      else if (request.method !== "POST") response.writeHead(405, { allow: "POST" }).end();
      else if (!hosts.has(request.headers.origin?.replace(/^http:\/\//, "") ?? "") || !request.headers.origin?.startsWith("http://")) response.writeHead(403).end();
      else {
        const asked = narrationOf((url.searchParams.get("id") ?? "") as NodeId, url.searchParams.get("fresh") === "1");
        if (asked === undefined) response.writeHead(404).end();
        else void asked.then((doc) => response.writeHead(200, { "content-type": "application/json; charset=utf-8" }).end(`${JSON.stringify(doc, null, 2)}\n`));
      }
      return;
    }
    if (url.pathname === "/pseudocode") {
      const body = pseudocodeOf(url.searchParams.get("id"));
      if (body === undefined) response.writeHead(404).end();
      else response.writeHead(200, { "content-type": "application/json; charset=utf-8" }).end(body);
      return;
    }
    if (url.pathname === "/changes") {
      const body = changesOf(url.searchParams.get("id"));
      if (body === undefined) response.writeHead(404).end();
      else response.writeHead(200, { "content-type": "application/json; charset=utf-8" }).end(body);
      return;
    }
    if (url.pathname === "/source") {
      const text = sourceOf(url.searchParams.get("id"));
      if (text === undefined) response.writeHead(404).end();
      else response.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(text);
      return;
    }
    if (url.pathname.startsWith("/town/")) {
      const sprite = sprites.get(url.pathname.slice("/town/".length));
      if (sprite === undefined) response.writeHead(404).end();
      else response.writeHead(200, { "content-type": sprite.contentType }).end(sprite.body);
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

/**
 * The town theme's sprite sheet, as `/town/<file>`: `sprites.json` and one PNG per sprite. Only
 * files that sit in the sheet's folder when the server starts can be asked for.
 */
async function readSprites(): Promise<Map<string, { contentType: string; body: Buffer }>> {
  const folder = new URL("../themes/town/sprites/", import.meta.url);
  const found = new Map<string, { contentType: string; body: Buffer }>();
  for (const name of await readdir(folder)) {
    const contentType = name.endsWith(".png") ? "image/png" : name === "sprites.json" ? "application/json; charset=utf-8" : undefined;
    if (contentType !== undefined) found.set(name, { contentType, body: await readFile(new URL(name, folder)) });
  }
  return found;
}

/** The hosts a request to this server may name: its own address, by number or as localhost. */
function ownHosts(port: number): ReadonlySet<string> {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
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
