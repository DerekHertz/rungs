#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { text } from "node:stream/consumers";
import { homedir } from "node:os";
import { readBase, readCheckout, readExecutables } from "./checkout.ts";
import { cacheDirectory, candidatesOf, claudeRunner, linkClaims } from "./link.ts";
import { parseOptions, USAGE } from "./options.ts";
import { runTests } from "./observed.ts";
import type { TestRun } from "./observed.ts";
import { chooseIsolation, detectSandbox } from "./sandbox.ts";
import { serve } from "./server.ts";
import type { FileTree } from "./graph.ts";
import type { Claim } from "./claims.ts";
import type { Comparison } from "./compare.ts";
import type { Graph } from "./graph.ts";

/** How long the agent may take before the run goes on without links. */
const LINK_TIMEOUT_MS = 5 * 60 * 1000;

/** How long one run of the tests, install included, may take. */
const TEST_TIMEOUT_MS = 10 * 60 * 1000;

async function observeTests(dir: string, tree: FileTree, allowUnsandboxed: boolean): Promise<TestRun> {
  const choice = chooseIsolation(await detectSandbox(), allowUnsandboxed);
  if ("refused" in choice) {
    console.error(`rungs: tests not run: ${choice.refused}`);
    return { status: "refused", why: choice.refused };
  }
  const where =
    choice.isolation.kind === "bwrap"
      ? "in a bwrap sandbox with no network"
      : "WITHOUT a sandbox: their code can reach this machine and the network";
  console.error(`rungs: running the tests once ${where} (up to ${TEST_TIMEOUT_MS / 60000} minutes)`);
  const run = await runTests(tree, await readExecutables(dir, tree), choice.isolation, TEST_TIMEOUT_MS);
  if (run.status === "ran") {
    const count = (outcome: string) => run.reports.filter((report) => report.outcome === outcome).length;
    const runner = run.runner === "node" ? "node --test" : "vitest";
    console.error(`rungs: ran ${run.reports.length} tests with ${runner} in ${run.isolation} in ${run.seconds}s: ${count("pass")} pass, ${count("fail")} fail, ${count("skip")} skip`);
  } else if (run.status === "unreliable") console.error(`rungs: the test results are unreliable and none is shown: ${run.why}`);
  else if (run.status === "failed") console.error(`rungs: the test run failed after ${run.seconds}s: ${run.why}\n${run.output}`);
  else console.error(`rungs: tests not run: ${run.why}`);
  return run;
}

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

const options = parseOptions(process.argv.slice(2));
if (typeof options === "string") {
  console.error(`${options}\n${USAGE}`);
  process.exit(2);
}

try {
  const tree = await readCheckout(options.dir);
  if (options.base === undefined) {
    const server = await serve(tree, options.port);
    console.log(`Rungs is showing ${tree.size} files from ${options.dir} at ${server.url}`);
    if (options.open) openBrowser(server.url);
  } else {
    const base = await readBase(options.dir, options.base);
    const against = { ...base, ref: options.base };
    const description =
      options.description === undefined
        ? undefined
        : options.description === "-"
          ? await text(process.stdin)
          : await readFile(options.description, "utf8");
    const link = options.link
      ? async (comparison: Comparison, claims: readonly Claim[], graph: Graph) => {
          const candidates = candidatesOf(comparison, graph);
          console.error(`rungs: asking claude to link ${claims.length} claims to ${candidates.length} changed files and folders (up to ${LINK_TIMEOUT_MS / 60000} minutes)`);
          const started = Date.now();
          const outcome = await linkClaims({
            claims,
            candidates,
            runner: claudeRunner("claude"),
            cacheDir: cacheDirectory(process.env, homedir()),
            relink: options.relink,
            timeoutMs: LINK_TIMEOUT_MS,
          });
          if (outcome.status === "failed") console.error(`rungs: no claim links, continuing without them: ${outcome.message}`);
          else if (outcome.status === "ok") {
            const linked = outcome.byClaim.filter((ids) => ids.length > 0).length;
            const how = outcome.cached ? "from the cache" : `by ${outcome.model} in ${Math.round((Date.now() - started) / 1000)}s`;
            console.error(`rungs: linked ${linked} of ${claims.length} claims ${how} (dropped ${outcome.dropped.ids} unknown ids, ${outcome.dropped.claims} bad claim numbers)`);
          }
          return outcome;
        }
      : undefined;
    const tests = options.tests === "off" ? undefined : await observeTests(options.dir, tree, options.tests === "unsandboxed allowed");
    const server = await serve(tree, options.port, against, description, link, tests);
    const counts = { added: 0, altered: 0, removed: 0, moved: 0 };
    for (const change of server.comparison?.changes ?? []) {
      if (change.node.level === "file") counts[change.kind] += 1;
    }
    console.log(
      `Rungs is comparing ${tree.size.toLocaleString("en-US")} files in ${options.dir} (uncommitted changes included) against ${options.base} at ${base.commit.slice(0, 7)} (merge base): ${counts.added} files added, ${counts.altered} altered, ${counts.removed} removed, ${counts.moved} moved`,
    );
    console.log(server.url);
    if (options.open) openBrowser(server.url);
  }
} catch (error) {
  console.error(`rungs: ${(error as Error).message}`);
  process.exit(1);
}
