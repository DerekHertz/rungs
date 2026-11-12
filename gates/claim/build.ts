#!/usr/bin/env node
/**
 * Builds gates/claim/cases.json from gates/claim/sources.json.
 *
 *   node gates/claim/build.ts
 *
 * sources.json lists each case: its label, the claim's text, where that text came from (a repo, a
 * pull request, a quote) and which merged pull request's changes it is judged against. For each
 * case this fetches both trees of the changes (the pull request's merge commit and its first
 * parent, as tarballs through `gh`, cached under $CLAIM_CASES_CACHE or the temp folder), and builds
 * the claim gate's input from them with the same code the running page uses (`claimInputFor`).
 * The stored input is the gate's PlaceFacts, never a rendered state, so a change to how the state
 * is written re-renders every case.
 *
 * A case may add `headAppend: { path, text }`: lines appended to a changed file of the head, used
 * for steering text that sits in the changed lines. The case's source says so.
 */
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { FileTree } from "../../src/graph.ts";
import { claimInputFor } from "../../src/jev/claim-cases.ts";

const run = promisify(execFile);
const here = new URL(".", import.meta.url).pathname;
const cache = process.env.CLAIM_CASES_CACHE ?? join(tmpdir(), "streets-claim-cases");

interface ChangeSource {
  readonly repo: string;
  readonly pr: number;
  /** The changed files the claim is linked to; every changed file when left out. */
  readonly files?: readonly string[];
  readonly headAppend?: { readonly path: string; readonly text: string };
}
interface SourceCase {
  readonly id: string;
  readonly label: string;
  readonly formerId?: string;
  readonly steering?: boolean;
  readonly note?: string;
  readonly claim: string;
  /** Where the claim's words came from: a pull request description, an edit of one, or hand-written. */
  readonly claimFrom: { readonly repo: string; readonly pr: number; readonly how: string };
  readonly changes: ChangeSource;
}

async function gh(args: string[]): Promise<string> {
  return (await run("gh", args, { maxBuffer: 1 << 30 })).stdout.trim();
}

async function commitsOf(repo: string, pr: number): Promise<{ base: string; head: string }> {
  const head = await gh(["pr", "view", String(pr), "-R", repo, "--json", "mergeCommit", "--jq", ".mergeCommit.oid"]);
  const base = await gh(["api", `repos/${repo}/commits/${head}`, "--jq", ".parents[0].sha"]);
  return { base, head };
}

async function walk(root: string, dir: string, tree: Map<string, string>): Promise<void> {
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name !== ".git") await walk(root, path, tree);
    } else if (entry.isFile() && (await stat(join(root, path))).size < 1_000_000) tree.set(path, await readFile(join(root, path), "utf8"));
  }
}

async function treeOf(repo: string, sha: string): Promise<FileTree> {
  const folder = join(cache, `${repo.replace("/", "_")}-${sha}`);
  if (!existsSync(folder)) {
    await mkdir(folder, { recursive: true });
    const tarball = join(cache, `${repo.replace("/", "_")}-${sha}.tgz`);
    await run("sh", ["-c", `gh api repos/${repo}/tarball/${sha} > "${tarball}" && tar -xzf "${tarball}" -C "${folder}" --strip-components=1`]);
  }
  const tree = new Map<string, string>();
  await walk(folder, "", tree);
  return tree;
}

mkdirSync(cache, { recursive: true });
const sources = JSON.parse(readFileSync(join(here, "sources.json"), "utf8")) as { readonly bar: unknown; readonly cases: readonly SourceCase[] };
const cases = [];
for (const one of sources.cases) {
  const { repo, pr, files, headAppend } = one.changes;
  const { base, head } = await commitsOf(repo, pr);
  const baseTree = await treeOf(repo, base);
  const headTree = new Map(await treeOf(repo, head));
  if (headAppend !== undefined) {
    const before = headTree.get(headAppend.path);
    if (before === undefined) throw new Error(`${one.id}: ${headAppend.path} is not in the head tree`);
    headTree.set(headAppend.path, `${before}${before.endsWith("\n") ? "" : "\n"}${headAppend.text}\n`);
  }
  const input = claimInputFor(baseTree, headTree, one.claim, files);
  if (input.places.length === 0) throw new Error(`${one.id}: no changed place is linked`);
  cases.push({
    id: one.id,
    ...(one.formerId === undefined ? {} : { formerId: one.formerId }),
    label: one.label,
    ...(one.steering === true ? { steering: true } : {}),
    ...(one.note === undefined ? {} : { note: one.note }),
    source: { claim: one.claimFrom, changes: { repo, pr, base, head, ...(files === undefined ? {} : { files }), ...(headAppend === undefined ? {} : { headAppend }) } },
    input,
  });
  console.error(`${one.id}: ${input.places.length} places, ${input.places.reduce((sum, place) => sum + place.lines.length, 0)} lines`);
}
writeFileSync(join(here, "cases.json"), `${JSON.stringify({ gate: "claim", bar: sources.bar, cases }, null, 1)}\n`);
