import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { extract } from "../src/extract/extract.ts";
import { isCodeNode } from "../src/graph.ts";
import type { CodeNode, FileTree, NodeId } from "../src/graph.ts";
import type { AgentRunner } from "../src/link.ts";
import { narrate } from "../src/narrate.ts";
import { NARRATION_PROMPT_VERSION, isStale, narrationPrompt, validateNarration } from "../src/narration.ts";
import { pseudocode } from "../src/pseudocode.ts";

const scratch: string[] = [];
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "rungs-narrate-"));
  scratch.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const source = (literal: string): FileTree =>
  new Map([
    ["package.json", "{}\n"],
    [
      "src/git.ts",
      `import { execFileSync } from "node:child_process";\nexport function head(dir: string) {\n  const inner = () => 1;\n  if (dir === "${literal}") return inner();\n  return execFileSync("git", ["rev-parse"], { cwd: dir });\n}\n`,
    ],
  ]);
const id = "function:src/git.ts#head" as NodeId;
function parts(tree: FileTree) {
  const graph = extract(tree);
  const node = graph.nodes.find((candidate): candidate is CodeNode => isCodeNode(candidate) && candidate.id === id)!;
  return { node, outline: pseudocode(graph, tree, id)!, effects: graph.edges.filter((edge) => edge.from === id) };
}
const { node, outline, effects } = parts(source("SECRET_LITERAL"));

test("the prompt is the function's lines, signature and outline structure, never a line of text", () => {
  const prompt = narrationPrompt(node, outline, effects);
  expect(prompt.system).toContain(NARRATION_PROMPT_VERSION);
  expect(prompt.user).toBe(
    [
      "FUNCTION function:src/git.ts#head L2-6 exported (dir: string)",
      "",
      "OUTLINE",
      "0 function L3 function:src/git.ts#head.inner",
      "1 if L4",
      "2   return L4",
      "3 return L5",
      '4   effect L5 process child_process execFileSync "git"',
    ].join("\n"),
  );
  expect(outline.map((line) => line.text).join("\n")).toContain("SECRET_LITERAL");
  expect(prompt.user).not.toContain("SECRET_LITERAL");
  expect(prompt.user).not.toContain("rev-parse");
});

const say = (text: string, from: number, to: number) => ({ text, from, to });

test("a sentence is kept only when it is anchored to outline rows of this function, and the rest are dropped and counted", () => {
  const done = validateNarration(
    {
      narration: [say("  Asks git\n for the head. ", 4, 4), say("Checks the directory.", 1, 2), say("Past the end.", 2, 5), say("Backwards.", 2, 1), say("Negative.", -1, 0), say("   ", 0, 0)],
    },
    "abc",
    outline,
  );
  expect(done).toEqual({
    digest: "abc",
    sentences: [
      { text: "Asks git for the head.", from: 4, to: 4, range: { start: 5, end: 5 } },
      { text: "Checks the directory.", from: 1, to: 2, range: { start: 4, end: 4 } },
    ],
    dropped: { sentences: 4 },
  });
});

test("an answer that is not the schema's shape throws", () => {
  expect(() => validateNarration({}, "abc", outline)).toThrow(/no narration list/);
  expect(() => validateNarration({ narration: [{ text: "x", from: "0", to: 0 }] }, "abc", outline)).toThrow(/malformed sentence/);
});

test("narration is stale when the function's digest differs from the one narrated", () => {
  const edited = parts(source("OTHER")).node;
  expect(edited.digest).not.toBe(node.digest);
  expect(isStale({ digest: node.digest }, node)).toBe(false);
  expect(isStale({ digest: node.digest }, edited)).toBe(true);
});

function counting(output: unknown): AgentRunner & { calls: number; prompts: string[] } {
  const runner = {
    calls: 0,
    prompts: [] as string[],
    async run({ prompt }: { prompt: string }) {
      runner.calls++;
      runner.prompts.push(prompt);
      return { output, model: "fake" };
    },
  };
  return runner;
}

test("narrate asks once, caches by prompt, keeps the digest it narrated, and asks again on renarrate", async () => {
  const cacheDir = temp();
  const runner = counting({ narration: [say("Asks git.", 4, 4), say("Nowhere.", 9, 9)] });
  const request = { node, outline, effects, runner, cacheDir, renarrate: false, timeoutMs: 1000 };
  const first = await narrate(request);
  expect(first).toMatchObject({ status: "ok", digest: node.digest, dropped: { sentences: 1 }, model: "fake", cached: false });
  const again = await narrate(request);
  expect(again).toMatchObject({ status: "ok", cached: true, digest: node.digest });
  expect(runner.calls).toBe(1);
  // Only a literal changed: the outline is the same prompt, so the cached narration is returned for another digest, which reads as stale.
  const edited = parts(source("OTHER"));
  const old = await narrate({ ...request, ...edited });
  expect(old).toMatchObject({ status: "ok", cached: true });
  if (old.status === "ok") expect(isStale(old, edited.node)).toBe(true);
  expect(runner.calls).toBe(1);
  const fresh = await narrate({ ...request, ...edited, renarrate: true });
  expect(fresh).toMatchObject({ status: "ok", cached: false, digest: edited.node.digest });
  expect(runner.calls).toBe(2);
  expect(runner.prompts.every((prompt) => !prompt.includes("SECRET_LITERAL") && !prompt.includes("OTHER"))).toBe(true);
});

test("a function with no outline is not asked about", async () => {
  const runner = counting({ narration: [] });
  const result = await narrate({ node, outline: [], effects: [], runner, cacheDir: temp(), renarrate: false, timeoutMs: 1000 });
  expect(result).toMatchObject({ status: "ok", sentences: [] });
  expect(runner.calls).toBe(0);
});

test("a failing agent is returned as a failure and never cached", async () => {
  const cacheDir = temp();
  const failing: AgentRunner = { run: () => Promise.reject(new Error("claude CLI not found (claude)")) };
  expect(await narrate({ node, outline, effects, runner: failing, cacheDir, renarrate: false, timeoutMs: 1000 })).toEqual({ status: "failed", message: "claude CLI not found (claude)" });
  const runner = counting({ narration: [] });
  expect(await narrate({ node, outline, effects, runner, cacheDir, renarrate: false, timeoutMs: 1000 })).toMatchObject({ status: "ok", cached: false });
});
