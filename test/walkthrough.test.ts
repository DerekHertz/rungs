import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { splitClaims } from "../src/claims.ts";
import { compare } from "../src/compare.ts";
import { extract } from "../src/extract/extract.ts";
import type { FileTree } from "../src/graph.ts";
import type { AgentRunner } from "../src/link.ts";
import { TOUR_PROMPT_VERSION, placesOf, tourPrompt, validateTour } from "../src/tour.ts";
import { walkthrough } from "../src/walkthrough.ts";

const scratch: string[] = [];
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "streets-tour-"));
  scratch.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const tree = (files: Record<string, string>): FileTree => new Map(Object.entries(files));
const imports = 'import { execFileSync } from "node:child_process";\n';
const baseGraph = extract(
  tree({
    "package.json": "{}\n",
    "src/a.ts": "export function alpha(n: number) {\n  return n;\n}\n",
    "src/gone.ts": "export function old() {\n  return 1;\n}\n",
  }),
);
const headGraph = extract(
  tree({
    "package.json": "{}\n",
    "src/a.ts": "export function alpha(n: number, deep: boolean) {\n  return deep ? n : 0;\n}\n",
    "src/git.ts": `${imports}export function head(dir: string) {\n  const inner = () => 1;\n  return execFileSync("git", ["rev-parse"], { cwd: dir });\n}\n\nexport class Repo {\n  open() {\n    return SECRET_BODY;\n  }\n}\n`,
    "test/git.test.ts": "function helper() {\n  return 1;\n}\n",
    "README.md": "# hi\n",
  }),
);
const comparison = compare(baseGraph, headGraph);
const places = placesOf(comparison, headGraph);
const claims = splitClaims("Reads the head commit from git.\n- alpha takes a depth flag\n");

test("the places are every changed file with its range, and under source files their classes, methods and top-level functions", () => {
  expect(places.flatMap((place) => place.line.split("\n"))).toEqual([
    "added file:README.md [docs] L1",
    "altered file:src/a.ts [source] L1-3",
    "  altered function:src/a.ts#alpha L1-3 exported (n: number, deep: boolean)",
    "    was (n: number)",
    "added file:src/git.ts [source] L1-11",
    "  added function:src/git.ts#head L2-5 exported (dir: string)",
    '    new effect: process child_process execFileSync git L4',
    "  added class:src/git.ts#Repo L7-11 exported { open() }",
    "  added function:src/git.ts#Repo.open L8-10 ()",
    "removed file:src/gone.ts [source] L1-3",
    "  removed function:src/gone.ts#old L1-3 exported ()",
    "added file:test/git.test.ts [tests] L1-3",
  ]);
  expect(places.find((place) => place.id === "function:src/git.ts#head")!.range).toEqual({ start: 2, end: 5 });
  expect(places.find((place) => place.id === "file:src/gone.ts")!.range).toEqual({ start: 1, end: 3 });
});

test("the prompt holds claims, place lines and its version, and never source text", () => {
  const prompt = tourPrompt(claims, places);
  expect(prompt.system).toContain(TOUR_PROMPT_VERSION);
  expect(prompt.user).toContain('0: "Reads the head commit from git."');
  expect(prompt.user).toContain("  added function:src/git.ts#head L2-5 exported (dir: string)");
  expect(prompt.user).not.toContain("SECRET_BODY");
  expect(prompt.user).not.toContain("rev-parse");
  expect(prompt.user).not.toContain("deep ? n : 0");
  expect(tourPrompt(claims, places)).toEqual(prompt);
});

const stop = (over: Record<string, unknown>) => ({ title: "Git", ids: ["function:src/git.ts#head"], claims: [0], narration: [], ...over });

test("a default value in a signature, now or before, never reaches the tour prompt", () => {
  const before = extract(tree({ "package.json": "{}\n", "src/d.ts": 'export function d(x = "OLD_SECRET") {\n  return x;\n}\n' }));
  const after = extract(tree({ "package.json": "{}\n", "src/d.ts": 'export function d(x = "NEW_SECRET", y = a ? b() : c()) {\n  return x;\n}\n' }));
  const text = placesOf(compare(before, after), after).map((place) => place.line).join("\n");
  expect(text).toContain("(x = …, y = …)");
  expect(text).toContain("was (x = …)");
  expect(text).not.toMatch(/SECRET|a \? b/);
});

test("a stop keeps only ids that are places, and a stop left with none is dropped and counted", () => {
  const tour = validateTour(
    {
      stops: [
        stop({ ids: ["function:src/git.ts#head", "function:src/git.ts#nope", "function:src/git.ts#head", "function:src/git.ts#head.inner"] }),
        stop({ title: "Nowhere", ids: ["file:src/invented.ts"] }),
      ],
    },
    claims.length,
    places,
  );
  expect(tour.stops).toEqual([{ title: "Git", ids: ["function:src/git.ts#head"], claims: [0], sentences: [] }]);
  expect(tour.dropped).toEqual({ stops: 1, ids: 3, claims: 0, sentences: 0 });
});

test("a claim index out of range is dropped and counted, and repeats collapse", () => {
  const tour = validateTour({ stops: [stop({ claims: [1, 7, -1, 1, 0] })] }, claims.length, places);
  expect(tour.stops[0]!.claims).toEqual([1, 0]);
  expect(tour.dropped).toEqual({ stops: 0, ids: 0, claims: 2, sentences: 0 });
});

test("a sentence is kept only when its lines lie inside a node of its own stop", () => {
  const say = (id: string, start: number, end: number, text = "Runs git.") => ({ text, id, start, end });
  const tour = validateTour(
    {
      stops: [
        stop({
          narration: [
            say("function:src/git.ts#head", 4, 4, "  Runs git\n rev-parse. "),
            say("function:src/git.ts#head", 2, 5),
            say("function:src/git.ts#head", 1, 4),
            say("function:src/git.ts#head", 4, 6),
            say("function:src/git.ts#head", 5, 4),
            say("function:src/a.ts#alpha", 1, 3),
            say("function:src/git.ts#nope", 2, 3),
            say("function:src/git.ts#head", 3, 3, "   "),
          ],
        }),
      ],
    },
    claims.length,
    places,
  );
  expect(tour.stops[0]!.sentences).toEqual([
    { text: "Runs git rev-parse.", id: "function:src/git.ts#head", range: { start: 4, end: 4 } },
    { text: "Runs git.", id: "function:src/git.ts#head", range: { start: 2, end: 5 } },
  ]);
  expect(tour.dropped.sentences).toBe(6);
});

test("validation refuses output that is not the schema's shape", () => {
  const bad = [
    null,
    {},
    { stops: "x" },
    { stops: [null] },
    { stops: [stop({ title: 3 })] },
    { stops: [stop({ ids: [1] })] },
    { stops: [stop({ claims: ["0"] })] },
    { stops: [stop({ claims: [0.5] })] },
    { stops: [stop({ narration: [{ text: 1, id: "x", start: 1, end: 1 }] })] },
    { stops: [stop({ narration: [{ text: "t", id: "function:src/git.ts#head", start: "1", end: 1 }] })] },
  ];
  for (const output of bad) expect(() => validateTour(output, 2, places)).toThrow();
});

function fake(output: unknown, calls: { count: number; schemas?: object[] } = { count: 0 }): AgentRunner {
  return {
    async run(request) {
      calls.count++;
      calls.schemas?.push(request.schema);
      return { output, model: "fake-model" };
    },
  };
}

const answer = {
  stops: [
    stop({ narration: [{ text: "Runs git.", id: "function:src/git.ts#head", start: 4, end: 4 }, { text: "Elsewhere.", id: "file:src/a.ts", start: 1, end: 1 }] }),
    stop({ title: "Lost", ids: ["file:nope.ts"] }),
  ],
};
const request = (over: object) => ({ claims, places, cacheDir: temp(), rewalk: false, timeoutMs: 1000, runner: fake(answer), ...over });

test("a walkthrough is the validated tour with the model, prompt version and drop counts", async () => {
  expect(await walkthrough(request({}))).toEqual({
    status: "ok",
    stops: [{ title: "Git", ids: ["function:src/git.ts#head"], claims: [0], sentences: [{ text: "Runs git.", id: "function:src/git.ts#head", range: { start: 4, end: 4 } }] }],
    dropped: { stops: 1, ids: 1, claims: 0, sentences: 1 },
    model: "fake-model",
    promptVersion: TOUR_PROMPT_VERSION,
    cached: false,
  });
});

test("a second run reads the cache, another prompt misses, and rewalk asks again", async () => {
  const cacheDir = temp();
  const calls = { count: 0 };
  const first = await walkthrough(request({ cacheDir, runner: fake(answer, calls) }));
  const second = await walkthrough(request({ cacheDir, runner: fake({ stops: [] }, calls) }));
  expect(calls.count).toBe(1);
  expect(second).toEqual({ ...first, cached: true });
  expect(readdirSync(cacheDir)).toHaveLength(1);
  expect(readdirSync(cacheDir)[0]).toMatch(/^[0-9a-f]{64}\.json$/);

  await walkthrough(request({ cacheDir, runner: fake(answer, calls), claims: splitClaims("Other words.") }));
  await walkthrough(request({ cacheDir, runner: fake(answer, calls), places: places.slice(1) }));
  expect(calls.count).toBe(3);

  const again = await walkthrough(request({ cacheDir, runner: fake({ stops: [] }, calls), rewalk: true }));
  expect(calls.count).toBe(4);
  expect(again).toMatchObject({ status: "ok", stops: [], cached: false });
  expect(await walkthrough(request({ cacheDir, runner: fake(answer, calls) }))).toMatchObject({ stops: [], cached: true });
});

test("a runner that throws, or answers the wrong shape, gives one failed line and is not cached", async () => {
  const cacheDir = temp();
  const throws: AgentRunner = { run: () => Promise.reject(new Error("claude CLI timed out\nafter 600s")) };
  expect(await walkthrough(request({ cacheDir, runner: throws }))).toEqual({ status: "failed", message: "claude CLI timed out after 600s" });
  expect(await walkthrough(request({ cacheDir, runner: fake({ stops: "no" }) }))).toMatchObject({ status: "failed" });
  expect(readdirSync(cacheDir)).toHaveLength(0);
});

test("the agent is asked with a schema for stops, ids, claims and anchored narration", async () => {
  const calls = { count: 0, schemas: [] as object[] };
  await walkthrough(request({ runner: fake(answer, calls) }));
  expect(JSON.stringify(calls.schemas[0])).toContain('"required":["text","id","start","end"]');
});

test("a binary file offers no line anchors: its place says binary and narration anchored into it is dropped", () => {
  const headGraph = extract(tree({ "package.json": "{}\n", "a.bin": "\0\n" }));
  const places = placesOf(compare(extract(tree({ "package.json": "{}\n" })), headGraph), headGraph);
  const place = places.find((candidate) => candidate.id === "file:a.bin")!;
  expect(place.line).toContain("binary");
  expect(place.line).not.toMatch(/L\d/);
  const tour = validateTour(
    { stops: [{ title: "A", ids: ["file:a.bin"], claims: [], narration: [{ text: "Adds an image.", id: "file:a.bin", start: 1, end: 1 }] }] },
    0,
    places,
  );
  expect(tour.stops[0]?.sentences).toEqual([]);
  expect(tour.dropped.sentences).toBe(1);
});
