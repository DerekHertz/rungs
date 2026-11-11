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
  const dir = mkdtempSync(join(tmpdir(), "streets-link-"));
  scratch.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const fn = (name: string, body = 1): string => `export function ${name}() {\n  return ${body};\n}\n`;
const tree = (files: Record<string, string>): FileTree => new Map(Object.entries(files));
const headGraph = extract(tree({ "package.json": "{}\n", "src/a.ts": fn("alpha", 2), "src/new.ts": fn("fresh") + "export class Box {\n  open() {\n    return 1;\n  }\n}\n" }));
const comparison = compare(extract(tree({ "package.json": "{}\n", "src/a.ts": fn("alpha"), "src/gone.ts": fn("old") })), headGraph);
const candidates = candidatesOf(comparison, headGraph);
const claims = splitClaims("Speeds up alpha.\n- Adds fresh things\n");

test("the candidates are the folders holding changed files, with counts and kinds, then every changed file, and no code", () => {
  expect(candidates.map((candidate) => candidate.line)).toEqual([
    "folder folder:src (3 changed files: 1 added, 1 altered, 1 removed)",
    "altered file:src/a.ts",
    "removed file:src/gone.ts",
    "added file:src/new.ts",
  ]);
  expect(candidates[0]!.files).toEqual([]);
  expect(candidates[1]!.files).toEqual(["file:src/a.ts"]);
});

test("the prompt holds the claims and candidate lines and no source text, and names its version", () => {
  const prompt = promptFor(claims, candidates);
  expect(prompt.system).toContain(PROMPT_VERSION);
  expect(prompt.user).toContain('0: "Speeds up alpha."');
  expect(prompt.user).toContain('1: "Adds fresh things"');
  expect(prompt.user).toContain("altered file:src/a.ts");
  expect(prompt.user).not.toContain("return 2");
  expect(prompt.user).not.toContain("alpha()");
  expect(promptFor(claims, candidates)).toEqual(prompt);
});

const known = new Map(candidates.map((candidate) => [candidate.id, candidate.files] as const));

test("validation drops ids outside the candidates and claim indexes out of range, and counts them", () => {
  const out = validate(
    { links: [{ claim: 0, ids: ["file:src/a.ts", "file:src/nope.ts", "file:src/a.ts"] }, { claim: 1, ids: ["file:src/new.ts"] }, { claim: 1, ids: ["file:src/a.ts"] }, { claim: 7, ids: ["file:src/a.ts"] }, { claim: -1, ids: [] }] },
    claims,
    known,
  );
  expect(out).toMatchObject({
    byClaim: [["file:src/a.ts"], ["file:src/new.ts", "file:src/a.ts"]],
    dropped: { ids: 1, claims: 2 },
  });
});

test("a link to a folder covers none of its files, and the claim keeps its other links", () => {
  const out = validate({ links: [{ claim: 0, ids: ["file:src/a.ts", "folder:src"] }, { claim: 1, ids: ["folder:src"] }] }, claims, known);
  expect(out.byClaim).toEqual([["file:src/a.ts"], []]);
});

const three = splitClaims("Speeds up alpha.\nFound by the security review.\nAlpha now runs faster.\n");
const check = (links: unknown[]) => validate({ links }, three, known);

test("a restatement stays tier claimed, with its source sentences; context is counted and dropped", () => {
  const out = check([say(0, "Speeds up alpha", ["file:src/a.ts"]), say(1, "Context"), say(2, "Alpha runs faster")]);
  expect(out.shown.map((row) => [row.text, row.sources])).toEqual([["Speeds up alpha", [0]], ["Alpha runs faster", [2]]]);
  expect(out.context).toEqual([1]);
});

test("claims that say the same thing merge: one row, every source, the union of ids", () => {
  const out = check([say(0, "Speeds up alpha", ["file:src/a.ts"]), say(1, "context"), say(2, "Alpha runs faster", ["file:src/new.ts"], 0)]);
  expect(out.shown).toEqual([{ text: "Speeds up alpha", restated: true, sources: [0, 2], ids: ["file:src/a.ts", "file:src/new.ts"] }]);
  expect(out.dropped.restatements).toBe(0);
});

test("an invalid restatement falls back to the original text: too long, empty, missing, or a bad merge", () => {
  const long = Array(21).fill("word").join(" ");
  const out = check([say(0, long), say(1, "  ", [], 1), say(2, "Fine", [], 5)]);
  expect(out.shown.map((row) => [row.text, row.restated, row.sources])).toEqual([
    ["Speeds up alpha.", false, [0]],
    ["Found by the security review.", false, [1]],
    ["Alpha now runs faster.", false, [2]],
  ]);
  expect(out.dropped.restatements).toBe(3);
  const badMerge = check([say(0, "Accepts alpha", [], 99), say(1, "context"), say(2, "Fine")]);
  expect(badMerge.shown[0]).toMatchObject({ text: "Speeds up alpha.", restated: false });
  const invalidMerges = check([say(0, "Speeds up alpha"), say(1, "", [], 0), say(2, Array(21).fill("w").join(" "), [], 0)]);
  expect(invalidMerges.shown.map((row) => [row.text, row.restated, row.sources])).toEqual([
    ["Speeds up alpha", true, [0]],
    ["Found by the security review.", false, [1]],
    ["Alpha now runs faster.", false, [2]],
  ]);
  expect(invalidMerges.dropped.restatements).toBe(2);
  const missing = check([say(1, "Found it")]);
  expect(missing.shown.map((row) => row.restated)).toEqual([false, true, false]);
  const chain = check([say(0, "A one", [], 1), say(1, "B two", [], 2), say(2, "C three")]);
  expect(chain.shown.map((row) => row.sources)).toEqual([[0], [1, 2]]);
  const intoContext = check([say(0, "A one", [], 1), say(1, "context"), say(2, "C three")]);
  expect(intoContext.shown.map((row) => [row.text, row.sources])).toEqual([["Speeds up alpha.", [0]], ["C three", [2]]]);
});

test("the prompt asks for restatements and context, and tells the agent to see no source text", () => {
  const { system } = promptFor(claims, candidates);
  expect(system).toContain('exactly "context"');
  expect(system).toContain("about 12 words");
  expect(system).toContain("You see no source code");
});

test("footers are stripped by rule before the agent sees the claims", () => {
  const found = splitClaims("Adds a thing.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\nGenerated with [Claude Code](https://claude.com/claude-code)\n");
  expect(found.map((claim) => claim.text)).toEqual(["Adds a thing."]);
});

test("only the footer line goes: text next to it stays a claim, at its own span", () => {
  const description = "- Adds logging.\n\n🤖 Generated with [Claude](https://example.com)\nRejects expired tokens.";
  const found = splitClaims(description);
  expect(found.map((claim) => claim.text)).toEqual(["Adds logging.", "Rejects expired tokens."]);
  for (const claim of found) expect(description.slice(claim.start, claim.end)).toBe(claim.text);
});

test("validation refuses output that is not the schema's shape", () => {
  const nothing = new Map<NodeId, readonly NodeId[]>();
  for (const bad of [null, "x", {}, { links: "x" }, { links: [{ claim: "0", ids: [] }] }, { links: [{ claim: 0, ids: [3] }] }, { links: [{ claim: 0.5, ids: [] }] }]) {
    expect(() => validate(bad, claims, nothing)).toThrow();
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

const say = (claim: number, text: string, ids: string[] = [], mergeInto = -1) => ({ claim, ids, say: text, mergeInto });
const answer = { links: [say(0, "Speeds up alpha", ["file:src/a.ts", "file:src/bogus.ts"]), say(1, "Adds fresh things", ["file:src/new.ts"])] };

test("linking validates the agent's answer and reports the model, prompt version and drops", async () => {
  const outcome = await linkClaims({ claims, candidates, runner: fake(answer), cacheDir: temp(), relink: false, timeoutMs: 1000 });
  expect(outcome).toEqual({
    status: "ok",
    byClaim: [["file:src/a.ts"], ["file:src/new.ts"]],
    shown: [
      { text: "Speeds up alpha", restated: true, sources: [0], ids: ["file:src/a.ts"] },
      { text: "Adds fresh things", restated: true, sources: [1], ids: ["file:src/new.ts"] },
    ],
    context: [],
    model: "fake-model",
    promptVersion: PROMPT_VERSION,
    dropped: { ids: 1, claims: 0, restatements: 0 },
    cached: false,
  });
});

test("an agent that links only folders leaves the claims unlinked, so the files stay unmentioned", async () => {
  const outcome = await linkClaims({ claims, candidates, runner: fake({ links: [say(0, "Speeds up alpha", ["folder:src"]), say(1, "Adds fresh things", ["folder:src"])] }), cacheDir: temp(), relink: false, timeoutMs: 1000 });
  expect(outcome).toMatchObject({ status: "ok", byClaim: [[], []], dropped: { ids: 0 } });
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

test("the cache key is what the prompt says: the same ids with another change kind miss", async () => {
  const dir = temp();
  const asRemoved = candidates.map((candidate) => ({ ...candidate, line: candidate.line.replace("altered", "removed") }));
  const calls = { count: 0 };
  await linkClaims({ claims, candidates, runner: fake(answer, calls), cacheDir: dir, relink: false, timeoutMs: 1000 });
  await linkClaims({ claims, candidates: asRemoved, runner: fake(answer, calls), cacheDir: dir, relink: false, timeoutMs: 1000 });
  expect(calls.count).toBe(2);
  expect(readdirSync(dir)).toHaveLength(2);
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
  expect(cacheDirectory({ XDG_CACHE_HOME: "/x/cache" }, "/home/u")).toBe("/x/cache/systems-to-streets");
  expect(cacheDirectory({}, "/home/u")).toBe("/home/u/.cache/systems-to-streets");
  expect(cacheDirectory({ XDG_CACHE_HOME: "" }, "/home/u")).toBe("/home/u/.cache/systems-to-streets");
});

function stub(script: string): string {
  const path = join(temp(), "claude");
  writeFileSync(path, `#!/usr/bin/env node\n${script}\n`);
  chmodSync(path, 0o755);
  return path;
}
const request = { system: "s", prompt: "p", schema: { type: "object" }, timeoutMs: 3000 };

test("the CLI runner passes the prompt on stdin, allows no tools or MCP servers, asks for opus at medium effort, and reads structured_output and the model", async () => {
  const command = stub(`
    let input = ""; process.stdin.on("data", (d) => (input += d)).on("end", () => {
      const args = process.argv.slice(2);
      const ok = args.includes("-p") && args[args.indexOf("--tools") + 1] === "" && args.includes("--strict-mcp-config") && !args.includes("--mcp-config") && args[args.indexOf("--model") + 1] === "opus" && args[args.indexOf("--effort") + 1] === "medium" && args[args.indexOf("--output-format") + 1] === "json" && args.includes("--json-schema") && input === "p";
      console.log(JSON.stringify({ is_error: !ok, result: "bad args " + args.join(" "), structured_output: { links: [] }, modelUsage: { "claude-x": {} } }));
    });`);
  expect(await claudeRunner(command).run(request)).toEqual({ output: { links: [] }, model: "claude-x" });
});

// Every case here but the last must fail for its own reason, so each gets a timeout so long that
// loaded-machine slowness in starting node can never pass for "timed out". The timeout is tested
// alone, below, on a stub that never answers.
test("the CLI runner fails with one line when the command is missing, exits non-zero, prints non-JSON or reports an error", { timeout: 60000 }, async () => {
  const cases: [string, string][] = [
    [join(temp(), "no-such-claude"), "not found"],
    [stub(`console.error("boom\\nmore"); process.exit(3);`), "exited with 3"],
    [stub(`console.log("not json");`), "invalid JSON"],
    [stub(`console.log("null");`), "not an object"],
    [stub(`console.log("42");`), "not an object"],
    [stub(`console.log('"text"');`), "not an object"],
    [stub(`console.log("[1]");`), "not an object"],
    [stub(`console.log("null"); process.exit(2);`), "exited with 2"],
    [stub(`console.log(JSON.stringify({ is_error: true, result: "Not logged in" }));`), "Not logged in"],
    [stub(`console.log(JSON.stringify({ is_error: false, result: "x" }));`), "no structured output"],
    [stub(`console.log('{"is_error":true,"result":{"toString":null}}');`), "reported an error"],
  ];
  for (const [command, expected] of cases) {
    const error = await claudeRunner(command)
      .run({ ...request, timeoutMs: 30000 })
      .then(
        () => undefined,
        (caught: Error) => caught,
      );
    expect(error?.message).toContain(expected);
    expect(error?.message).not.toContain("\n");
  }
});

// The stub never writes and never exits, so only the CLI timeout can end it, however slow the
// machine is: the short timeout cannot fire early on any other case, and cannot be missed.
test("the CLI runner fails with one line when the command never answers within the timeout", { timeout: 60000 }, async () => {
  const error = await claudeRunner(stub(`setInterval(() => {}, 1000);`))
    .run({ ...request, timeoutMs: 300 })
    .then(
      () => undefined,
      (caught: Error) => caught,
    );
  expect(error?.message).toBe("claude CLI timed out after 0s");
});

test.skipIf(process.env.STREETS_REAL_CLAUDE !== "1")("the real claude CLI links a claim to the module it names", { timeout: 180000 }, async () => {
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
  expect(ids.some((id) => id === "file:src/a.ts")).toBe(true);
});
