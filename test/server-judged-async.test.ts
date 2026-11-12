import { afterAll, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileTree } from "../src/graph.ts";
import { JevError } from "../src/jev/client.ts";
import type { JevResponse } from "../src/jev/client.ts";
import type { JudgedDocument } from "../src/jev/judged-types.ts";
import { judgeItems } from "../src/jev/store.ts";
import type { JudgedSource } from "../src/jev/store.ts";
import { serve } from "../src/server.ts";
import { fakeClient, response, toyGate, toyThresholds } from "./jev-fixtures.ts";

const base: FileTree = new Map([
  ["package.json", "{}\n"],
  ["src/a.ts", "export function a() {\n  return 1;\n}\n"],
]);
const head: FileTree = new Map([
  ["package.json", "{}\n"],
  ["src/a.ts", "export function a() {\n  return 2;\n}\n"],
]);
const against = { ref: "main", commit: "0".repeat(40), tree: base };

const servers: { close(): Promise<void> }[] = [];
const dirs: string[] = [];
afterAll(async () => {
  for (const server of servers) await server.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const items = [0, 1, 2].map((index) => ({ key: `claim:${index}`, about: { claim: index }, input: { claim: `c${index}`, text: `c${index}` } }));
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A client whose calls stay open until the test settles them, in the order they were made. */
function controlled() {
  const open: { settle: (value: JevResponse | Error) => void }[] = [];
  const client = fakeClient(
    () =>
      new Promise<JevResponse>((resolve, reject) => {
        open.push({ settle: (value) => (value instanceof Error ? reject(value) : resolve(value)) });
      }),
  );
  return { client, open };
}

const sourceOver = (client: ReturnType<typeof fakeClient>, dir: string): JudgedSource => ({
  status: "on",
  load: async (_subject, events) => [await judgeItems({ gate: toyGate, items, thresholds: toyThresholds, client, base: "b", head: "h", cacheDir: dir, ...(events === undefined ? {} : { events }) })],
});

const started = async (source: (dir: string) => JudgedSource, dir = mkdtempSync(join(tmpdir(), "streets-async-"))) => {
  dirs.push(dir);
  const server = await serve(head, 0, against, undefined, undefined, undefined, undefined, undefined, undefined, source(dir));
  servers.push(server);
  return { server, dir };
};
const judged = async (server: { url: string }): Promise<JudgedDocument> => (await fetch(new URL("judged.json", server.url))).json() as Promise<JudgedDocument>;
const finished = async (server: { url: string }): Promise<JudgedDocument> => {
  let document = await judged(server);
  for (let tries = 0; tries < 200 && document.status === "pending"; tries++) {
    await pause(10);
    document = await judged(server);
  }
  return document;
};
const calls = async (open: unknown[], count: number): Promise<void> => {
  for (let tries = 0; tries < 200 && open.length < count; tries++) await pause(5);
};

test("the server answers the page and /judged.json (pending) before any Jev call resolves, and marks fill in as calls resolve", async () => {
  const { client, open } = controlled();
  const { server } = await started((dir) => sourceOver(client, dir));
  expect((await fetch(server.url)).status).toBe(200);
  const first = await judged(server);
  expect(first.status).toBe("pending");
  if (first.status !== "pending") return;
  expect(first.pending.map((item) => item.key)).toEqual(["claim:0", "claim:1", "claim:2"]);
  expect(first.sets[0]!.records).toEqual([]);

  await calls(open, 3);
  open[0]!.settle(response(0.97));
  await pause(30);
  const second = await judged(server);
  expect(second.status).toBe("pending");
  if (second.status !== "pending") return;
  expect(second.sets[0]!.records.map((record) => record.key)).toEqual(["claim:0"]);
  expect(second.pending.map((item) => item.key)).toEqual(["claim:1", "claim:2"]);

  // A failed call marks only its own claim.
  open[1]!.settle(new JevError("network", "the service said no"));
  open[2]!.settle(response(0.03));
  const final = await finished(server);
  expect(final.status).toBe("on");
  expect(final.sets[0]!.records.map((record) => [record.key, record.verdict])).toEqual([
    ["claim:0", "settled"],
    ["claim:2", "flagged"],
  ]);
  expect(final.notJudged).toHaveLength(1);
  expect(final.notJudged[0]).toMatchObject({ key: "claim:1", about: { claim: 1 } });
  expect(final.notJudged[0]!.reason).toContain("the service said no");
});

test("a second load of the same comparison reads the store: no call, no pending phase", async () => {
  const { client, open } = controlled();
  const { server: firstServer, dir } = await started((cache) => sourceOver(client, cache));
  await calls(open, 3);
  for (const call of open) call.settle(response(0.97));
  expect((await finished(firstServer)).status).toBe("on");
  await pause(20);

  const again = fakeClient(() => {
    throw new Error("no call expected");
  });
  const { server } = await started((cache) => sourceOver(again, cache), dir);
  const document = await judged(server);
  expect(document.status).toBe("on");
  expect(document.sets[0]!.records).toHaveLength(3);
  expect(again.requests).toHaveLength(0);
});

test("a run that throws leaves the server up and every pending check not judged with the reason", async () => {
  const { client, open } = controlled();
  let fail: (error: Error) => void = () => {};
  const failing = new Promise<never>((_, reject) => (fail = reject));
  const { server } = await started((dir) => ({
    status: "on",
    load: async (subject, events) => {
      const run = sourceOver(client, dir).load(subject, events);
      await Promise.race([run, failing]);
      return run;
    },
  }));
  await calls(open, 3);
  open[0]!.settle(response(0.97));
  await pause(30);
  expect((await judged(server)).status).toBe("pending");
  fail(new Error("the run fell over"));
  const final = await finished(server);
  expect(final).toMatchObject({ status: "on", runFailed: "judging failed: the run fell over" });
  expect(final.sets[0]!.records.map((record) => record.key)).toEqual(["claim:0"]);
  expect(final.notJudged.map((entry) => [entry.key, entry.reason])).toEqual([
    ["claim:1", "judging failed: the run fell over"],
    ["claim:2", "judging failed: the run fell over"],
  ]);
  expect((await fetch(server.url)).status).toBe(200);
});

test("a run that throws before it reads the store still ends as a finished document", async () => {
  const { server } = await started(() => ({ status: "on", load: () => Promise.reject(new Error("no store")) }));
  expect(await judged(server)).toMatchObject({ status: "on", runFailed: "judging failed: no store", notJudged: [] });
});
