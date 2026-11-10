import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { splitClaims } from "../src/claims.ts";
import { compare } from "../src/compare.ts";
import { extract } from "../src/extract/extract.ts";
import type { FileTree, NodeId } from "../src/graph.ts";
import { PROMPT_VERSION, cacheDirectory, candidatesOf, claudeRunner, linkClaims, promptFor, validate } from "../src/link.ts";
import type { AgentRunner } from "../src/link.ts";

const scratch: string[] = [];
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "rungs-link-"));
  scratch.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const fn = (name: string, body = 1): string => `export function ${name}() {\n  return ${body};\n}\n`;
const tree = (files: Record<string, string>): FileTree => new Map(Object.entries(files));
const comparison = compare(
  extract(tree({ "package.json": "{}\n", "src/a.ts": fn("alpha"), "src/gone.ts": fn("old") })),
  extract(tree({ "package.json": "{}\n", "src/a.ts": fn("alpha", 2), "src/new.ts": fn("fresh") + "export class Box {\n  open() {\n    return 1;\n  }\n}\n" })),
);
const candidates = candidatesOf(comparison);
const claims = splitClaims("Speeds up alpha.\n- Adds fresh things\n");

test("the candidates are every changed file, class and function with its change kind, and never a folder", () => {
  expect(candidates.map((candidate) => `${candidate.kind} ${candidate.id}`)).toEqual([
    "altered file:src/a.ts",
    "altered function:src/a.ts#alpha",
    "removed file:src/gone.ts",
    "removed function:src/gone.ts#old",
    "added file:src/new.ts",
    "added class:src/new.ts#Box",
    "added function:src/new.ts#Box.open",
    "added function:src/new.ts#fresh",
  ]);
});

test("the prompt holds the claims and candidate ids and no source text, and names its version", () => {
  const prompt = promptFor(claims, candidates);
  expect(prompt.system).toContain(PROMPT_VERSION);
  expect(prompt.user).toContain('0: "Speeds up alpha."');
  expect(prompt.user).toContain('1: "Adds fresh things"');
  expect(prompt.user).toContain("altered file:src/a.ts");
  expect(prompt.user).not.toContain("return 2");
  expect(promptFor(claims, candidates)).toEqual(prompt);
});

test("validation drops ids outside the candidates and claim indexes out of range, and counts them", () => {
  const known = new Set(candidates.map((candidate) => candidate.id));
  const out = validate(
    { links: [{ claim: 0, ids: ["file:src/a.ts", "file:src/nope.ts", "file:src/a.ts"] }, { claim: 1, ids: ["function:src/new.ts#fresh"] }, { claim: 1, ids: ["file:src/new.ts"] }, { claim: 7, ids: ["file:src/a.ts"] }, { claim: -1, ids: [] }] },
    claims.length,
    known,
  );
  expect(out).toEqual({
    byClaim: [["file:src/a.ts"], ["function:src/new.ts#fresh", "file:src/new.ts"]],
    dropped: { ids: 1, claims: 2 },
  });
});

test("validation refuses output that is not the schema's shape", () => {
  const known = new Set<NodeId>();
  for (const bad of [null, "x", {}, { links: "x" }, { links: [{ claim: "0", ids: [] }] }, { links: [{ claim: 0, ids: [3] }] }, { links: [{ claim: 0.5, ids: [] }] }]) {
    expect(() => validate(bad, 2, known)).toThrow();
  }
});

function fake(output: unknown, calls: { count: number } = { count: 0 }): AgentRunner {
  return {
    async run() {
      calls.count++;
      return { output, model: "fake-model" };
    },
  };
}

const answer = { links: [{ claim: 0, ids: ["function:src/a.ts#alpha", "file:src/bogus.ts"] }, { claim: 1, ids: ["file:src/new.ts"] }] };

test("linking validates the agent's answer and reports the model, prompt version and drops", async () => {
  const outcome = await linkClaims({ claims, candidates, runner: fake(answer), cacheDir: temp(), relink: false, timeoutMs: 1000 });
  expect(outcome).toEqual({
    status: "ok",
    byClaim: [["function:src/a.ts#alpha"], ["file:src/new.ts"]],
    model: "fake-model",
    promptVersion: PROMPT_VERSION,
    dropped: { ids: 1, claims: 0 },
    cached: false,
  });
});

test("a second run reuses the cache without calling the agent, and relink forces a new call", async () => {
  const dir = temp();
  const calls = { count: 0 };
  const first = await linkClaims({ claims, candidates, runner: fake(answer, calls), cacheDir: dir, relink: false, timeoutMs: 1000 });
  const second = await linkClaims({ claims, candidates, runner: fake({ links: [] }, calls), cacheDir: dir, relink: false, timeoutMs: 1000 });
  expect(calls.count).toBe(1);
  expect(second).toEqual({ ...first, cached: true });
  const third = await linkClaims({ claims, candidates, runner: fake({ links: [] }, calls), cacheDir: dir, relink: true, timeoutMs: 1000 });
  expect(calls.count).toBe(2);
  expect(third).toMatchObject({ status: "ok", byClaim: [[], []], cached: false });
  const fourth = await linkClaims({ claims, candidates, runner: fake(answer, calls), cacheDir: dir, relink: false, timeoutMs: 1000 });
  expect(fourth).toMatchObject({ byClaim: [[], []], cached: true });
});

test("the cache is plain JSON keyed by the claims and candidate ids, so other claims or candidates miss", async () => {
  const dir = temp();
  await linkClaims({ claims, candidates, runner: fake(answer), cacheDir: dir, relink: false, timeoutMs: 1000 });
  const [file] = readdirSync(dir);
  expect(file).toMatch(/^[0-9a-f]{64}\.json$/);
  expect(JSON.parse(readFileSync(join(dir, file!), "utf8"))).toMatchObject({ promptVersion: PROMPT_VERSION, model: "fake-model" });
  const calls = { count: 0 };
  await linkClaims({ claims: splitClaims("Different words."), candidates, runner: fake(answer, calls), cacheDir: dir, relink: false, timeoutMs: 1000 });
  await linkClaims({ claims, candidates: candidates.slice(1), runner: fake(answer, calls), cacheDir: dir, relink: false, timeoutMs: 1000 });
  expect(calls.count).toBe(2);
});

test("a runner that throws, or answers the wrong shape, gives one failed line and no links", async () => {
  const throwing: AgentRunner = { run: () => Promise.reject(new Error("claude CLI not found")) };
  expect(await linkClaims({ claims, candidates, runner: throwing, cacheDir: temp(), relink: false, timeoutMs: 1000 })).toEqual({
    status: "failed",
    message: "claude CLI not found",
  });
  const wrong = await linkClaims({ claims, candidates, runner: fake({ nope: 1 }), cacheDir: temp(), relink: false, timeoutMs: 1000 });
  expect(wrong).toMatchObject({ status: "failed" });
  expect((wrong as { message: string }).message).not.toContain("\n");
});

test("a failure is not cached", async () => {
  const dir = temp();
  await linkClaims({ claims, candidates, runner: fake({ nope: 1 }), cacheDir: dir, relink: false, timeoutMs: 1000 });
  expect(readdirSync(dir)).toEqual([]);
});

test("the cache directory follows XDG_CACHE_HOME, then the home directory", () => {
  expect(cacheDirectory({ XDG_CACHE_HOME: "/x/cache" }, "/home/u")).toBe("/x/cache/rungs");
  expect(cacheDirectory({}, "/home/u")).toBe("/home/u/.cache/rungs");
  expect(cacheDirectory({ XDG_CACHE_HOME: "" }, "/home/u")).toBe("/home/u/.cache/rungs");
});

function stub(script: string): string {
  const path = join(temp(), "claude");
  writeFileSync(path, `#!/usr/bin/env node\n${script}\n`);
  chmodSync(path, 0o755);
  return path;
}
const request = { system: "s", prompt: "p", schema: { type: "object" }, timeoutMs: 3000 };

test("the CLI runner passes the prompt on stdin, allows no tools, and reads structured_output and the model", async () => {
  const command = stub(`
    let input = ""; process.stdin.on("data", (d) => (input += d)).on("end", () => {
      const args = process.argv.slice(2);
      const ok = args.includes("-p") && args[args.indexOf("--tools") + 1] === "" && args[args.indexOf("--output-format") + 1] === "json" && args.includes("--json-schema") && input === "p";
      console.log(JSON.stringify({ is_error: !ok, result: "bad args " + args.join(" "), structured_output: { links: [] }, modelUsage: { "claude-x": {} } }));
    });`);
  expect(await claudeRunner(command).run(request)).toEqual({ output: { links: [] }, model: "claude-x" });
});

test("the CLI runner fails with one line when the command is missing, exits non-zero, prints non-JSON, reports an error or times out", async () => {
  const cases: [string, string][] = [
    [join(temp(), "no-such-claude"), "not found"],
    [stub(`console.error("boom\\nmore"); process.exit(3);`), "exited with 3"],
    [stub(`console.log("not json");`), "invalid JSON"],
    [stub(`console.log(JSON.stringify({ is_error: true, result: "Not logged in" }));`), "Not logged in"],
    [stub(`console.log(JSON.stringify({ is_error: false, result: "x" }));`), "no structured output"],
    [stub(`setTimeout(() => {}, 60000);`), "timed out"],
  ];
  for (const [command, expected] of cases) {
    const error = await claudeRunner(command)
      .run({ ...request, timeoutMs: 400 })
      .then(
        () => undefined,
        (caught: Error) => caught,
      );
    expect(error?.message).toContain(expected);
    expect(error?.message).not.toContain("\n");
  }
});

test.skipIf(process.env.RUNGS_REAL_CLAUDE !== "1")("the real claude CLI links a claim to the module it names", { timeout: 180000 }, async () => {
  const outcome = await linkClaims({
    claims: splitClaims("Makes alpha return a different number."),
    candidates,
    runner: claudeRunner("claude"),
    cacheDir: temp(),
    relink: true,
    timeoutMs: 150000,
  });
  expect(outcome).toMatchObject({ status: "ok" });
  const ids = outcome.status === "ok" ? outcome.byClaim[0]! : [];
  expect(ids.some((id) => id.includes("src/a.ts"))).toBe(true);
});
