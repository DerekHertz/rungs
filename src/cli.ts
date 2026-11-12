#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { text } from "node:stream/consumers";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { readBase, readCheckout, readExecutables } from "./checkout.ts";
import { cacheDirectory, candidatesOf, claudeRunner, linkClaims } from "./link.ts";
import { parseOptions, USAGE } from "./options.ts";
import type { Options } from "./options.ts";
import { servePicker } from "./picker.ts";
import { openPullRequest } from "./pull-request.ts";
import type { OpenedPullRequest } from "./pull-request.ts";
import { narrate } from "./narrate.ts";
import { runTests } from "./observed.ts";
import type { TestRun } from "./observed.ts";
import { EVIDENCE_LINE, UNSANDBOXED_LINE } from "./observed-types.ts";
import { chooseIsolation, detectSandbox } from "./sandbox.ts";
import { createSnapshot, serve } from "./server.ts";
import type { Narrator, SnapshotInputs } from "./server.ts";
import type { FileTree } from "./graph.ts";
import { placesOf } from "./tour.ts";
import { walkthrough } from "./walkthrough.ts";
import { judgedSource } from "./jev/source.ts";
import type { Claim } from "./claims.ts";
import type { Comparison } from "./compare.ts";
import type { Graph } from "./graph.ts";

/** How long the agent may take before the run goes on without links. */
const LINK_TIMEOUT_MS = 5 * 60 * 1000;
/** A tour is a longer answer than the links. */
const TOUR_TIMEOUT_MS = 10 * 60 * 1000;

/** How long one run of the tests, install included, may take. */
const TEST_TIMEOUT_MS = 10 * 60 * 1000;

async function observeTests(dir: string, base: FileTree, tree: FileTree, allowUnsandboxed: boolean, onControl: () => void, baseExecutable: ReadonlySet<string>): Promise<TestRun> {
  const choice = chooseIsolation(await detectSandbox(), allowUnsandboxed);
  if ("refused" in choice) {
    console.error(`streets: tests not run: ${choice.refused}`);
    return { status: "refused", why: choice.refused };
  }
  const where =
    choice.isolation.kind === "bwrap"
      ? "in a bwrap sandbox with no network"
      : `WITHOUT a sandbox: their code can reach this machine and the network, and the results are only as trustworthy as the PR's author`;
  console.error(`streets: running the base's tests once against the head's code ${where} (up to ${TEST_TIMEOUT_MS / 60000} minutes)`);
  const run = await runTests(base, tree, await readExecutables(dir, tree), choice.isolation, TEST_TIMEOUT_MS, undefined, () => {
    console.error("streets: running the control run: the same tests against main's own code");
    onControl();
  }, baseExecutable);
  const label = choice.isolation.kind === "bwrap" ? "" : ` (${UNSANDBOXED_LINE})`;
  if (run.status === "ran") {
    const count = (outcome: string) => run.reports.filter((report) => report.outcome === outcome).length;
    console.error(`streets: ran ${run.reports.length} tests with node --test in ${run.isolation} in ${run.seconds}s: ${count("pass")} pass, ${count("fail")} fail, ${count("skip")} skip${label}`);
    if (run.deleted.length > 0) console.error(`streets: ${run.deleted.length} of the base's test files were deleted by this PR and ran anyway: ${run.deleted.join(", ")}`);
    if (run.edited.length > 0) console.error(`streets: ${run.edited.length} of the base's test files were edited by this PR and their base versions ran: ${run.edited.join(", ")}`);
    if (run.written !== undefined) {
      const { outcome } = run.written;
      const said = outcome.status === "ran" ? `${outcome.reports.filter((report) => report.outcome === "fail").length} of ${outcome.reports.length} failed` : `${outcome.status}: ${outcome.why}`;
      console.error(`streets: tests written by this PR (${run.written.files.length} files, claimed, not evidence): ${said}`);
    }
    const { control } = run;
    if (control === undefined) console.error("streets: no control run was made, so no failure is known to be this PR's doing");
    else if (control.status !== "ran") console.error(`streets: no control run: ${control.why}; the failures above are not known to be this PR's doing`);
    else {
      const reported = (outcome: string) => control.reports.filter((report) => report.outcome === outcome).length;
      console.error(`streets: control run on main's own code in ${control.seconds}s: ${reported("pass")} pass, ${reported("fail")} fail, ${reported("skip")} skip`);
    }
    console.error(`streets: ${EVIDENCE_LINE}`);
  } else if (run.status === "unreliable") console.error(`streets: the test results are unreliable and none is shown: ${run.why}${label}`);
  else if (run.status === "failed") console.error(`streets: the test run failed after ${run.seconds}s: ${run.why}${label}\n${run.output}`);
  else console.error(`streets: tests not run: ${run.why}`);
  return run;
}

/** One function's narration is a short answer. */
const NARRATE_TIMEOUT_MS = 3 * 60 * 1000;

const OPENERS: Partial<Record<NodeJS.Platform, (url: string) => [string, string[]]>> = {
  darwin: (url) => ["open", [url]],
  win32: (url) => ["cmd", ["/c", "start", "", url]],
  linux: (url) => (process.env.WSL_DISTRO_NAME ? ["wslview", [url]] : ["xdg-open", [url]]),
};

function openBrowser(url: string): void {
  const opener = OPENERS[process.platform];
  if (opener === undefined) return;
  const [command, args] = opener(url);
  spawn(command, args, { stdio: "ignore", detached: true })
    .on("error", () => {})
    .unref();
}

const parsed = parseOptions(process.argv.slice(2));
if (typeof parsed === "string") {
  console.error(`${parsed}\n${USAGE}`);
  process.exit(2);
}

/** The scratch worktree of `--pr`, removed however this process ends. */
let opened: OpenedPullRequest | undefined;
/** Registered before the worktree exists, so an interrupt at any moment of opening still removes it. */
let cleanup: (() => void) | undefined;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    cleanup?.();
    process.exit(128 + { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 }[signal]);
  });
}
process.on("exit", () => cleanup?.());


const options: Options = parsed;
const cache = cacheDirectory(process.env, homedir());

/**
 * What a comparison page is drawn from, read once. `compare --pr N` and a pull request picked from
 * the list both come through here, so they draw the same page. `tests` is the run-tests choice:
 * a picked pull request always passes "off", because a fork's head is untrusted code.
 */
async function prepare(dir: string, baseRef: string, from: OpenedPullRequest | undefined, tests: Options["tests"]) {
  const tree = await readCheckout(dir);
  const base = await readBase(dir, baseRef);
  const against = { ...base, ref: from?.baseRef ?? baseRef, ...(from === undefined ? {} : { pr: { number: from.pr.number, title: from.pr.title, head: from.pr.head } }) };
  const description =
    from !== undefined
      ? from.description
      : options.description === undefined
        ? undefined
        : options.description === "-"
          ? await text(process.stdin)
          : await readFile(options.description, "utf8");
  const link = options.link
    ? async (comparison: Comparison, claims: readonly Claim[], graph: Graph) => {
        const candidates = candidatesOf(comparison, graph);
        console.error(`streets: asking claude to link ${claims.length} claims to ${candidates.length} changed files and folders (up to ${LINK_TIMEOUT_MS / 60000} minutes)`);
        const started = Date.now();
        const outcome = await linkClaims({
          claims,
          candidates,
          runner: claudeRunner("claude"),
          cacheDir: cache,
          relink: options.relink,
          timeoutMs: LINK_TIMEOUT_MS,
        });
        if (outcome.status === "failed") console.error(`streets: no claim links, continuing without them: ${outcome.message}`);
        else if (outcome.status === "ok") {
          const linked = outcome.byClaim.filter((ids) => ids.length > 0).length;
          const how = outcome.cached ? "from the cache" : `by ${outcome.model} in ${Math.round((Date.now() - started) / 1000)}s`;
          console.error(`streets: linked ${linked} of ${claims.length} claims ${how} (dropped ${outcome.dropped.ids} unknown ids, ${outcome.dropped.claims} bad claim numbers)`);
        }
        return outcome;
      }
    : undefined;
  const observed = tests === "off" ? undefined : (onControl: () => void) => observeTests(dir, base.tree, tree, tests === "unsandboxed allowed", onControl, base.executable);
  const walk = options.walkthrough
    ? async (comparison: Comparison, claims: readonly Claim[], graph: Graph) => {
        const places = placesOf(comparison, graph);
        console.error(`streets: asking claude for a walkthrough of ${places.length} changed files, classes and functions (up to ${TOUR_TIMEOUT_MS / 60000} minutes)`);
        const started = Date.now();
        const outcome = await walkthrough({
          claims,
          places,
          runner: claudeRunner("claude"),
          cacheDir: cache,
          rewalk: options.rewalk,
          timeoutMs: TOUR_TIMEOUT_MS,
        });
        if (outcome.status === "failed") console.error(`streets: no walkthrough, continuing without it: ${outcome.message}`);
        else if (outcome.status === "ok") {
          const how = outcome.cached ? "from the cache" : `by ${outcome.model} in ${Math.round((Date.now() - started) / 1000)}s`;
          const { stops, ids, claims: numbers, sentences } = outcome.dropped;
          console.error(`streets: walkthrough of ${outcome.stops.length} stops ${how} (dropped ${stops} stops, ${ids} unknown ids, ${numbers} bad claim numbers, ${sentences} unanchored sentences)`);
        }
        return outcome;
      }
    : undefined;
  const narrator: Narrator | undefined = options.narrate
    ? async (request) => {
        const outcome = await narrate({
          ...request,
          runner: claudeRunner("claude"),
          cacheDir: cache,
          renarrate: request.renarrate || options.renarrate,
          timeoutMs: NARRATE_TIMEOUT_MS,
        });
        if (outcome.status === "failed") console.error(`streets: no narration for ${request.node.id}: ${outcome.message}`);
        else {
          const how = outcome.cached ? "from the cache" : `by ${outcome.model}`;
          console.error(`streets: narrated ${request.node.id} in ${outcome.sentences.length} sentences ${how} (dropped ${outcome.dropped.sentences} unanchored sentences)`);
        }
        return outcome;
      }
    : undefined;
  const judged = judgedSource({ judge: options.judge, env: process.env, baseTree: base.tree, headTree: tree, cacheDir: cache });
  if (options.judge && judged.status === "off") console.error(`streets: ${judged.reason}`);
  const inputs: SnapshotInputs = [against, description, link, walk, narrator, observed, from?.repo ?? basename(resolve(options.dir)), judged];
  return { tree, base, inputs };
}

try {
  if (options.pr !== undefined) {
    opened = await openPullRequest({ number: options.pr, cwd: options.dir, cacheDir: cache, register: (removeSync) => (cleanup = removeSync) });
    if (opened.note !== undefined) console.error(`streets: ${opened.note}`);
  }
  const dir = opened?.dir ?? options.dir;
  const baseRef = opened === undefined ? options.base : opened.baseTip;
  if (baseRef === undefined) {
    // No PR and no base: the working tree, with a list of the repository's open pull requests to pick from.
    const tree = await readCheckout(dir);
    const repo = basename(resolve(options.dir));
    const plain = await createSnapshot(tree, undefined, undefined, undefined, undefined, undefined, undefined, repo);
    const picker = await servePicker({
      dir: options.dir,
      port: options.port,
      cacheDir: cache,
      plain,
      build: async (picked) => {
        if (picked.note !== undefined) console.error(`streets: ${picked.note}`);
        // A picked pull request's tests never run, whatever the flags: its head is untrusted code.
        const { tree: head, inputs } = await prepare(picked.dir, picked.baseTip, picked, "off");
        console.error(`streets: drew PR #${picked.pr.number} (${picked.pr.title}) at head ${picked.pr.head.slice(0, 7)} against ${picked.baseRef}`);
        return createSnapshot(head, ...inputs);
      },
    });
    cleanup = picker.removeAllSync;
    console.log(`Systems to Streets is showing ${tree.size} files from ${options.dir} at ${picker.url}`);
    if (options.open) openBrowser(picker.url);
  } else {
    const { tree, base, inputs } = await prepare(dir, baseRef, opened, options.tests);
    const server = await serve(tree, options.port, ...inputs);
    const counts = { added: 0, altered: 0, removed: 0, moved: 0 };
    for (const change of server.comparison?.changes ?? []) {
      if (change.node.level === "file") counts[change.kind] += 1;
    }
    const where =
      opened === undefined
        ? `in ${options.dir} (uncommitted changes included) against ${options.base}`
        : `of PR #${opened.pr.number} (${opened.pr.title}) at head ${opened.pr.head.slice(0, 7)} against ${opened.baseRef}`;
    console.log(
      `Systems to Streets is comparing ${tree.size.toLocaleString("en-US")} files ${where} at ${base.commit.slice(0, 7)} (merge base): ${counts.added} files added, ${counts.altered} altered, ${counts.removed} removed, ${counts.moved} moved`,
    );
    console.log(server.url);
    if (options.open) openBrowser(server.url);
  }
} catch (error) {
  console.error(`streets: ${(error as Error).message}`);
  cleanup?.();
  process.exit(1);
}
