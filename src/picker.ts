import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { openPullRequest, PullRequestUnavailable, systemRunners, titleLine } from "./pull-request.ts";
import type { OpenedPullRequest, Runner, Runners } from "./pull-request.ts";
import { ownHosts } from "./server.ts";
import type { Snapshot } from "./server.ts";

/** How many open pull requests the list asks gh for. */
const LIST_LIMIT = 100;
/** gh is asked about the picked PR's head at most this often, however often the page asks. */
const HEAD_TTL_MS = 30 * 1000;

export interface PickerOptions {
  /** A folder inside the user's repository. */
  readonly dir: string;
  readonly port: number;
  /** The cache directory; scratch worktrees live in <cache>/pull-requests. */
  readonly cacheDir: string;
  readonly runners?: Runners;
  /** What the page shows before a pull request is picked: the working tree, as `streets <dir>` draws it. */
  readonly plain: Snapshot;
  /** Draws an opened pull request exactly as `streets compare --pr N` does. It never runs the PR's tests. */
  readonly build: (opened: OpenedPullRequest) => Promise<Snapshot>;
  readonly headTtlMs?: number;
}

export interface RunningPicker {
  readonly url: string;
  /** Stops listening and removes the scratch worktree. */
  close(): Promise<void>;
  /** Removes every scratch worktree, synchronously, for a process that is exiting. */
  removeAllSync(): void;
}

interface Listed {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly head: string;
  readonly draft: boolean;
  readonly author: string | null;
}

const JSON_TYPE = { "content-type": "application/json; charset=utf-8" };
const text = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const stderrOf = (error: unknown): string => {
  const said = (error as { stderr?: unknown }).stderr;
  return (typeof said === "string" ? said : "").trim().split("\n")[0] ?? "";
};

/** One line saying why gh could not answer: missing, not logged in, or something else. */
function ghLine(error: unknown, what: string): string {
  if ((error as { code?: unknown }).code === "ENOENT") return "gh is not installed: install the GitHub CLI (https://cli.github.com) and run gh auth login to pick a pull request";
  const said = stderrOf(error);
  if (/gh auth login|not logged in|authentication|GH_TOKEN/i.test(said)) return "gh is not logged in: run gh auth login";
  return `gh could not ${what}: ${said || (error as Error).message.split("\n")[0]}`;
}

const isSha = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);

function parseList(out: string): Listed[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const rows: Listed[] = [];
  for (const row of parsed as Record<string, unknown>[]) {
    if (typeof row !== "object" || row === null || !Number.isSafeInteger(row.number) || (row.number as number) < 1) return undefined;
    if (typeof row.title !== "string" || typeof row.url !== "string" || !isSha(row.headRefOid)) return undefined;
    const login = (row.author as { login?: unknown } | null | undefined)?.login;
    rows.push({ number: row.number as number, title: titleLine(row.title), url: row.url, head: row.headRefOid, draft: row.isDraft === true, author: typeof login === "string" ? login : null });
  }
  return rows;
}

/**
 * Serves the local page with a list of the repository's open pull requests, read through the
 * user's own `gh`. Before one is picked it serves `plain`. `POST /pull-request?number=N` opens
 * that pull request as `compare --pr N` does and serves its comparison from then on; `?reload=1`
 * opens the current one again (a fresh fetch); each replaces the scratch worktree of the one before
 * and the old one is removed. The routes are POST with this server's own Origin and Host. It
 * listens on 127.0.0.1 only, on the one port the plain page would have.
 *
 * `GET /pull-requests.json` is `{status: "ok", prs, truncated, current}` or, when gh cannot answer,
 * `{status: "unavailable", why}` with no list: an unknown list is never an empty one.
 * `GET /pull-request-head.json` asks gh whether the current PR's head moved: `moved` is null when
 * gh could not say. gh is asked at most once per window.
 */
export async function servePicker(options: PickerOptions): Promise<RunningPicker> {
  const runners = options.runners ?? systemRunners;
  const gh: Runner = runners.gh;
  const ttl = options.headTtlMs ?? HEAD_TTL_MS;
  let active: Snapshot = options.plain;
  let current: { readonly opened: OpenedPullRequest } | undefined;
  let picking = false;
  /** Every scratch worktree's synchronous remover, from before it exists until the end. */
  const removers = new Set<() => void>();
  let headAnswer: { readonly at: number; readonly asked: Promise<Record<string, unknown>> } | undefined;

  const top = async (): Promise<string> => {
    try {
      return (await runners.git(["rev-parse", "--show-toplevel"], options.dir)).trim();
    } catch {
      throw new PullRequestUnavailable(`${options.dir} is not a git repository: run streets inside the repository whose pull requests you want to pick from`);
    }
  };

  async function listing(): Promise<Record<string, unknown>> {
    try {
      const where = await top();
      const out = await gh(["pr", "list", "--state", "open", "--limit", String(LIST_LIMIT), "--json", "number,title,url,headRefOid,isDraft,author"], where);
      const prs = parseList(out);
      if (prs === undefined) return { tier: "claimed", status: "unavailable", why: "gh gave a pull request list that is not readable: nothing is shown" };
      const head = current === undefined ? null : { number: current.opened.pr.number, head: current.opened.pr.head };
      return { tier: "claimed", status: "ok", prs, truncated: prs.length >= LIST_LIMIT, current: head };
    } catch (error) {
      if (error instanceof PullRequestUnavailable) return { tier: "claimed", status: "unavailable", why: error.message };
      return { tier: "claimed", status: "unavailable", why: ghLine(error, "list pull requests") };
    }
  }

  async function askHead(opened: OpenedPullRequest): Promise<Record<string, unknown>> {
    const base = { tier: "claimed", number: opened.pr.number, head: opened.pr.head };
    try {
      const out = await gh(["pr", "view", String(opened.pr.number), "--json", "headRefOid"], await top());
      const latest = (JSON.parse(out) as { headRefOid?: unknown }).headRefOid;
      if (!isSha(latest)) return { ...base, latest: null, moved: null, why: `gh gave pull request #${opened.pr.number} no head commit` };
      return { ...base, latest, moved: latest !== opened.pr.head };
    } catch (error) {
      return { ...base, latest: null, moved: null, why: ghLine(error, `check pull request #${opened.pr.number}`) };
    }
  }

  const headOf = (opened: OpenedPullRequest): Promise<Record<string, unknown>> => {
    const now = Date.now();
    if (headAnswer === undefined || now - headAnswer.at >= ttl) headAnswer = { at: now, asked: askHead(opened) };
    return headAnswer.asked;
  };

  async function pick(number: number): Promise<{ status: number; body: Record<string, unknown> }> {
    if (picking) return { status: 409, body: { ok: false, why: "another pick is still running: wait for it" } };
    picking = true;
    let opened: OpenedPullRequest | undefined;
    try {
      opened = await openPullRequest({ number, cwd: options.dir, cacheDir: options.cacheDir, runners, register: (removeSync) => removers.add(removeSync) });
      const snapshot = await options.build(opened);
      const previous = current;
      active = snapshot;
      current = { opened };
      headAnswer = undefined;
      snapshot.begin();
      if (previous !== undefined) await previous.opened.remove();
      return { status: 200, body: { ok: true, number, head: opened.pr.head, ...(opened.note === undefined ? {} : { note: opened.note }) } };
    } catch (error) {
      if (opened !== undefined && current?.opened !== opened) await opened.remove();
      const why = error instanceof PullRequestUnavailable ? error.message : `pull request #${number} could not be drawn: ${(error as Error).message.split("\n")[0]}`;
      return { status: 502, body: { ok: false, why } };
    } finally {
      picking = false;
    }
  }

  const send = (response: ServerResponse, status: number, body: unknown): void => void response.writeHead(status, JSON_TYPE).end(text(body));

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const port = (server.address() as AddressInfo).port;
    const hosts = ownHosts(port);
    const url = new URL(request.url ?? "/", "http://localhost");
    const mine = url.pathname === "/pull-requests.json" || url.pathname === "/pull-request-head.json" || url.pathname === "/pull-request";
    if (!mine) {
      active.handle(request, response, port);
      return;
    }
    if (!hosts.has(request.headers.host ?? "")) {
      response.writeHead(403).end();
      return;
    }
    if (url.pathname === "/pull-requests.json") {
      void listing().then((body) => send(response, 200, body));
      return;
    }
    if (url.pathname === "/pull-request-head.json") {
      if (current === undefined) response.writeHead(404).end();
      else void headOf(current.opened).then((body) => send(response, 200, body));
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "POST" }).end();
      return;
    }
    const origin = request.headers.origin ?? "";
    if (!origin.startsWith("http://") || !hosts.has(origin.slice("http://".length))) {
      response.writeHead(403).end();
      return;
    }
    const asked = url.searchParams.get("number");
    let number: number | undefined;
    if (url.searchParams.get("reload") === "1") {
      if (current === undefined) return void send(response, 409, { ok: false, why: "no pull request is picked: pick one first" });
      number = current.opened.pr.number;
    } else if (asked !== null && /^[1-9]\d{0,8}$/.test(asked)) number = Number(asked);
    if (number === undefined) return void send(response, 400, { ok: false, why: "name a pull request number, or reload=1" });
    void pick(number).then((answer) => send(response, answer.status, answer.body));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", resolve);
  });
  options.plain.begin();
  const removeAllSync = (): void => {
    for (const remove of removers) remove();
  };
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    removeAllSync,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => {
          removeAllSync();
          if (error) reject(error);
          else resolve();
        }),
      ),
  };
}
