import { createHash } from "node:crypto";
import { isCodeNode } from "./graph.ts";
import type { FileTree, Graph, NodeId } from "./graph.ts";
import { isTestFile } from "./test-files.ts";
import { titlesOf } from "./test-marks.ts";
import { READ_ONLY, classify } from "./control.ts";
import { mergeLeftovers } from "./leftover.ts";
import type { Leftover } from "./leftover.ts";
import { runIsolated } from "./sandbox.ts";
import type { Isolation, Places } from "./sandbox.ts";
import { FAILURE_LIMIT, READ_ONLY_REASON, bounded } from "./observed-types.ts";
import type { ControlDocument, FailureDetail, ObservedDocument, ObservedTest, Outcome, Runner, UnmatchedTest, WrittenDocument } from "./observed-types.ts";

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
  /** What else the runner gave of the failure: the assertion's values and the test file's line. */
  readonly detail?: FailureDetail;
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
      /** What its steps left running; absent for a run in the sandbox. */
      readonly leftover?: Leftover;
    }
  | {
      /** The results contradict the runner or the files the run was given, so none of them is passed on. */
      readonly status: "unreliable";
      readonly why: string;
      readonly runner: Runner;
      readonly isolation: Isolation["kind"];
      readonly seconds: number;
      readonly exitCode: number;
      readonly leftover?: Leftover;
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
      /** The same base tests against the base code; none when no control run was made. */
      readonly control?: ControlRun;
      /** What the head run, the written tests' run and the control run left running, as one; absent when none ran outside the sandbox. */
      readonly leftover?: Leftover;
    };

/**
 * The control run: main's tests against main's own code, in the same sandbox and the same way, so a
 * failure of the head run that also happens here is the environment's, not the change's.
 */
export type ControlRun =
  | {
      readonly status: "ran";
      readonly seconds: number;
      readonly reports: readonly TestReport[];
      /** The run's output names a read-only file system error: the read-only tree made something fail that no single failure says, so none of main's failures is main's own. */
      readonly readOnly?: true;
    }
  | { readonly status: "failed"; readonly why: string; readonly output: string }
  | { readonly status: "unreliable" | "refused" | "unsupported" | "stopped"; readonly why: string };

/** The runner the base's `test` script names, with the arguments it passes. */
/** The script's node flags, each with its value as `--flag=value`, and the files or patterns it names. */
export type Detection = { readonly runner: Runner; readonly flags: readonly string[]; readonly files: readonly string[] } | { readonly unsupported: string };

const SHELL = /[;&|<>$`'"\\(){}!]/;
/**
 * The node flags a test script may pass. The runner's report is only its own while none of the
 * tree's code runs inside the runner: each test file gets a process of its own, and nothing is
 * preloaded. So a flag that loads code (--import, --require, --loader) or runs the tests in the
 * runner (--experimental-test-isolation) is not on the list, and neither is any flag not known.
 */
const NODE_BOOLEAN_FLAGS = new Set([
  "--test-only", "--test-force-exit", "--test-update-snapshots", "--experimental-test-coverage", "--experimental-strip-types", "--experimental-transform-types", "--enable-source-maps", "--no-warnings",
]);
const NODE_VALUE_FLAGS = new Set(["--test-concurrency", "--test-timeout", "--test-name-pattern", "--test-skip-pattern", "--test-shard"]);
/** Ours to set: the script's reporter, with its destination, is dropped. */
const NODE_REPORTER_FLAGS = new Set(["--test-reporter", "--test-reporter-destination"]);

/**
 * The flags and files of a `node --test` script. A flag's value is read with the flag, in either
 * spelling (`--test-timeout 5000` or `--test-timeout=5000`) and kept as `--flag=value`, so no file
 * can ever be taken for a value or a value for a file. Any flag not listed is refused.
 */
function parseNodeArgs(words: readonly string[]): { flags: string[]; files: string[] } | { unsupported: string } {
  const flags: string[] = [];
  const files: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (!word.startsWith("-")) {
      files.push(word);
      continue;
    }
    const equals = word.indexOf("=");
    const name = equals < 0 ? word : word.slice(0, equals);
    const keep = NODE_VALUE_FLAGS.has(name);
    if (keep || NODE_REPORTER_FLAGS.has(name)) {
      let value = equals < 0 ? undefined : word.slice(equals + 1);
      if (value === undefined) {
        value = words[index + 1];
        index += 1;
      }
      if (value === undefined) return { unsupported: `the test script gives ${JSON.stringify(name)} no value` };
      if (keep) flags.push(`${name}=${value}`);
    } else if (NODE_BOOLEAN_FLAGS.has(word)) flags.push(word);
    else return { unsupported: `the test script gives node ${JSON.stringify(word)}; Systems to Streets runs node --test only with flags that keep the tree's code out of the runner` };
  }
  return { flags, files };
}

const READ = "Systems to Streets reads only node --test";
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
    const parsed = parseNodeArgs(rest.filter((word) => word !== "--test"));
    return "unsupported" in parsed ? parsed : { runner: "node", ...parsed };
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
    return { unsupported: "package.json has dependencies but no package-lock.json; Systems to Streets installs only from a lockfile" };
  }
  return { install };
}

/** A node test reporter that writes each finished test or suite as one JSON line. */
export const NODE_REPORTER = `import { realpathSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
const where = (file) => { try { return relative(process.cwd(), realpathSync(file)); } catch { return relative(process.cwd(), file); } };
const LIMIT = ${FAILURE_LIMIT};
const bound = (text) => (text.length <= LIMIT ? text : text.slice(0, LIMIT) + "… " + (text.length - LIMIT) + " more characters");
// The test code under review is untrusted: every read of what it threw is guarded, and a read that fails leaves the part out.
const text = (read) => {
  try {
    const value = read();
    return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
  } catch {
    return "";
  }
};
const cutNote = (length) => (length > LIMIT ? "… " + (length - LIMIT) + " more characters" : "");
// Always util.inspect's escaped form, so a string is quoted and every character, a CR or an LF, is exact.
const show = (value) => {
  const printed = inspect(typeof value === "string" ? value.slice(0, LIMIT) : value, { colors: false, depth: 6, compact: false, breakLength: Infinity, maxArrayLength: 50, maxStringLength: ${FAILURE_LIMIT}, sorted: true });
  return typeof value === "string" ? printed + cutNote(value.length) : printed.slice(0, LIMIT) + cutNote(printed.length);
};
// The first frame in the test's own file among the frames after the stack's header, which must be exactly the error's name and message (and code); nothing otherwise.
const lineOf = (stack, name, message, code, file) => {
  if (typeof stack !== "string" || typeof name !== "string" || typeof message !== "string") return undefined;
  const heads = [name, ...(typeof code === "string" ? [name + " [" + code + "]"] : [])].map((head) => (message === "" ? head : head + ": " + message));
  const head = heads.find((candidate) => stack.startsWith(candidate) && (stack.length === candidate.length || stack[candidate.length] === "\\n"));
  if (head === undefined) return undefined;
  for (const frame of stack.slice(head.length).split("\\n")) {
    const found = /^\\s*at .*?\\(?((?:file:\\/\\/)?\\/[^\\s()]*?):(\\d+):\\d+\\)?\\s*$/.exec(frame);
    if (found === null) continue;
    try {
      if (where(found[1].startsWith("file:") ? fileURLToPath(found[1]) : found[1]) === file) {
        const line = Number(found[2]);
        return Number.isSafeInteger(line) && line > 0 ? line : undefined;
      }
    } catch {}
  }
  return undefined;
};
const detailOf = (cause, file) => {
  try {
    const detail = {};
    const operator = cause?.code === "ERR_ASSERTION" ? cause.operator : undefined;
    if (typeof operator === "string") {
      detail.operator = operator.slice(0, 40);
      if (operator !== "fail" && Object.hasOwn(cause, "expected") && Object.hasOwn(cause, "actual")) {
        detail.expected = show(cause.expected);
        detail.actual = show(cause.actual);
      }
    }
    const line = lineOf(cause?.stack, cause?.name, cause?.message, cause?.code, file);
    if (line !== undefined) detail.line = line;
    return Object.keys(detail).length === 0 ? undefined : detail;
  } catch {
    return undefined;
  }
};
export default async function* reporter(source) {
  for await (const { type, data } of source) {
    if (type !== "test:pass" && type !== "test:fail") continue;
    const error = data.details?.error;
    const file = typeof data.file === "string" ? where(data.file) : "";
    const detail = type === "test:fail" ? detailOf(error?.cause, file) : undefined;
    yield JSON.stringify({
      type,
      file,
      name: data.name,
      nesting: data.nesting,
      kind: data.details?.type ?? "test",
      ms: data.details?.duration_ms ?? 0,
      ...(data.skip !== undefined && data.skip !== false ? { skip: true } : {}),
      ...(data.todo !== undefined && data.todo !== false ? { todo: true } : {}),
      ...(type === "test:fail" ? { error: text(() => error?.cause?.message ?? error?.message), failure: text(() => error?.failureType) } : {}),
      ...(detail === undefined ? {} : { detail }),
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
 * The only two files the install is given, written by Systems to Streets from what it checked: the tree's
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
      throw new Refusal(`${lockName} has lockfileVersion ${quoted(lock.lockfileVersion)}; Systems to Streets installs only from versions 2 and 3`);
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
async function once(job: Job, isolation: Isolation, timeoutMs: number, registry: string): Promise<Once & { readonly seconds: number; readonly leftover?: Leftover; readonly readOnly?: true }> {
  const started = Date.now();
  const run = await runIsolated({
    tree: job.tree,
    executable: job.executable,
    pinned: job.pinned,
    // In the sandbox no test can change what another reads. Without one nothing can be promised, and the run says so.
    readOnlyWork: true,
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
    watch: READ_ONLY,
    timeoutMs,
    outputBytes: 1 << 20,
  });
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  const ran = [...(run.install === undefined ? [] : [run.install]), ...run.steps];
  const output = ran.map((step) => step.output).join("").slice(-OUTPUT_TAIL);
  const leftover = mergeLeftovers(ran.map((step) => step.leftover));
  // Seen as the output arrived, so output cut at the limit cannot have hidden it.
  const readOnly = ran.some((step) => step.watched === true);
  const found = { ...(leftover === undefined ? {} : { leftover }), ...(readOnly ? { readOnly: true as const } : {}) };
  const failed = (why: string): Once & { readonly seconds: number; readonly leftover?: Leftover; readonly readOnly?: true } => ({ status: "failed", why, output, seconds, ...found });
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
    return why === undefined ? { status: "ran", exitCode, reports, seconds, ...found } : { status: "unreliable", why, exitCode, seconds, ...found };
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
  /** Called when the head's run is done and the control run starts. */
  onControl: () => void = () => {},
  /** The base tree's own executable files, for the control run; the head's set is the head's. */
  baseExecutable: ReadonlySet<string> = executable,
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
  const first = await once({ tree, executable, pinned, args: [...detection.flags, ...detection.files], allowed: pinned, install }, isolation, timeoutMs, registry);
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  const about = { runner: detection.runner, isolation: isolation.kind, seconds: first.seconds, ...(first.leftover === undefined ? {} : { leftover: first.leftover }) };
  if (first.status === "failed") return { status: "failed", why: first.why, output: first.output, ...about };
  if (first.status === "unreliable") return { status: "unreliable", why: first.why, exitCode: first.exitCode, ...about };
  const writtenFiles = testPaths(head).filter((path) => RUNNABLE.test(path) && head.get(path) !== base.get(path));
  let written: WrittenRun | undefined;
  let writtenLeftover: Leftover | undefined;
  if (writtenFiles.length > 0) {
    const left = Math.max(1000, timeoutMs - (Date.now() - started));
    const { seconds: took, leftover: writtenLeft, ...outcome } = await once(
      { tree: head, executable, pinned: new Set(), args: [...detection.flags, ...writtenFiles], allowed: new Set(writtenFiles), install },
      isolation,
      left,
      registry,
    );
    written = { files: writtenFiles, seconds: took, outcome };
    writtenLeftover = writtenLeft;
  }
  onControl();
  const { control, leftover: controlLeftover } = await controlRun(base, baseExecutable, isolation, timeoutMs, registry, [...detection.flags, ...detection.files], baseTests);
  const leftover = mergeLeftovers([first.leftover, writtenLeftover, controlLeftover]);
  return {
    control,
    status: "ran",
    runner: about.runner,
    isolation: about.isolation,
    seconds,
    exitCode: first.exitCode,
    reports: first.reports,
    deleted: baseTests.filter((path) => !head.has(path)),
    edited: baseTests.filter((path) => head.has(path) && head.get(path) !== base.get(path)),
    ...(written === undefined ? {} : { written }),
    ...(leftover === undefined ? {} : { leftover }),
  };
}

/**
 * The control run: the head's run again with main's own code in place of the head's, the same test
 * files read-only, the same arguments, the same sandbox. The base tree reaches the sandbox the way the
 * head's does, as a tree handed to `once`. A run that cannot be made says why; it never throws.
 */
async function controlRun(
  base: FileTree,
  executable: ReadonlySet<string>,
  isolation: Isolation,
  timeoutMs: number,
  registry: string,
  args: readonly string[],
  baseTests: readonly string[],
): Promise<{ readonly control: ControlRun; readonly leftover?: Leftover }> {
  try {
    const needed = installNeeded(base);
    if ("unsupported" in needed) return { control: { status: "unsupported", why: needed.unsupported } };
    const install = needed.install ? installFiles(base, registry) : undefined;
    if (install !== undefined && "refused" in install) return { control: { status: "refused", why: install.refused } };
    const pinned = new Set(baseTests);
    const { leftover, readOnly, ...outcome } = await once({ tree: base, executable, pinned, args, allowed: pinned, install }, isolation, timeoutMs, registry);
    const found = leftover === undefined ? {} : { leftover };
    if (outcome.status === "ran") return { control: { status: "ran", seconds: outcome.seconds, reports: outcome.reports, ...(readOnly ? { readOnly } : {}) }, ...found };
    return { control: outcome.status === "failed" ? { status: "failed", why: outcome.why, output: outcome.output } : { status: "unreliable", why: outcome.why }, ...found };
  } catch (error) {
    return { control: { status: "stopped", why: `the control run stopped: ${error instanceof Error ? error.message : String(error)}` } };
  }
}

/**
 * Why a run's results cannot be shown as what happened, if they cannot. However the results reach
 * Systems to Streets, they are checked against the one thing the tests do not write, the runner's exit code,
 * and against the test files the run was given. A run that fails any check is shown as unreliable,
 * never as passes.
 */
export function unreliable(reports: readonly TestReport[], exitCode: number, allowed: ReadonlySet<string>): string | undefined {
  if (exitCode !== 0 && exitCode !== 1) return `the runner exited ${exitCode}, which no test result explains`;
  let failures = 0;
  for (const report of reports) {
    if (!allowed.has(report.file)) return `a result names ${JSON.stringify(report.file.slice(0, 120))}, which is not a test file this run was given`;
    if (report.outcome === "fail") failures += 1;
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
  readonly detail?: FailureDetail;
}

/** The limit plus room for the "… N more characters" the reporter already added, so that a cut value is not cut again. */
const KEPT = FAILURE_LIMIT + 40;

/** Only strings and a positive line number, whatever else the run wrote; values are cut to the limit. A detail that is not one is dropped, never an error: the rest of the event and the run stay. */
function readDetail(value: unknown): FailureDetail | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const { operator, expected, actual, line } = value as Record<string, unknown>;
  const text = (field: unknown) => field === undefined || typeof field === "string";
  if (!text(operator) || !text(expected) || !text(actual) || !(line === undefined || (typeof line === "number" && Number.isSafeInteger(line) && line > 0))) return undefined;
  const detail = {
    ...(typeof operator === "string" ? { operator: operator.slice(0, 40) } : {}),
    ...(typeof expected === "string" ? { expected: bounded(expected, KEPT) } : {}),
    ...(typeof actual === "string" ? { actual: bounded(actual, KEPT) } : {}),
    ...(typeof line === "number" ? { line } : {}),
  };
  return Object.keys(detail).length === 0 ? undefined : detail;
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
    const detail = outcome === "fail" ? readDetail(event.detail) : undefined;
    const report = { file: event.file, path, outcome, ms: event.ms, ...(outcome === "fail" && event.error ? { message: bounded(event.error) } : {}), ...(detail ? { detail } : {}), ...(own ? { suite: true as const } : {}) };
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
    const { message, detail } = report;
    return { file: report.file, name: report.path.join(" > "), outcome: report.outcome, ms: report.ms, ...(message ? { message } : {}), ...(detail ? { detail } : {}) };
  });
  return { ...about, status: "ran", exitCode: outcome.exitCode, counts, tests };
}

/** The control run as the document serves it; a run with none says so, and is never read as a run with no regressions. */
function controlDocument(control: ControlRun | undefined, compared: ReturnType<typeof classify> | undefined): ControlDocument {
  if (control === undefined) return { status: "stopped", why: "not attempted" };
  if (control.status !== "ran") return { status: control.status, why: control.why };
  if (compared === undefined) return { status: "stopped", why: "the control run was not compared" };
  const baseOnly = compared.baseOnly.map((report) => ({ file: report.file, name: report.path.join(" > "), outcome: report.outcome }));
  return { status: "ran", seconds: control.seconds, counts: compared.counts, notComparedFailures: compared.notComparedFailures, baseOnly };
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
  const compared = run.control?.status === "ran" ? classify(run.reports, run.control.reports, run.control.readOnly ? READ_ONLY_REASON : undefined) : undefined;
  for (const [index, report] of run.reports.entries()) {
    counts[report.outcome] += 1;
    const { message, detail } = report;
    const verdict = compared?.verdicts[index];
    const verdictWhy = compared?.reasons[index];
    const observed: ObservedTest = { name: report.path.join(" > "), outcome: report.outcome, ms: report.ms, ...(message ? { message } : {}), ...(detail ? { detail } : {}), ...(verdict ? { verdict } : {}), ...(verdictWhy ? { verdictWhy } : {}) };
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
    control: controlDocument(run.control, compared),
    ...(run.leftover === undefined ? {} : { leftover: run.leftover }),
  };
}
