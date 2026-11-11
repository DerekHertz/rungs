import { createHash } from "node:crypto";
import { isCodeNode } from "./graph.ts";
import type { FileTree, Graph, NodeId } from "./graph.ts";
import { isTestFile } from "./test-files.ts";
import { runIsolated } from "./sandbox.ts";
import type { Isolation, Places } from "./sandbox.ts";
import type { ObservedDocument, ObservedTest, Outcome, Runner, UnmatchedTest, WrittenDocument } from "./observed-types.ts";

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
  /** The suite itself failed, in a hook or its setup, not one of its tests. */
  readonly suite?: true;
}

/** One run of node --test as it came out: results the runner wrote, none, or results that cannot be told from forged ones. */
export type Once =
  | { readonly status: "failed"; readonly why: string; readonly output: string }
  | { readonly status: "unreliable"; readonly why: string; readonly exitCode: number }
  | { readonly status: "ran"; readonly exitCode: number; readonly reports: readonly TestReport[] };

/** The tests this PR wrote or edited, run by themselves. They are the PR's own claim about its code, never evidence. */
export interface WrittenRun {
  readonly files: readonly string[];
  readonly seconds: number;
  readonly outcome: Once;
}

/**
 * What running a change's tests came to, before it is attached to the graph. The tests that count
 * are the base's (`reports`), run against the head's code. `deleted` are base test files the head
 * no longer has, which were run anyway; `edited` are base test files whose head version differs,
 * and the base's version is what ran.
 */
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
      /** The results contradict the runner or each other, so none of them is passed on. */
      readonly status: "unreliable";
      readonly why: string;
      readonly runner: Runner;
      readonly isolation: Isolation["kind"];
      readonly seconds: number;
      readonly exitCode: number;
    }
  | {
      readonly status: "ran";
      readonly runner: Runner;
      readonly isolation: Isolation["kind"];
      readonly seconds: number;
      readonly exitCode: number;
      readonly reports: readonly TestReport[];
      readonly deleted: readonly string[];
      readonly edited: readonly string[];
      readonly written?: WrittenRun;
    };

/** The runner the base's `test` script names, with the arguments it passes. */
export type Detection = { readonly runner: Runner; readonly args: readonly string[] } | { readonly unsupported: string };

const SHELL = /[;&|<>$`'"\\(){}!]/;
/**
 * The node flags a test script may pass. The runner's report is only its own while none of the
 * tree's code runs inside the runner: each test file gets a process of its own, and nothing is
 * preloaded. So a flag that loads code (--import, --require, --loader) or runs the tests in the
 * runner (--experimental-test-isolation) is not on the list, and neither is any flag not known.
 */
const NODE_FLAGS =
  /^--(?:test-concurrency|test-timeout|test-name-pattern|test-skip-pattern|test-only|test-force-exit|test-shard|test-update-snapshots|experimental-test-coverage|experimental-strip-types|experimental-transform-types|enable-source-maps|no-warnings)(?:=|$)/;
const READ = "Rungs reads only node --test";
const VITEST = "vitest is chosen by the PR";

/**
 * The runner the base's `test` script names, with the arguments it passes; never a guess. It is
 * read from the base, because the head's script is the PR's to change. vitest is a dependency the
 * PR installs at a version and with a config the PR picks, so its results come from code the PR
 * chose, and it is not run.
 */
export function detectRunner(base: FileTree): Detection {
  const text = base.get("package.json");
  if (text === undefined) return { unsupported: "the base has no package.json" };
  let manifest: { scripts?: { test?: unknown } };
  try {
    manifest = JSON.parse(text);
  } catch {
    return { unsupported: "the base's package.json is not valid JSON" };
  }
  const script = manifest.scripts?.test;
  if (typeof script !== "string") return { unsupported: "the base's package.json has no test script" };
  const words = script.trim().split(/\s+/).map((word) => /^(['"])[^'"\s]*\1$/.test(word) ? word.slice(1, -1) : word);
  const [command = "", ...rest] = words;
  if (words.some((word, index) => SHELL.test(word) || (index === 0 && word.includes("=")))) {
    return { unsupported: `the test script is not one plain command: ${JSON.stringify(script)}` };
  }
  if (command === "vitest") return { unsupported: VITEST };
  if (command === "node") {
    if (!rest.includes("--test")) return { unsupported: `the test script runs "node" without --test; ${READ}` };
    const args = rest.filter((word) => word !== "--test" && !word.startsWith("--test-reporter"));
    const flag = args.find((word) => word.startsWith("-") && !NODE_FLAGS.test(word));
    if (flag !== undefined) {
      return { unsupported: `the test script gives node ${JSON.stringify(flag)}; Rungs runs node --test only with flags that keep the tree's code out of the runner` };
    }
    return { runner: "node", args };
  }
  return { unsupported: `the test script runs ${JSON.stringify(command)}; ${READ}` };
}

/**
 * Whether the head's dependencies must be installed, or why they cannot be. The dependencies are
 * the head's, because they are what the head's code runs on.
 */
export function installNeeded(head: FileTree): { readonly install: boolean } | { readonly unsupported: string } {
  let manifest: { dependencies?: object; devDependencies?: object };
  try {
    manifest = JSON.parse(head.get("package.json") ?? "");
  } catch {
    return { unsupported: "the head's package.json is not valid JSON" };
  }
  const install = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).length > 0;
  if (install && !head.has("package-lock.json") && !head.has("npm-shrinkwrap.json")) {
    return { unsupported: "package.json has dependencies but no package-lock.json; Rungs installs only from a lockfile" };
  }
  return { install };
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
      ...(type === "test:fail" ? { error: String(error?.cause?.message ?? error?.message ?? ""), failure: String(error?.failureType ?? "") } : {}),
    }) + "\\n";
  }
}
`;

/** Where dependencies come from unless a caller names another registry. */
export const NPM_REGISTRY = "https://registry.npmjs.org/";

const DEPENDENCY_TABLES = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;
/** The parts of a lockfile entry npm needs to place a registry package; nothing else is passed on. */
const ENTRY_KEYS = [
  "name", "version", "resolved", "integrity", "dev", "optional", "devOptional", "peer", "inBundle", "hasInstallScript", "license",
  "bin", "engines", "os", "cpu", "libc", "dependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta", "bundleDependencies",
] as const;
const PLAIN_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SHA512 = /^sha512-[A-Za-z0-9+/]{86}==$/;
const NAME = String.raw`(?:@[a-z0-9~][a-z0-9._~-]*/)?[a-z0-9~][a-z0-9._~-]*`;
const INSTALLED = new RegExp(`^node_modules/${NAME}(?:/node_modules/${NAME})*$`, "i");
const ALIAS = new RegExp(`^npm:${NAME}(?:@|$)`, "i");

class Refusal extends Error {}

const quoted = (value: unknown): string => {
  const text = JSON.stringify(value) ?? "nothing";
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
};

const isTable = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * True for what npm fetches from the registry alone: a version, a range or a tag, perhaps of
 * another registry name. Anything with a scheme or a path (git, GitHub, a URL, a file, a folder)
 * is not, because npm would go and fetch it, and for git run a program to do so.
 */
function isRegistrySpec(spec: unknown): spec is string {
  return typeof spec === "string" && /^[\w.+~^<>=|* -]*$/.test(spec.replace(ALIAS, ""));
}

/** A table of dependencies, each asked for from the registry. */
function registryTable(value: unknown, what: string, whose: string): Record<string, string> {
  if (!isTable(value)) throw new Refusal(`${whose}'s ${what} are not a table of names and versions`);
  for (const [name, spec] of Object.entries(value)) {
    if (!isRegistrySpec(spec)) throw new Refusal(`${whose} asks for ${quoted(name)} from ${quoted(spec)}, which is not a registry version`);
  }
  return value as Record<string, string>;
}

function registryOverrides(value: unknown): unknown {
  if (typeof value === "string") {
    if (!value.startsWith("$") && !isRegistrySpec(value)) throw new Refusal(`package.json overrides a dependency with ${quoted(value)}, which is not a registry version`);
    return value;
  }
  if (!isTable(value)) throw new Refusal("package.json's overrides are not a table of names and versions");
  for (const [key, inner] of Object.entries(value)) {
    const at = key.lastIndexOf("@");
    const [name, spec] = at > 0 ? [key.slice(0, at), key.slice(at + 1)] : [key, ""];
    if (!isRegistrySpec(spec)) throw new Refusal(`package.json asks for ${quoted(name)} from ${quoted(spec)}, which is not a registry version`);
    if (typeof inner === "string" && !inner.startsWith("$") && !isRegistrySpec(inner)) {
      throw new Refusal(`package.json asks for ${quoted(name)} from ${quoted(inner)}, which is not a registry version`);
    }
    registryOverrides(inner);
  }
  return value;
}

/** The one lockfile entry as npm needs it, or a refusal when it is anything but a registry tarball with a hash. */
function registryEntry(file: string, key: string, entry: unknown, registry: string): Record<string, unknown> {
  if (key !== "" && !INSTALLED.test(key)) throw new Refusal(`${file}: ${quoted(key)} is a folder in the tree, not a package in node_modules`);
  const where = `${file}: ${key === "" ? "the root" : key}`;
  if (!isTable(entry)) throw new Refusal(`${where} is not an entry`);
  if (key !== "") {
    const { resolved, integrity, version } = entry;
    if (entry.link !== undefined && entry.link !== false) throw new Refusal(`${where} is a link to a folder`);
    if (resolved !== undefined || entry.inBundle !== true) {
      if (resolved === undefined) throw new Refusal(`${where} has no registry address`);
      if (typeof resolved !== "string" || !isRegistryTarball(resolved, registry)) {
        const kind = typeof resolved !== "string" ? "has an unreadable address" : /^git[+:]|^github:|\.git(?:#|$)/.test(resolved) ? "is a git dependency" : resolved.startsWith("file:") ? "is a file dependency" : "comes from outside the registry";
        throw new Refusal(`${where} ${kind} (${quoted(resolved)})`);
      }
      if (typeof integrity !== "string" || !SHA512.test(integrity)) throw new Refusal(`${where} has no sha512 integrity hash`);
    }
    if (typeof version !== "string" || !PLAIN_VERSION.test(version)) throw new Refusal(`${where} has no plain version`);
  }
  const kept: Record<string, unknown> = {};
  for (const name of key === "" ? (["name", "version", ...DEPENDENCY_TABLES, "peerDependenciesMeta", "bundleDependencies"] as const) : ENTRY_KEYS) {
    if (entry[name] === undefined) continue;
    kept[name] = (DEPENDENCY_TABLES as readonly string[]).includes(name) ? registryTable(entry[name], name, where) : entry[name];
  }
  return kept;
}

function isRegistryTarball(resolved: string, registry: string): boolean {
  if (!resolved.startsWith(registry)) return false;
  try {
    const url = new URL(resolved);
    return url.origin === new URL(registry).origin && url.username === "" && url.password === "" && url.pathname.endsWith(".tgz");
  } catch {
    return false;
  }
}

/**
 * The only two files the install is given, written by Rungs from what it checked: the tree's
 * dependencies and its lockfile's entries, each a registry tarball with a sha512 hash. Nothing
 * else of the tree goes near the network: no scripts, no settings, no program. A lockfile that
 * names anything npm would fetch another way (git, a file, a link, a folder, another server) is
 * refused, because npm runs a program to fetch from git.
 */
export function installFiles(tree: FileTree, registry: string = NPM_REGISTRY): { files: FileTree } | { refused: string } {
  const lockName = tree.has("npm-shrinkwrap.json") ? "npm-shrinkwrap.json" : "package-lock.json";
  try {
    const manifest = parseTable(tree.get("package.json"), "package.json");
    const asked: Record<string, unknown> = {};
    for (const name of ["name", "version"] as const) if (typeof manifest[name] === "string") asked[name] = manifest[name];
    for (const name of DEPENDENCY_TABLES) if (manifest[name] !== undefined) asked[name] = registryTable(manifest[name], name, "package.json");
    if (manifest.peerDependenciesMeta !== undefined) asked.peerDependenciesMeta = manifest.peerDependenciesMeta;
    if (manifest.overrides !== undefined) asked.overrides = registryOverrides(manifest.overrides);
    const lock = parseTable(tree.get(lockName), lockName);
    if (lock.lockfileVersion !== 2 && lock.lockfileVersion !== 3) {
      throw new Refusal(`${lockName} has lockfileVersion ${quoted(lock.lockfileVersion)}; Rungs installs only from versions 2 and 3`);
    }
    if (!isTable(lock.packages)) throw new Refusal(`${lockName} lists no packages`);
    const packages: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(lock.packages)) packages[key] = registryEntry(lockName, key, entry, registry);
    // The older `dependencies` table of a version 2 lockfile is left out: npm reads `packages`, and only that was checked.
    const checked = { name: lock.name, version: lock.version, lockfileVersion: 3, requires: true, packages };
    return { files: new Map([["package.json", `${JSON.stringify(asked, null, 2)}\n`], [lockName, `${JSON.stringify(checked, null, 2)}\n`]]) };
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    return { refused: error.message };
  }
}

function parseTable(text: string | undefined, name: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text ?? "");
  } catch {
    throw new Refusal(`${name} is not valid JSON`);
  }
  if (!isTable(value)) throw new Refusal(`${name} is not valid JSON`);
  return value;
}

/**
 * `npm ci` with every setting that could name a program or a place given here, so none is read
 * from a file or the environment: both config files are an empty file of ours, the registry is
 * the one the lockfile was checked against, and git, the shell and the script shell are a program
 * that does nothing. No package script runs, and a git dependency that slipped through fails.
 */
export function installArgv(places: Places, registry: string): string[] {
  const nothing = "/usr/bin/false";
  return [
    places.node,
    places.npm,
    "ci",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    `--userconfig=${places.tools}/npmrc-user`,
    `--globalconfig=${places.tools}/npmrc-global`,
    `--registry=${registry}`,
    `--git=${nothing}`,
    `--shell=${nothing}`,
    `--script-shell=${nothing}`,
  ];
}

const OUTPUT_TAIL = 8000;
const RUNNABLE = /\.[cm]?[jt]s$/;

/** Base test files and head test files, by the one list of what a test file is. */
function testPaths(tree: FileTree): string[] {
  return [...tree.keys()].filter(isTestFile).sort();
}

interface Job {
  readonly tree: FileTree;
  readonly executable: ReadonlySet<string>;
  /** Test files the steps may read and not change, and the only files whose results are believed. */
  readonly pinned: ReadonlySet<string>;
  readonly args: readonly string[];
  /** What the results may name: every test file the run was given. */
  readonly allowed: ReadonlySet<string>;
  readonly install: { readonly files: FileTree } | undefined;
}

/** One node --test run in its own sandbox: dependencies first, with the network, then the tests, with none. */
async function once(job: Job, isolation: Isolation, timeoutMs: number, registry: string): Promise<Once & { readonly seconds: number }> {
  const started = Date.now();
  const run = await runIsolated({
    tree: job.tree,
    executable: job.executable,
    pinned: job.pinned,
    isolation,
    // node's runner is ours and runs none of the tree's code, so it reports where the tests cannot write.
    tools: new Map([["reporter.mjs", NODE_REPORTER], ["npmrc-user", ""], ["npmrc-global", ""]]),
    ...(job.install === undefined ? {} : { install: { files: job.install.files, argv: (places: Places) => installArgv(places, registry) } }),
    steps: (places) => [
      {
        argv: [places.node, "--test", `--test-reporter=${places.tools}/reporter.mjs`, `--test-reporter-destination=${places.report}`, "--test-reporter=spec", "--test-reporter-destination=stdout", ...job.args],
      },
    ],
    report: true,
    timeoutMs,
    outputBytes: 1 << 20,
  });
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  const ran = [...(run.install === undefined ? [] : [run.install]), ...run.steps];
  const output = ran.map((step) => step.output).join("").slice(-OUTPUT_TAIL);
  const failed = (why: string): Once & { readonly seconds: number } => ({ status: "failed", why, output, seconds });
  const last = ran.at(-1);
  if (last === undefined) return failed("nothing ran");
  if (last.timedOut) return failed(`the run passed its limit of ${Math.round(timeoutMs / 1000)} seconds`);
  if (run.steps.length === 0) return failed(`npm ci --ignore-scripts exited ${last.exitCode}`);
  const results = run.report;
  if (results === undefined) return failed(`the runner wrote no results (exit ${last.exitCode})`);
  if (results.kind === "too large") return failed(`the runner's results are too large to read (${results.bytes} bytes)`);
  try {
    const reports = parseNodeEvents(results.text);
    const exitCode = last.exitCode ?? 1;
    const why = unreliable(reports, exitCode, job.allowed);
    return why === undefined ? { status: "ran", exitCode, reports, seconds } : { status: "unreliable", why, exitCode, seconds };
  } catch (error) {
    return failed((error as Error).message);
  }
}

/**
 * Runs a change's tests once under `isolation`, and the tests that count as evidence are the
 * base's. A test has to run the change's code, so the change controls whether its own tests pass:
 * it can loosen one, delete one, skip one, or add one that checks nothing. So the run takes every
 * test file from the base and puts them over the head's tree, mounted read-only where the sandbox
 * can, and runs them with the base's `test` script, so the head's script cannot swap the runner.
 * Base test files the head deleted are run too. The test files the change wrote or edited run in
 * a second run of their own, and are only the change's claim.
 *
 * The change's code still runs inside each test, and can fake the outcome from in there: this is
 * evidence against mistakes, not against a hostile author.
 */
export async function runTests(
  base: FileTree,
  head: FileTree,
  executable: ReadonlySet<string>,
  isolation: Isolation,
  timeoutMs: number,
  registry: string = NPM_REGISTRY,
): Promise<TestRun> {
  const detection = detectRunner(base);
  if ("unsupported" in detection) return { status: "unsupported", why: detection.unsupported };
  const needed = installNeeded(head);
  if ("unsupported" in needed) return { status: "unsupported", why: needed.unsupported };
  const install = needed.install ? installFiles(head, registry) : undefined;
  if (install !== undefined && "refused" in install) return { status: "refused", why: install.refused };
  const started = Date.now();
  const baseTests = testPaths(base);
  const tree = new Map([...head].filter(([path]) => !isTestFile(path)));
  for (const path of baseTests) tree.set(path, base.get(path) ?? "");
  const pinned = new Set(baseTests);
  const first = await once({ tree, executable, pinned, args: detection.args, allowed: pinned, install }, isolation, timeoutMs, registry);
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  const about = { runner: detection.runner, isolation: isolation.kind, seconds: first.seconds };
  if (first.status === "failed") return { status: "failed", why: first.why, output: first.output, ...about };
  if (first.status === "unreliable") return { status: "unreliable", why: first.why, exitCode: first.exitCode, ...about };
  const writtenFiles = testPaths(head).filter((path) => RUNNABLE.test(path) && head.get(path) !== base.get(path));
  let written: WrittenRun | undefined;
  if (writtenFiles.length > 0) {
    const flags = detection.args.filter((word) => word.startsWith("-"));
    const left = Math.max(1000, timeoutMs - (Date.now() - started));
    const { seconds: took, ...outcome } = await once(
      { tree: head, executable, pinned: new Set(), args: [...flags, ...writtenFiles], allowed: new Set(writtenFiles), install },
      isolation,
      left,
      registry,
    );
    written = { files: writtenFiles, seconds: took, outcome };
  }
  return {
    status: "ran",
    ...about,
    seconds,
    exitCode: first.exitCode,
    reports: first.reports,
    deleted: baseTests.filter((path) => !head.has(path)),
    edited: baseTests.filter((path) => head.has(path) && head.get(path) !== base.get(path)),
    ...(written === undefined ? {} : { written }),
  };
}

/**
 * Why a run's results cannot be shown as what happened, if they cannot. However the results reach
 * Rungs, they are checked against the one thing the tests do not write, the runner's exit code,
 * against the test files the run was given, and against each other. A run that fails any check is shown as unreliable,
 * never as passes.
 */
export function unreliable(reports: readonly TestReport[], exitCode: number, allowed: ReadonlySet<string>): string | undefined {
  if (exitCode !== 0 && exitCode !== 1) return `the runner exited ${exitCode}, which no test result explains`;
  const outcomes = new Map<string, Outcome>();
  let failures = 0;
  for (const report of reports) {
    if (!allowed.has(report.file)) return `a result names ${JSON.stringify(report.file.slice(0, 120))}, which is not a test file this run was given`;
    if (report.outcome === "fail") failures += 1;
    const key = JSON.stringify([report.file, report.path]);
    const before = outcomes.get(key);
    if (before !== undefined && before !== report.outcome) {
      return `two results for ${JSON.stringify(report.path.join(" > ").slice(0, 120))} in ${report.file} disagree (${before} and ${report.outcome})`;
    }
    outcomes.set(key, report.outcome);
  }
  if (exitCode !== 0 && failures === 0) return `the runner exited ${exitCode} but no failure was recorded`;
  if (exitCode === 0 && failures > 0) return `the runner exited 0 but ${failures} ${failures === 1 ? "failure was" : "failures were"} recorded`;
  return undefined;
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
  readonly failure?: string;
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
    (event.error === undefined || typeof event.error === "string") &&
    (event.failure === undefined || typeof event.failure === "string")
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
    // A suite that fails only because a test in it did is that test's failure; any other suite failure is its own.
    if (event.kind === "suite" && (event.type === "test:pass" || event.failure === "subtestsFailed")) return;
    const own = event.kind === "suite";
    const outcome: Outcome = event.skip || event.todo ? "skip" : event.type === "test:pass" ? "pass" : "fail";
    const report = { file: event.file, path, outcome, ms: event.ms, ...(outcome === "fail" && event.error ? { message: event.error } : {}), ...(own ? { suite: true as const } : {}) };
    reports.push({ report, path });
  });
  return reports.map(({ report, path }) => ({ ...report, path: [...path] }));
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

const SUITE_FAILED = "the suite failed outside its tests (a hook or setup)";
const EDITED = "main's version of this file ran; this PR edited it";
const DELETED = "main's test, run against this PR's code; this PR deleted the file";

/** What the tests the change wrote came to, labelled claimed. */
function writtenDocument(written: WrittenRun): WrittenDocument {
  const about = { tier: "claimed", files: written.files, seconds: written.seconds } as const;
  const { outcome } = written;
  if (outcome.status !== "ran") return { ...about, status: outcome.status, why: outcome.why };
  const counts = { pass: 0, fail: 0, skip: 0 };
  const tests = outcome.reports.map((report) => {
    counts[report.outcome] += 1;
    const message = report.message?.slice(0, MESSAGE_LIMIT);
    return { file: report.file, name: report.path.join(" > "), outcome: report.outcome, ms: report.ms, ...(message ? { message } : {}) };
  });
  return { ...about, status: "ran", exitCode: outcome.exitCode, counts, tests };
}

/**
 * Attaches a run's reports to the graph's test functions, by file and name; never changes the
 * graph. A report from a file the change edited or deleted is not attached: the graph is the
 * head's, and the test that ran was the base's.
 */
export function observedDocument(run: TestRun, graph: Graph, tree: string): ObservedDocument {
  if (run.status === "failed" || run.status === "unreliable") {
    const { isolation, ...rest } = run;
    return { tier: "observed", tree, ...rest, sandbox: isolation };
  }
  if (run.status !== "ran") return { tier: "observed", tree, status: run.status, why: run.why };
  const deleted = new Set(run.deleted);
  const edited = new Set(run.edited);
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
    const changed = report.suite ? SUITE_FAILED : deleted.has(report.file) ? DELETED : edited.has(report.file) ? EDITED : undefined;
    if (changed === undefined && ids.length === 1 && id !== undefined) (tests[id] ??= []).push(observed);
    else {
      const why =
        changed ??
        (report.path.length === 0
          ? "the file failed outside any test"
          : ids.length === 0
            ? "no test function in the file has this name"
            : `${ids.length} test functions in the file have this name`);
      unmatched.push({ file: report.file, ...observed, why });
    }
  }
  return {
    tier: "observed",
    tree,
    status: "ran",
    runner: run.runner,
    sandbox: run.isolation,
    seconds: run.seconds,
    exitCode: run.exitCode,
    counts,
    tests,
    unmatched,
    deleted: run.deleted,
    edited: run.edited,
    written: run.written === undefined ? null : writtenDocument(run.written),
  };
}
