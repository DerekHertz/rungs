import { afterAll, expect, test } from "vitest";
import type { FileTree } from "../src/graph.ts";
import { serve } from "../src/server.ts";
import type { Narrator } from "../src/server.ts";

const base: FileTree = new Map([
  ["package.json", "{}\n"],
  [
    "src/a.ts",
    "export function moved(a: number) {\n  return a;\n}\n\nexport function same(a: number) {\n  return a;\n}\n\nfunction quiet() {\n  return 1;\n}\n\nexport function gone() {\n  return 2;\n}\n",
  ],
]);
const head: FileTree = new Map([
  ["package.json", "{}\n"],
  [
    "src/a.ts",
    "export function moved(a: number, b: number) {\n  return a + b;\n}\n\nexport function same(a: number) {\n  return a;\n}\n\nfunction quiet() {\n  return 2;\n}\n\nexport function added() {\n  if (SECRET) return 1;\n  return 3;\n}\n",
  ],
]);
const against = { ref: "main", commit: "0".repeat(40), tree: base };

interface Call {
  id: string;
  rows: number;
  renarrate: boolean;
}
function fake(over: (call: Call) => Record<string, unknown> = () => ({})): { narrator: Narrator; calls: Call[] } {
  const calls: Call[] = [];
  const narrator: Narrator = async ({ node, outline, renarrate }) => {
    const call = { id: node.id, rows: outline.length, renarrate };
    calls.push(call);
    const changed = over(call);
    if (changed.fail === true) return { status: "failed", message: "claude CLI not found (claude)" };
    return {
      status: "ok",
      digest: (changed.digest as string | undefined) ?? node.digest,
      sentences: [{ text: `Narrates ${node.qualifiedName}.`, from: 0, to: 0, range: outline[0]?.range ?? node.range }],
      dropped: { sentences: 2 },
      model: "fake",
      promptVersion: "narration-v1",
      cached: false,
    };
  };
  return { narrator, calls };
}

const servers: { close(): Promise<void> }[] = [];
async function start(narrator?: Narrator, compared = true) {
  const server = await serve(head, 0, compared ? against : undefined, undefined, undefined, undefined, narrator);
  servers.push(server);
  return server;
}
afterAll(async () => {
  for (const server of servers) await server.close();
});

const post = (server: { url: string }, id: string, query = "", init: RequestInit = {}) =>
  fetch(new URL(`narration?id=${encodeURIComponent(id)}${query}`, server.url), { method: "POST", ...init });
const idOf = (name: string): string => `function:src/a.ts#${name}`;

test("without a narrator there is no narration on offer: the list and the endpoint are 404", async () => {
  const server = await start();
  expect((await fetch(new URL("narrate.json", server.url))).status).toBe(404);
  expect((await post(server, idOf("moved"))).status).toBe(404);
});

test("under a comparison the functions in contracts moved are narrated ahead of time, and no others", async () => {
  const { narrator, calls } = fake();
  const server = await start(narrator);
  const list = (await (await fetch(new URL("narrate.json", server.url))).json()) as { tier: string; ahead: string[]; skipped: number };
  expect(list).toEqual({ tier: "claimed", ahead: [idOf("added"), idOf("moved")].sort(), skipped: 0 });
  for (const id of list.ahead) await post(server, id);
  expect(calls.map((call) => call.id).sort()).toEqual([idOf("added"), idOf("moved")]);
});

test("a request for a function narrated ahead of time shares that one call and answers a claimed fact", async () => {
  const { narrator, calls } = fake();
  const server = await start(narrator);
  const [one, two] = await Promise.all([post(server, idOf("moved")), post(server, idOf("moved"))]);
  expect(one.headers.get("content-type")).toMatch(/^application\/json/);
  const body = await one.json();
  expect(body).toEqual({
    tier: "claimed",
    id: idOf("moved"),
    status: "ok",
    narrated: expect.stringMatching(/^[0-9a-f]{32}$/),
    stale: false,
    sentences: [{ text: "Narrates moved.", from: 0, to: 0, range: { start: 2, end: 2 } }],
    dropped: { sentences: 2 },
    model: "fake",
    promptVersion: "narration-v1",
    cached: false,
  });
  expect(await two.json()).toEqual(body);
  expect(calls.filter((call) => call.id === idOf("moved"))).toHaveLength(1);
});

test("a function outside contracts moved is narrated on request only, and its narration is stale when the digest narrated differs", async () => {
  const { narrator, calls } = fake((call) => (call.renarrate ? {} : { digest: "0".repeat(32) }));
  const server = await start(narrator);
  expect(calls.map((call) => call.id)).not.toContain(idOf("quiet"));
  const stale = (await (await post(server, idOf("quiet"))).json()) as { stale: boolean; narrated: string };
  expect(stale).toMatchObject({ status: "ok", stale: true, narrated: "0".repeat(32) });
  const fresh = (await (await post(server, idOf("quiet"), "&fresh=1")).json()) as { stale: boolean };
  expect(fresh.stale).toBe(false);
  expect(calls.filter((call) => call.id === idOf("quiet")).map((call) => call.renarrate)).toEqual([false, true]);
});

test("ahead of time, a narration that is already stale is written again", async () => {
  const { narrator, calls } = fake((call) => (call.renarrate ? {} : { digest: "1".repeat(32) }));
  const server = await start(narrator);
  const body = (await (await post(server, idOf("moved"))).json()) as { stale: boolean };
  expect(body.stale).toBe(false);
  expect(calls.filter((call) => call.id === idOf("moved")).map((call) => call.renarrate)).toEqual([false, true]);
});

test("only a function of the head is narrated: not a file, a removed function or an unknown id", async () => {
  const { narrator, calls } = fake();
  const server = await start(narrator);
  for (const id of ["file:src/a.ts", idOf("gone"), idOf("nothing"), ""]) expect((await post(server, id)).status).toBe(404);
  expect(calls.map((call) => call.id)).not.toContain(idOf("gone"));
});

test("a GET is refused and a POST from another origin spends no call", async () => {
  const { narrator, calls } = fake();
  const server = await start(narrator);
  await post(server, idOf("same"));
  const before = calls.length;
  expect((await fetch(new URL(`narration?id=${encodeURIComponent(idOf("quiet"))}`, server.url))).status).toBe(405);
  expect((await post(server, idOf("quiet"), "", { headers: { origin: "http://evil.example" } })).status).toBe(403);
  expect(calls).toHaveLength(before);
  expect((await post(server, idOf("quiet"), "", { headers: { origin: new URL(server.url).origin } })).status).toBe(200);
});

test("a failure is served as a failure and tried again on the next request", async () => {
  let failing = true;
  const { narrator, calls } = fake(() => (failing ? { fail: true } : {}));
  const server = await start(narrator);
  expect(await (await post(server, idOf("quiet"))).json()).toEqual({ tier: "claimed", id: idOf("quiet"), status: "failed", message: "claude CLI not found (claude)" });
  failing = false;
  expect(await (await post(server, idOf("quiet"))).json()).toMatchObject({ status: "ok" });
  expect(calls.filter((call) => call.id === idOf("quiet"))).toHaveLength(2);
});
