import { createHash } from "node:crypto";
import { relative } from "node:path";
import { isCodeNode } from "./graph.ts";
import type { FileTree, Graph, NodeId } from "./graph.ts";
import { runIsolated } from "./sandbox.ts";
import type { Isolation, Places } from "./sandbox.ts";
import type { ObservedDocument, ObservedTest, Outcome, Runner, UnmatchedTest } from "./observed-types.ts";


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
    };

export type Detection = { readonly runner: Runner; readonly args: readonly string[]; readonly install: boolean } | { readonly unsupported: string };

const SHELL = /[;&|<>$`'"\\(){}!]/;
/**
 * The node flags a test script may pass. The runner's report is only its own while none of the
 * tree's code runs inside the runner: each test file gets a process of its own, and nothing is
 * preloaded. So a flag that loads code (--import, --require, --loader) or runs the tests in the
 * runner (--experimental-test-isolation) is not on the list, and neither is any flag not known.
 */
const NODE_FLAGS =
  /^--(?:test-concurrency|test-timeout|test-name-pattern|test-skip-pattern|test-only|test-force-exit|test-shard|test-update-snapshots|experimental-test-coverage|experimental-strip-types|experimental-transform-types|enable-source-maps|no-warnings)(?:=|$)/;
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
    const args = rest.filter((word) => word !== "--test" && !word.startsWith("--test-reporter"));
    const flag = args.find((word) => word.startsWith("-") && !NODE_FLAGS.test(word));
    if (flag !== undefined) {
      return { unsupported: `the test script gives node ${JSON.stringify(flag)}; Rungs runs node --test only with flags that keep the tree's code out of the runner` };
    }
    return { runner: "node", args, install };
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

const VITEST_RESULTS = "vitest.json";

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

function testArgv(detection: Extract<Detection, { runner: Runner }>, places: Places): string[] {
  // node's runner is ours and runs none of the tree's code, so it reports where the tests cannot
  // write. vitest is the tree's own dependency running the tree's own config: its report is a file.
  const test =
    detection.runner === "node"
      ? [places.node, "--test", `--test-reporter=${places.tools}/reporter.mjs`, `--test-reporter-destination=${places.report}`, "--test-reporter=spec", "--test-reporter-destination=stdout"]
      : ["node_modules/.bin/vitest", "run", "--reporter=json", `--outputFile.json=${places.out}/${VITEST_RESULTS}`, "--reporter=default"];
  return [...test, ...detection.args];
}

const OUTPUT_TAIL = 8000;

/**
 * Runs the tree's tests once under `isolation`. Dependencies are fetched first, with the network,
 * by npm alone in a folder the tree is not in; then the tests run in the copy with no network.
 */
export async function runTests(
  tree: FileTree,
  executable: ReadonlySet<string>,
  isolation: Isolation,
  timeoutMs: number,
  registry: string = NPM_REGISTRY,
): Promise<TestRun> {
  const detection = detectRunner(tree);
  if ("unsupported" in detection) return { status: "unsupported", why: detection.unsupported };
  const install = detection.install ? installFiles(tree, registry) : undefined;
  if (install !== undefined && "refused" in install) return { status: "refused", why: install.refused };
  const started = Date.now();
  const run = await runIsolated({
    tree,
    executable,
    isolation,
    tools: new Map([["reporter.mjs", NODE_REPORTER], ["npmrc-user", ""], ["npmrc-global", ""]]),
    ...(install === undefined ? {} : { install: { files: install.files, argv: (places: Places) => installArgv(places, registry) } }),
    steps: (places) => [{ argv: testArgv(detection, places) }],
    ...(detection.runner === "node" ? { report: true } : { collect: [VITEST_RESULTS] }),
    timeoutMs,
    outputBytes: 1 << 20,
  });
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  const ran = [...(run.install === undefined ? [] : [run.install]), ...run.steps];
  const output = ran.map((step) => step.output).join("").slice(-OUTPUT_TAIL);
  const failed = (why: string): TestRun => ({ status: "failed", why, runner: detection.runner, isolation: isolation.kind, seconds, output });
  const last = ran.at(-1);
  if (last === undefined) return failed("nothing ran");
  if (last.timedOut) return failed(`the run passed its limit of ${Math.round(timeoutMs / 1000)} seconds`);
  if (run.steps.length === 0) return failed(`npm ci --ignore-scripts exited ${last.exitCode}`);
  const results = detection.runner === "node" ? run.report : run.collected.get(VITEST_RESULTS);
  if (results === undefined || results.kind === "missing") return failed(`the runner wrote no results (exit ${last.exitCode})`);
  if (results.kind === "too large") return failed(`the runner's results are too large to read (${results.bytes} bytes)`);
  if (results.kind === "unreadable") return failed(`the runner's results are unreadable: ${results.why}`);
  try {
    const reports = detection.runner === "node" ? parseNodeEvents(results.text) : parseVitestJson(results.text, run.places.work);
    const about = { runner: detection.runner, isolation: isolation.kind, seconds, exitCode: last.exitCode ?? 1 };
    const why = unreliable(reports, about.exitCode, tree);
    return why === undefined ? { status: "ran", ...about, reports } : { status: "unreliable", why, ...about };
  } catch (error) {
    return failed((error as Error).message);
  }
}

/**
 * Why a run's results cannot be shown as what happened, if they cannot. However the results reach
 * Rungs, they are checked against the one thing the tests do not write, the runner's exit code,
 * against the tree, and against each other. A run that fails any check is shown as unreliable,
 * never as passes.
 */
export function unreliable(reports: readonly TestReport[], exitCode: number, tree: FileTree): string | undefined {
  if (exitCode !== 0 && exitCode !== 1) return `the runner exited ${exitCode}, which no test result explains`;
  const outcomes = new Map<string, Outcome>();
  let failures = 0;
  for (const report of reports) {
    if (!tree.has(report.file)) return `a result names ${JSON.stringify(report.file.slice(0, 120))}, which is not a file in the tree`;
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
  let json: { testResults?: unknown } | null;
  try {
    json = JSON.parse(text) as { testResults?: unknown } | null;
  } catch {
    // The parser's own message quotes the text, which may not be the runner's.
    throw new Error("vitest's report is not valid JSON");
  }
  if (!Array.isArray(json?.testResults)) throw new Error("vitest's report has no testResults");
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
  if (run.status === "failed" || run.status === "unreliable") {
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
