import { createHash } from "node:crypto";
import { relative } from "node:path";
import { isCodeNode } from "./graph.ts";
import type { FileTree, Graph, NodeId } from "./graph.ts";
import { runIsolated } from "./sandbox.ts";
import type { Isolation, Places, Step } from "./sandbox.ts";

export type Outcome = "pass" | "fail" | "skip";
export type Runner = "node" | "vitest";

/** One test as its runner reported it: the titles of its suites, then its own. */
export interface TestReport {
  /** Relative to the tree's root. */
  readonly file: string;
  /** Empty for a file that failed outside any test. */
  readonly path: readonly string[];
  readonly outcome: Outcome;
  readonly ms: number;
  /** A failure's message, as the runner gave it. */
  readonly message?: string;
}

/** What one run of a tree's tests came to, before it is attached to the graph. */
export type TestRun =
  | { readonly status: "refused" | "unsupported"; readonly why: string }
  | {
      readonly status: "failed";
      readonly why: string;
      readonly runner: Runner;
      readonly isolation: Isolation["kind"];
      readonly seconds: number;
      /** The end of what the run printed. */
      readonly output: string;
    }
  | {
      readonly status: "ran";
      readonly runner: Runner;
      readonly isolation: Isolation["kind"];
      readonly seconds: number;
      readonly exitCode: number;
      readonly reports: readonly TestReport[];
    };

export interface ObservedTest {
  /** The suite titles and the test's own, joined with " > ". */
  readonly name: string;
  readonly outcome: Outcome;
  readonly ms: number;
  readonly message?: string;
}

export interface UnmatchedTest extends ObservedTest {
  readonly file: string;
  readonly why: string;
}

export interface Counts {
  readonly pass: number;
  readonly fail: number;
  readonly skip: number;
}

/**
 * Observed facts, served at /observed.json: one run of one tree, keyed by the tree's digest and
 * kept apart from the graph. `tests` attaches results to test function nodes by id; a result no
 * single test function matches is listed in `unmatched` with why.
 */
export type ObservedDocument = { readonly tier: "observed"; readonly tree: string } & (
  | { readonly status: "refused" | "unsupported"; readonly why: string }
  | {
      readonly status: "failed";
      readonly why: string;
      readonly runner: Runner;
      readonly sandbox: Isolation["kind"];
      readonly seconds: number;
      readonly output: string;
    }
  | {
      readonly status: "ran";
      readonly runner: Runner;
      readonly sandbox: Isolation["kind"];
      readonly seconds: number;
      readonly exitCode: number;
      readonly counts: Counts;
      readonly tests: Readonly<Record<string, readonly ObservedTest[]>>;
      readonly unmatched: readonly UnmatchedTest[];
    }
);

export type Detection = { readonly runner: Runner; readonly args: readonly string[]; readonly install: boolean } | { readonly unsupported: string };

const SHELL = /[;&|<>$`'"\\(){}!]/;
const READ = "Rungs reads only node --test and vitest";

/** The runner the tree's `test` script names, with the arguments it passes; never a guess. */
export function detectRunner(tree: FileTree): Detection {
  const text = tree.get("package.json");
  if (text === undefined) return { unsupported: "the tree has no package.json" };
  let manifest: { scripts?: { test?: unknown }; dependencies?: object; devDependencies?: object };
  try {
    manifest = JSON.parse(text);
  } catch {
    return { unsupported: "package.json is not valid JSON" };
  }
  const script = manifest.scripts?.test;
  if (typeof script !== "string") return { unsupported: "package.json has no test script" };
  const words = script.trim().split(/\s+/).map((word) => /^(['"])[^'"\s]*\1$/.test(word) ? word.slice(1, -1) : word);
  const [command = "", ...rest] = words;
  if (words.some((word, index) => SHELL.test(word) || (index === 0 && word.includes("=")))) {
    return { unsupported: `the test script is not one plain command: ${JSON.stringify(script)}` };
  }
  const install = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).length > 0;
  if (install && !tree.has("package-lock.json") && !tree.has("npm-shrinkwrap.json")) {
    return { unsupported: "package.json has dependencies but no package-lock.json; Rungs installs only from a lockfile" };
  }
  if (command === "node") {
    if (!rest.includes("--test")) return { unsupported: `the test script runs "node" without --test; ${READ}` };
    return { runner: "node", args: rest.filter((word) => word !== "--test" && !word.startsWith("--test-reporter")), install };
  }
  if (command === "vitest") {
    const args = rest.filter((word, index) => !(index === 0 && ["run", "watch", "dev"].includes(word)) && !["--run", "--watch"].includes(word));
    return { runner: "vitest", args: args.filter((word) => !word.startsWith("--reporter") && !word.startsWith("--outputFile")), install };
  }
  return { unsupported: `the test script runs ${JSON.stringify(command)}; ${READ}` };
}

/** A node test reporter that writes each finished test or suite as one JSON line. */
const NODE_REPORTER = `import { realpathSync } from "node:fs";
import { relative } from "node:path";
const where = (file) => { try { return relative(process.cwd(), realpathSync(file)); } catch { return relative(process.cwd(), file); } };
export default async function* reporter(source) {
  for await (const { type, data } of source) {
    if (type !== "test:pass" && type !== "test:fail") continue;
    const error = data.details?.error;
    yield JSON.stringify({
      type,
      file: typeof data.file === "string" ? where(data.file) : "",
      name: data.name,
      nesting: data.nesting,
      kind: data.details?.type ?? "test",
      ms: data.details?.duration_ms ?? 0,
      ...(data.skip !== undefined && data.skip !== false ? { skip: true } : {}),
      ...(data.todo !== undefined && data.todo !== false ? { todo: true } : {}),
      ...(type === "test:fail" ? { error: String(error?.cause?.message ?? error?.message ?? "") } : {}),
    }) + "\\n";
  }
}
`;

const RESULTS: Record<Runner, string> = { node: "node.jsonl", vitest: "vitest.json" };

function stepsOf(detection: Extract<Detection, { runner: Runner }>, places: Places): Step[] {
  const install: Step[] = detection.install
    ? [{ argv: [places.node, places.npm, "ci", "--ignore-scripts", "--no-audit", "--no-fund"], network: true }]
    : [];
  const results = `${places.out}/${RESULTS[detection.runner]}`;
  const test =
    detection.runner === "node"
      ? [places.node, "--test", `--test-reporter=${places.tools}/reporter.mjs`, `--test-reporter-destination=${results}`, "--test-reporter=spec", "--test-reporter-destination=stdout"]
      : ["node_modules/.bin/vitest", "run", "--reporter=json", `--outputFile.json=${results}`, "--reporter=default"];
  return [...install, { argv: [...test, ...detection.args], network: false }];
}

const OUTPUT_TAIL = 8000;

/**
 * Runs the tree's tests once under `isolation`: dependencies from the lockfile with the network
 * and with install scripts off, then the tests with no network at all.
 */
export async function runTests(tree: FileTree, isolation: Isolation, timeoutMs: number): Promise<TestRun> {
  const detection = detectRunner(tree);
  if ("unsupported" in detection) return { status: "unsupported", why: detection.unsupported };
  const started = Date.now();
  const run = await runIsolated({
    tree,
    isolation,
    tools: new Map([["reporter.mjs", NODE_REPORTER]]),
    steps: (places) => stepsOf(detection, places),
    collect: [RESULTS[detection.runner]],
    timeoutMs,
    outputBytes: 1 << 20,
  });
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  const output = run.steps.map((step) => step.output).join("").slice(-OUTPUT_TAIL);
  const failed = (why: string): TestRun => ({ status: "failed", why, runner: detection.runner, isolation: isolation.kind, seconds, output });
  const last = run.steps.at(-1);
  if (last === undefined) return failed("nothing ran");
  if (last.timedOut) return failed(`the run passed its limit of ${Math.round(timeoutMs / 1000)} seconds`);
  if (detection.install && run.steps.length === 1) return failed(`npm ci --ignore-scripts exited ${last.exitCode}`);
  const results = run.collected.get(RESULTS[detection.runner]);
  if (results === undefined || results.kind === "missing") return failed(`the runner wrote no results (exit ${last.exitCode})`);
  if (results.kind === "too large") return failed(`the runner's results are too large to read (${results.bytes} bytes)`);
  if (results.kind === "unreadable") return failed(`the runner's results are unreadable: ${results.why}`);
  try {
    const reports = detection.runner === "node" ? parseNodeEvents(results.text) : parseVitestJson(results.text, run.places.work);
    return { status: "ran", runner: detection.runner, isolation: isolation.kind, seconds, exitCode: last.exitCode ?? 1, reports };
  } catch (error) {
    return failed((error as Error).message);
  }
}

interface NodeEvent {
  readonly type: "test:pass" | "test:fail";
  readonly file: string;
  readonly name: string;
  readonly nesting: number;
  readonly kind: string;
  readonly ms: number;
  readonly skip?: boolean;
  readonly todo?: boolean;
  readonly error?: string;
}

function isNodeEvent(value: unknown): value is NodeEvent {
  const event = value as Partial<NodeEvent> | null;
  return (
    typeof event === "object" &&
    event !== null &&
    (event.type === "test:pass" || event.type === "test:fail") &&
    typeof event.file === "string" &&
    typeof event.name === "string" &&
    Number.isInteger(event.nesting) &&
    typeof event.kind === "string" &&
    typeof event.ms === "number" &&
    [event.skip, event.todo].every((flag) => flag === undefined || typeof flag === "boolean") &&
    (event.error === undefined || typeof event.error === "string")
  );
}

/**
 * The tests in the reporter's lines. A test or suite finishes after the tests inside it, so each
 * one, as it finishes, is the next title up for the unclaimed tests one level deeper in its file.
 */
export function parseNodeEvents(text: string): TestReport[] {
  const reports: { report: TestReport; path: string[] }[] = [];
  const open = new Map<string, { nesting: number; path: string[] }[]>();
  text.split("\n").forEach((line, index) => {
    if (line.trim() === "") return;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      event = undefined;
    }
    if (!isNodeEvent(event)) throw new Error(`unreadable test event on line ${index + 1}`);
    const waiting = open.get(event.file) ?? [];
    open.set(event.file, waiting);
    for (const inner of waiting) {
      if (inner.nesting !== event.nesting + 1) continue;
      inner.path.unshift(event.name);
      inner.nesting = event.nesting;
    }
    const path = [event.name];
    waiting.push({ nesting: event.nesting, path });
    if (event.kind === "suite") return;
    const outcome: Outcome = event.skip || event.todo ? "skip" : event.type === "test:pass" ? "pass" : "fail";
    const report = { file: event.file, path, outcome, ms: event.ms, ...(outcome === "fail" && event.error ? { message: event.error } : {}) };
    reports.push({ report, path });
  });
  return reports.map(({ report, path }) => ({ ...report, path: [...path] }));
}

interface VitestFile {
  readonly name: string;
  readonly status: string;
  readonly message?: string;
  readonly assertionResults: readonly {
    readonly ancestorTitles: readonly string[];
    readonly title: string;
    readonly status: string;
    readonly duration?: number | null;
    readonly failureMessages?: readonly string[];
  }[];
}

const VITEST_OUTCOME: Readonly<Record<string, Outcome>> = { passed: "pass", failed: "fail", skipped: "skip", pending: "skip", todo: "skip", disabled: "skip" };

/** The tests in vitest's JSON report, with paths relative to `root`, the folder it ran in. */
export function parseVitestJson(text: string, root: string): TestReport[] {
  const json = JSON.parse(text) as { testResults?: unknown };
  if (!Array.isArray(json.testResults)) throw new Error("vitest's report has no testResults");
  const reports: TestReport[] = [];
  for (const file of json.testResults as VitestFile[]) {
    if (typeof file?.name !== "string" || !Array.isArray(file.assertionResults)) throw new Error("vitest's report holds an unreadable file entry");
    const path = relative(root, file.name);
    for (const result of file.assertionResults) {
      const outcome = VITEST_OUTCOME[result?.status];
      if (outcome === undefined || typeof result.title !== "string" || !Array.isArray(result.ancestorTitles)) {
        throw new Error(`vitest's report holds an unreadable test in ${path}`);
      }
      const message = outcome === "fail" ? result.failureMessages?.join("\n") : undefined;
      reports.push({ file: path, path: [...result.ancestorTitles, result.title], outcome, ms: result.duration ?? 0, ...(message ? { message } : {}) });
    }
    if (file.status === "failed" && file.assertionResults.length === 0) {
      reports.push({ file: path, path: [], outcome: "fail", ms: 0, ...(file.message ? { message: file.message } : {}) });
    }
  }
  return reports;
}

/** sha256 of the tree's paths and texts, first 32 hex digits, like a file's digest. */
export function treeDigest(tree: FileTree): string {
  const hash = createHash("sha256");
  for (const path of [...tree.keys()].sort()) hash.update(`${JSON.stringify(path)}:${JSON.stringify(tree.get(path))}\n`);
  return hash.digest("hex").slice(0, 32);
}

const TEST_CALLEES = new Set(["test", "it", "describe", "suite", "context", "skip", "only", "todo", "concurrent", "sequential", "fails"]);
const CALLBACK = /^([\w$]+)\(("(?:[^"\\]|\\.)*")\) callback$/;
const MESSAGE_LIMIT = 2000;

/** The (text, ordinal) pairs of a qualified name, as graph.ts's qualifiedName writes them. */
function segments(name: string): string[] {
  const texts: string[] = [];
  let rest = name;
  while (rest !== "") {
    const quoted = /^"(?:[^"\\]|\\.)*"/.exec(rest)?.[0];
    const head = quoted ?? /^[^.@]+/.exec(rest)?.[0] ?? rest;
    texts.push(quoted === undefined ? head : (JSON.parse(quoted) as string));
    rest = rest.slice(head.length).replace(/^@\d+/, "").replace(/^\./, "");
  }
  return texts;
}

/** The titles a test function is reported under, or undefined when any level is not a test or suite call. */
function titlesOf(qualifiedName: string): string[] | undefined {
  const titles: string[] = [];
  for (const text of segments(qualifiedName)) {
    const match = CALLBACK.exec(text);
    if (match === null || !TEST_CALLEES.has(match[1] ?? "")) return undefined;
    titles.push(JSON.parse(match[2] ?? '""') as string);
  }
  return titles;
}

/** Attaches a run's reports to the graph's test functions, by file and name; never changes the graph. */
export function observedDocument(run: TestRun, graph: Graph, tree: string): ObservedDocument {
  if (run.status === "failed") {
    const { isolation, ...rest } = run;
    return { tier: "observed", tree, ...rest, sandbox: isolation };
  }
  if (run.status !== "ran") return { tier: "observed", tree, status: run.status, why: run.why };
  const byFile = new Map<string, Map<string, NodeId[]>>();
  for (const node of graph.nodes) {
    if (!isCodeNode(node) || node.level !== "function") continue;
    const titles = titlesOf(node.qualifiedName);
    if (titles === undefined) continue;
    const named = byFile.get(node.path) ?? new Map<string, NodeId[]>();
    byFile.set(node.path, named);
    const key = JSON.stringify(titles);
    named.set(key, [...(named.get(key) ?? []), node.id]);
  }
  const tests: Record<string, ObservedTest[]> = {};
  const unmatched: UnmatchedTest[] = [];
  const counts = { pass: 0, fail: 0, skip: 0 };
  for (const report of run.reports) {
    counts[report.outcome] += 1;
    const message = report.message?.slice(0, MESSAGE_LIMIT);
    const observed: ObservedTest = { name: report.path.join(" > "), outcome: report.outcome, ms: report.ms, ...(message ? { message } : {}) };
    const ids = byFile.get(report.file)?.get(JSON.stringify(report.path)) ?? [];
    const [id] = ids;
    if (ids.length === 1 && id !== undefined) (tests[id] ??= []).push(observed);
    else {
      const why =
        report.path.length === 0
          ? "the file failed outside any test"
          : ids.length === 0
            ? "no test function in the file has this name"
            : `${ids.length} test functions in the file have this name`;
      unmatched.push({ file: report.file, ...observed, why });
    }
  }
  return { tier: "observed", tree, status: "ran", runner: run.runner, sandbox: run.isolation, seconds: run.seconds, exitCode: run.exitCode, counts, tests, unmatched };
}
