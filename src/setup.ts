import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { readRef } from "./checkout.ts";
import type { RefBase } from "./checkout.ts";
import { EXTRACTOR_VERSION, digestOf, extract } from "./extract/extract.ts";
import type { FileTree } from "./graph.ts";
import { looksSecret } from "./prompt-safe.ts";
import type { JevClient } from "./jev/client.ts";
import { MAX_PAIRS, judgeMemberships, narrow, pairKey, unitsOf } from "./jev/membership-source.ts";
import type { Coverage, JudgingNote, MembershipRecord, StoredMemberships } from "./memberships.ts";
import { coverageOf, memberships as buildMemberships, membershipLines, problemWithMemberships, reconcile } from "./memberships.ts";
import { standIn, storedPath } from "./stored-names.ts";
import { effectSets } from "./effects.ts";
import { HARM_CATALOGUE } from "./harm-catalogue.ts";
import { kindChoice as chosenKinds, readKindsFile } from "./jev/stakes-adoption.ts";
import { MAX_STAKES_PAIRS, judgeStakes, stakePairKey, termMembers } from "./jev/stakes-source.ts";
import type { KindChoice, StakeRecord, StakesNote, StoredStakes } from "./stakes.ts";
import { problemWithStakes, reconcileStakes, stakes as buildStakes, stakesAreCurrent, stakesLines } from "./stakes.ts";
import { collectVocabulary, VOCABULARY_TABLE_VERSION } from "./vocabulary.ts";
import type { Vocabulary } from "./vocabulary.ts";

const execFileAsync = promisify(execFile);

/*
 * `streets setup`: a repository's vocabulary, built from its base once and stored with the cache,
 * outside the repository, so it works where the reviewer cannot commit. It is a derived fact and
 * is kept apart from the graph. A later run redoes nothing when no file's digest and neither the
 * vocabulary table's version nor the extractor's changed; otherwise it collects the terms again
 * (a term merges spellings from many files, so one changed file can change a term anywhere) and
 * says how many files changed. No model is called unless the reviewer passes `--judge`: then each
 * function, class or constant is mapped to the terms code picked for it (the membership gate), the
 * judged records are stored beside the vocabulary (a separate tier, see memberships.ts) and
 * coverage is measured. Without `--judge`, stored memberships are only brought up to date: a
 * mapping whose function changed is marked stale. Whatever later steps add to the stored file
 * (certification) is kept when setup rewrites it.
 */

/** The shape of the stored file. Raise it when a field's meaning changes. */
const FORMAT = 1;

export interface StoredVocabulary {
  readonly format: typeof FORMAT;
  readonly tier: "derived";
  /** The repository's name, for people; the file is named by the repository's identity (see `repoIdentity`). */
  readonly repo: string;
  /** What it was built from: the branch or ref asked for and the commit it was when this was built. */
  readonly base: { readonly ref: string; readonly commit: string };
  /** The graph's extractor version: a new one can change what is read from the same files. */
  readonly extractorVersion: string;
  /** Every file of the base by path (see `storedPath`) and the digest of its text, what a later run compares. */
  readonly files: Readonly<Record<string, string>>;
  /** Files whose path had secret-shaped text in it, so the path is not kept. */
  readonly pathsWithheld: number;
  /**
   * The share of analysed files that map to at least one term (see Coverage). `mapped` is zero and
   * `measured` false until `streets setup --judge` has judged: zero then means "not measured".
   */
  readonly coverage: Coverage;
  readonly vocabulary: Vocabulary;
  /** Judged: which function, class or constant belongs to which term. Absent until `streets setup --judge` has run. */
  readonly memberships?: StoredMemberships;
  /** Judged: whether a mistake in each term's code could cause each kind of harm. Absent until `streets setup --judge` has run. */
  readonly stakes?: StoredStakes;
}

export type SetupWork = "first setup" | "unchanged" | "rebuilt" | "rules changed" | "replaced unreadable";

export interface SetupResult {
  readonly work: SetupWork;
  /** The file the vocabulary is stored in. */
  readonly file: string;
  /** The ref asked for (or found as the default). */
  readonly ref: string;
  readonly stored: StoredVocabulary;
  /** Why the work is not "first setup" or "unchanged": what changed in the rules, or why the old file was unusable. */
  readonly why?: string;
  /** Files added, changed and removed since the stored vocabulary; set when it was rebuilt. */
  readonly files?: { readonly added: number; readonly changed: number; readonly removed: number };
  /** The commit the stored vocabulary was built from before this run. */
  readonly previousCommit?: string;
  /** What this run's judging did; absent when it did not judge. */
  readonly judging?: JudgingNote;
  /** What this run's stakes judging did; absent when it did not judge. */
  readonly judgingStakes?: StakesNote;
}

/** What a test may swap to see that no work was done. */
export interface SetupDeps {
  readonly collect?: typeof collectVocabulary;
  readonly graphOf?: typeof extract;
  /** The most (function, term) pairs asked in one run; MAX_PAIRS when left out. */
  readonly maxPairs?: number;
  /** The most (term, kind) pairs asked of the stakes gate in one run; MAX_STAKES_PAIRS when left out. */
  readonly maxStakePairs?: number;
  /** The kinds of harm that may be asked about; what the stakes gate's bench result allows (gates/stakes/kinds.json) when left out. */
  readonly kindChoice?: KindChoice;
}

export interface SetupRequest {
  readonly dir: string;
  readonly cacheDir: string;
  /** The base to read; the default branch's tip when left out (see `defaultRef`). */
  readonly ref?: string;
  /** Judging on: the classifier that answers the membership questions. Left out, no model is called. */
  readonly judge?: JevClient;
  readonly deps?: SetupDeps;
}

async function git(dir: string, args: readonly string[]): Promise<string | undefined> {
  try {
    // The repository may be a pull request's: no hook or fsmonitor program from its config runs.
    return (await execFileAsync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], { cwd: dir, encoding: "utf8" })).stdout.trim();
  } catch {
    return undefined;
  }
}

interface Identity {
  readonly name: string;
  /** The file's name: the repository's shared git folder (so every worktree of it agrees) and the folder asked for within it. */
  readonly key: string;
}

/** Which repository `dir` is in, whatever its checkout or worktree. Nothing about one repository is built in. */
async function repoIdentity(dir: string): Promise<Identity> {
  const common = await git(dir, ["rev-parse", "--git-common-dir"]);
  const prefix = await git(dir, ["rev-parse", "--show-prefix"]);
  if (common === undefined || prefix === undefined) throw new Error(`${dir} is not a git repository`);
  const gitDir = await realpath(resolve(dir, common));
  const called = basename(gitDir) === ".git" ? basename(dirname(gitDir)) : basename(gitDir);
  // A name shaped like a secret is neither stored nor made a file name: the hash alone tells the repositories apart.
  const name = looksSecret(called) ? "withheld" : called.replace(/[^\w.-]+/g, "_");
  const hash = createHash("sha256").update(JSON.stringify([gitDir, prefix])).digest("hex").slice(0, 12);
  return { name, key: `${name}-${hash}` };
}

/**
 * The branch to read when none is asked for: what the remote calls its default, else `main`, else
 * `master`, else what is checked out. A reviewer who cannot commit has the remote's branch.
 */
async function defaultRef(dir: string): Promise<string> {
  const remote = await git(dir, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (remote !== undefined && remote !== "") return remote;
  for (const name of ["main", "master"]) if ((await git(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`])) !== undefined) return name;
  return "HEAD";
}

const fileFor = (cacheDir: string, key: string): string => join(cacheDir, "vocabulary", `${key}.json`);

export { storedPath };

/** A ref as it is stored and printed: itself, or a stand-in when a part of it is shaped like a secret. */
const storedRef = (ref: string): string => (ref.split("/").some(looksSecret) ? standIn(ref) : ref);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown): boolean => typeof value === "number" && Number.isInteger(value) && value >= 0;
const isText = (value: unknown): boolean => typeof value === "string";
const isList = (value: unknown, each: (one: unknown) => boolean): boolean => Array.isArray(value) && value.every(each);
const hasFields = (value: unknown, fields: Readonly<Record<string, (field: unknown) => boolean>>): boolean =>
  isRecord(value) && Object.entries(fields).every(([name, holds]) => holds(value[name]));
const isRange = (value: unknown): boolean => value === null || hasFields(value, { start: isCount, end: isCount });

const SKIPPED = ["tooLong", "withheld", "notAWord", "hiddenFolders", "generated", "notLiteral", "wildcard"];
const SOURCES = ["heading", "folder", "export", "test", "package description"];

/**
 * The name of the first thing wrong with a stored record, or undefined when it is whole. Everything the report and the
 * later steps read is checked, so a file edited or cut short is replaced and never half trusted.
 */
function problemWith(whole: Record<string, unknown>): string | undefined {
  const checks: [string, boolean][] = [
    ["repo", isText(whole.repo)],
    ["tier", whole.tier === "derived"],
    ["base", hasFields(whole.base, { ref: isText, commit: isText })],
    ["extractorVersion", isText(whole.extractorVersion)],
    ["files", isRecord(whole.files) && Object.values(whole.files).every(isText)],
    ["pathsWithheld", isCount(whole.pathsWithheld)],
    ["coverage", hasFields(whole.coverage, { of: isCount, mapped: isCount, measured: (one) => typeof one === "boolean", unjudged: (one) => one === undefined || isCount(one), stale: (one) => one === undefined || isCount(one), unknownUnits: (one) => one === undefined || isCount(one), reason: (one) => one === undefined || isText(one) })],
    ["vocabulary", isRecord(whole.vocabulary)],
    ["memberships", whole.memberships === undefined || problemWithMemberships(whole.memberships) === undefined],
    ["stakes", whole.stakes === undefined || problemWithStakes(whole.stakes) === undefined],
  ];
  const failed = checks.find(([, ok]) => !ok);
  if (failed !== undefined) return failed[0];
  // Stored coverage is a count of what the records say, never a cached claim: records removed or edited with the coverage kept is damage.
  const stated = whole.coverage as Record<string, unknown>;
  const expected = coverageOf(stated.of as number, whole.memberships as StoredMemberships | undefined);
  const same = (c: Record<string, unknown>): string => JSON.stringify([c.mapped, c.measured, c.unjudged ?? null, c.stale ?? null, c.unknownUnits ?? null, c.reason ?? null]);
  if (same(stated) !== same(expected as unknown as Record<string, unknown>)) return "coverage (it does not follow from the memberships)";
  const v = whole.vocabulary as Record<string, unknown>;
  const term = (one: unknown): boolean =>
    hasFields(one, {
      key: isText,
      name: isText,
      spellings: (field) => isList(field, isText),
      pins: (pins) => isList(pins, (pin) => hasFields(pin, { source: (source) => typeof source === "string" && SOURCES.includes(source), path: isText, range: isRange, written: isText })),
    });
  const vocabulary: [string, boolean][] = [
    ["vocabulary.tableVersion", isCount(v.tableVersion)],
    ["vocabulary.status", v.status === "found" || v.status === "none" || v.status === "unknown"],
    ["vocabulary.terms", isList(v.terms, term)],
    ["vocabulary.dropped", hasFields(v.dropped, { count: isCount, terms: (terms) => isList(terms, (one) => hasFields(one, { key: isText, name: isText, rule: (rule) => rule === "short" || rule === "generic" })) })],
    ["vocabulary.skipped", hasFields(v.skipped, Object.fromEntries(SKIPPED.map((name) => [name, isCount])))],
    ["vocabulary.unread", isList(v.unread, (one) => hasFields(one, { path: isText, reason: isText }))],
    ["vocabulary.notAnalysed", isCount(v.notAnalysed)],
    ["vocabulary.reason", v.reason === undefined || isText(v.reason)],
  ];
  return vocabulary.find(([, ok]) => !ok)?.[0];
}

type Previous =
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable"; readonly why: string }
  | { readonly kind: "ok"; readonly stored: StoredVocabulary; /** Everything in the file, including fields a later step added. */ readonly whole: Record<string, unknown> };

async function readStored(file: string): Promise<Previous> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return { kind: "unreadable", why: (error as Error).message };
  }
  let whole: unknown;
  try {
    whole = JSON.parse(text);
  } catch {
    return { kind: "unreadable", why: "it is not JSON" };
  }
  if (!isRecord(whole)) return { kind: "unreadable", why: "it is not a JSON object" };
  if (whole.format !== FORMAT) return { kind: "unreadable", why: `it has format ${JSON.stringify(whole.format)}, not ${FORMAT}` };
  const problem = problemWith(whole);
  if (problem !== undefined) return { kind: "unreadable", why: `it is not shaped as a vocabulary: ${problem} is missing or wrong` };
  return { kind: "ok", stored: whole as unknown as StoredVocabulary, whole };
}

/** The base's files as stored: stored path to the digest of its text. A Map, since a path may be named like a property of an object ("__proto__", "constructor"). */
function digestsOf(tree: FileTree, unavailable: RefBase["unavailable"]): Map<string, string> {
  const files = new Map<string, string>();
  for (const path of [...tree.keys()].sort()) files.set(storedPath(path), digestOf(tree.get(path)!));
  // A file this clone does not hold has no digest of its text; its object's name says which version is missing, and differs from every digest.
  for (const { path, sha } of unavailable) files.set(storedPath(path), `unavailable:${sha}`);
  return files;
}

const NOT_AVAILABLE = "not available in this clone (git was not allowed to fetch it)";

/** The vocabulary with the files this clone could not give listed as unread. A repository whose words may all be in them is unknown, never none. */
function withUnavailable(vocabulary: Vocabulary, unavailable: RefBase["unavailable"]): Vocabulary {
  if (unavailable.length === 0) return vocabulary;
  const unread = [...vocabulary.unread, ...unavailable.map(({ path }) => ({ path, reason: NOT_AVAILABLE }))].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const paths = unavailable.map(({ path }) => path).sort().join(", ");
  return { ...vocabulary, unread, ...(vocabulary.status === "none" ? { status: "unknown" as const, reason: `a file could not be read: ${paths}` } : {}) };
}

function countChanges(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): { added: number; changed: number; removed: number } {
  let added = 0;
  let changed = 0;
  let removed = 0;
  for (const [path, digest] of after) {
    const was = before.get(path);
    if (was === undefined) added++;
    else if (was !== digest) changed++;
  }
  for (const path of before.keys()) if (!after.has(path)) removed++;
  return { added, changed, removed };
}

/** The vocabulary with every path made storable: a term's pins and the unread list name no secret-shaped path. */
function storable(vocabulary: Vocabulary): Vocabulary {
  return {
    ...vocabulary,
    terms: vocabulary.terms.map((term) => ({ ...term, pins: term.pins.map((pin) => ({ ...pin, path: storedPath(pin.path) })) })),
    unread: vocabulary.unread.map((one) => ({ ...one, path: storedPath(one.path) })),
    // The reason an unknown status gives names the unread files.
    ...(vocabulary.reason === undefined ? {} : { reason: vocabulary.unread.reduce((reason, one) => reason.split(one.path).join(storedPath(one.path)), vocabulary.reason) }),
  };
}

/** Builds the vocabulary of the repository in `dir` from its base, or leaves the stored one when nothing it depends on changed. */
export async function setUp(request: SetupRequest): Promise<SetupResult> {
  const { dir, cacheDir, deps = {} } = request;
  const { collect = collectVocabulary, graphOf = extract } = deps;
  const identity = await repoIdentity(dir);
  const file = fileFor(cacheDir, identity.key);
  const asked = request.ref ?? (await defaultRef(dir));
  // What is stored and printed names a ref shaped like a secret by a stand-in.
  const ref = storedRef(asked);
  const base = await readRef(dir, asked).catch((error: unknown) => {
    if (error instanceof Error && ref !== asked) error.message = error.message.split(asked).join(ref);
    throw error;
  });
  const files = digestsOf(base.tree, base.unavailable);
  const previous = await readStored(file);
  const before = previous.kind === "ok" ? new Map(Object.entries(previous.stored.files)) : new Map<string, string>();

  let work: SetupWork = "first setup";
  let why: string | undefined;
  if (previous.kind === "unreadable") {
    work = "replaced unreadable";
    why = previous.why;
  } else if (previous.kind === "ok") {
    const { stored } = previous;
    const table = stored.vocabulary.tableVersion;
    if (table !== VOCABULARY_TABLE_VERSION) {
      work = "rules changed";
      why = `the vocabulary table went from version ${table} to ${VOCABULARY_TABLE_VERSION}`;
    } else if (stored.extractorVersion !== EXTRACTOR_VERSION) {
      work = "rules changed";
      why = `the extractor went from version ${stored.extractorVersion} to ${EXTRACTOR_VERSION}`;
    } else {
      const changes = countChanges(before, files);
      // Nothing to redo, and no model to ask: nothing is built or written.
      // A catalogue, question or threshold change under stored stakes is work to do even then: they go stale.
      if (changes.added + changes.changed + changes.removed === 0 && request.judge === undefined && (stored.stakes === undefined || stakesAreCurrent(stored.stakes))) return { work: "unchanged", file, ref, stored, previousCommit: stored.base.commit };
      work = changes.added + changes.changed + changes.removed === 0 ? "unchanged" : "rebuilt";
    }
  }

  const graph = graphOf(base.tree);
  const vocabulary = withUnavailable(collect({ graph, tree: base.tree }), base.unavailable);
  const prior = previous.kind === "ok" ? previous.stored.memberships : undefined;
  let held: StoredMemberships | undefined;
  let judging: JudgingNote | undefined;
  const priorStakes = previous.kind === "ok" ? previous.stored.stakes : undefined;
  let heldStakes: StoredStakes | undefined;
  let judgingStakes: StakesNote | undefined;
  if (request.judge !== undefined || prior !== undefined) {
    // Which pairs are asked is decided by code alone (see narrow); a model is asked only about those.
    const units = unitsOf(graph, base.tree);
    const narrowed = narrow(units, vocabulary.terms, base.tree);
    if (request.judge === undefined) held = reconcile(prior!, units, narrowed, vocabulary.terms, base.tree);
    else {
      const maxPairs = deps.maxPairs ?? MAX_PAIRS;
      const outcome = await judgeMemberships({ pairs: narrowed.pairs, tree: base.tree, previous: new Map<string, MembershipRecord>((prior?.records ?? []).map((record) => [pairKey(record.unit, record.term), record])), client: request.judge, maxPairs });
      held = buildMemberships(units, narrowed, outcome, request.judge.model);
      judging = { status: "judged", asked: outcome.asked, reused: outcome.reused, notJudged: outcome.notJudged.length, ...(outcome.notJudged[0] === undefined ? {} : { firstFailure: outcome.notJudged[0].reason }), overLimit: outcome.overLimit, maxPairs, usd: outcome.usd, costUnknown: outcome.costUnknown };
    }
    // Stakes are judged over the memberships just made: a term's code is the functions mapped to it now.
    if (request.judge !== undefined || priorStakes !== undefined) {
      const entries = termMembers(held!, units, vocabulary.terms);
      const choice = deps.kindChoice ?? chosenKinds(await readKindsFile());
      if (request.judge === undefined) heldStakes = reconcileStakes(priorStakes!, entries, base.tree, choice);
      else {
        const maxStakePairs = deps.maxStakePairs ?? MAX_STAKES_PAIRS;
        const outcome = await judgeStakes({
          terms: entries,
          tree: base.tree,
          effects: effectSets(graph),
          previous: new Map<string, StakeRecord>((priorStakes?.records ?? []).map((record) => [stakePairKey(record.term, record.kind), record])),
          client: request.judge,
          maxPairs: maxStakePairs,
          kinds: HARM_CATALOGUE.filter((kind) => choice.asked.includes(kind.id)),
        });
        heldStakes = buildStakes(entries, outcome, choice, request.judge.model, maxStakePairs);
        judgingStakes = { asked: outcome.asked, reused: outcome.reused, notJudged: outcome.notJudged.length, ...(outcome.notJudged[0] === undefined ? {} : { firstFailure: outcome.notJudged[0].reason }), overLimit: outcome.overLimit, maxPairs: maxStakePairs, usd: outcome.usd, costUnknown: outcome.costUnknown };
      }
    }
  }
  const stored: StoredVocabulary = {
    ...(previous.kind === "ok" ? previous.whole : {}),
    format: FORMAT,
    tier: "derived",
    repo: identity.name,
    base: { ref, commit: base.commit },
    extractorVersion: graph.extractorVersion,
    files: Object.fromEntries(files),
    pathsWithheld: [...files.keys()].filter((path) => path.startsWith("/")).length,
    coverage: coverageOf(graph.nodes.filter((node) => node.level === "file" && node.analysis === "analysed" && node.role !== "generated").length, held),
    vocabulary: storable(vocabulary),
    ...(held === undefined ? {} : { memberships: held }),
    ...(heldStakes === undefined ? {} : { stakes: heldStakes }),
  };
  // A judged run over a repository nothing changed in, whose answers are all current, has nothing to write.
  if (work === "unchanged" && previous.kind === "ok" && JSON.stringify([stored.memberships, stored.stakes, stored.coverage]) === JSON.stringify([previous.stored.memberships, previous.stored.stakes, previous.stored.coverage])) {
    return { work, file, ref, stored: previous.stored, previousCommit: previous.stored.base.commit, ...(judging === undefined ? {} : { judging }), ...(judgingStakes === undefined ? {} : { judgingStakes }) };
  }
  await mkdir(dirname(file), { recursive: true });
  // A whole file or none: another run, or a reader, never sees half of one.
  const scratch = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(scratch, `${JSON.stringify(stored, null, 2)}\n`);
    await rename(scratch, file);
  } catch (error) {
    await rm(scratch, { force: true });
    throw new Error(`cannot store the vocabulary in ${file}: ${(error as Error).message}`, { cause: error });
  }
  return {
    work,
    file,
    ref,
    stored,
    ...(why === undefined ? {} : { why }),
    ...(previous.kind === "ok" ? { previousCommit: previous.stored.base.commit, ...(work === "rebuilt" ? { files: countChanges(before, files) } : {}) } : {}),
    ...(judging === undefined ? {} : { judging }),
    ...(judgingStakes === undefined ? {} : { judgingStakes }),
  };
}

const short = (commit: string): string => commit.slice(0, 7);
const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;
const MAX_UNREAD_SHOWN = 10;

/**
 * Code files whose members could not be looked at: text files no adapter reads, and unread files that are not Markdown or a
 * manifest. A term that no read file maps to may have members in these, so it is "not known", never "no members".
 */
function codeFilesUnread(vocabulary: Vocabulary): number {
  return vocabulary.notAnalysed + vocabulary.unread.filter((one) => !one.path.endsWith(".md") && basename(one.path) !== "package.json").length;
}

/** What setup tells the reviewer, one line each. An unknown status is never shown as a count of zero. */
export function reportLines(result: SetupResult): string[] {
  const { stored } = result;
  const { vocabulary } = stored;
  const lines = [`streets setup: ${stored.repo}, base ${stored.base.ref} at ${short(stored.base.commit)}`];
  const fileCount = Object.keys(stored.files).length;
  switch (result.work) {
    case "first setup":
      lines.push(`  built from nothing: ${plural(fileCount, "file")} read`);
      break;
    case "unchanged":
      lines.push(`  nothing redone: no file changed since the setup at ${short(result.previousCommit ?? stored.base.commit)}, and the rules are the same`);
      break;
    case "rebuilt": {
      const { added = 0, changed = 0, removed = 0 } = result.files ?? {};
      lines.push(`  redone: ${added} added, ${changed} changed, ${removed} removed since the setup at ${short(result.previousCommit ?? "")}; a term can come from any file, so the terms were collected again over the whole base`);
      break;
    }
    case "rules changed":
      lines.push(`  redone from nothing: ${result.why}`);
      break;
    case "replaced unreadable":
      lines.push(`  the stored vocabulary could not be read (${result.why}), so it was built again from nothing`);
      break;
  }
  lines.push(`  stored: ${result.file}`);
  if (vocabulary.status === "found") lines.push(`  terms: ${vocabulary.terms.length}`);
  else if (vocabulary.status === "none") lines.push("  no terms: everything was read and the repository wrote none");
  else lines.push(`  terms: unknown, which is not none and not zero: ${vocabulary.reason ?? "something could not be read"}`);
  const rules = new Map<string, number>();
  for (const term of vocabulary.dropped.terms) rules.set(term.rule, (rules.get(term.rule) ?? 0) + 1);
  lines.push(`  dropped: ${vocabulary.dropped.count}${rules.size === 0 ? "" : ` (${[...rules].map(([rule, count]) => `${count} ${rule}`).join(", ")})`}`);
  const { skipped } = vocabulary;
  lines.push(
    `  skipped: ${skipped.tooLong} too long, ${skipped.withheld} withheld as secret-shaped, ${skipped.notAWord} not a word, ${skipped.hiddenFolders} hidden folders, ${skipped.generated} generated, ${skipped.notLiteral} test titles not a literal, ${skipped.wildcard} wildcard re-exports`,
  );
  lines.push(`  unread: ${vocabulary.unread.length}`);
  for (const one of vocabulary.unread.slice(0, MAX_UNREAD_SHOWN)) lines.push(`    ${one.path}: ${one.reason}`);
  if (vocabulary.unread.length > MAX_UNREAD_SHOWN) lines.push(`    and ${vocabulary.unread.length - MAX_UNREAD_SHOWN} more`);
  lines.push(`  not analysed: ${vocabulary.notAnalysed} text files in a language no adapter reads`);
  if (stored.pathsWithheld > 0) lines.push(`  paths withheld: ${stored.pathsWithheld} (a part of the path is shaped like a secret, so the path is not stored)`);
  lines.push(...membershipLines(stored.memberships, stored.coverage, vocabulary.terms, result.judging, vocabulary.notAnalysed + vocabulary.unread.length, codeFilesUnread(vocabulary)));
  lines.push(...stakesLines(stored.stakes, vocabulary.terms, result.judgingStakes, stored.memberships !== undefined));
  return lines;
}

/**
 * What `streets compare` says about the vocabulary, or undefined when it has nothing to say: the
 * comparison works without one, and this only tells the reviewer it is missing or out of date.
 */
export async function vocabularyNotice(dir: string, cacheDir: string): Promise<string | undefined> {
  let identity: Identity;
  try {
    identity = await repoIdentity(dir);
  } catch {
    return undefined;
  }
  const previous = await readStored(fileFor(cacheDir, identity.key));
  if (previous.kind === "missing") return "no vocabulary for this repository, so the page speaks in files and not in terms: run `streets setup` to build one";
  if (previous.kind === "unreadable") return `the stored vocabulary could not be read (${previous.why}): run \`streets setup\` to build it again`;
  const { tableVersion } = previous.stored.vocabulary;
  const { extractorVersion } = previous.stored;
  const rules = tableVersion !== VOCABULARY_TABLE_VERSION ? [tableVersion < VOCABULARY_TABLE_VERSION, `table ${tableVersion}, this version uses ${VOCABULARY_TABLE_VERSION}`] : extractorVersion !== EXTRACTOR_VERSION ? [Number(extractorVersion) < Number(EXTRACTOR_VERSION), `extractor ${extractorVersion}, this version uses ${EXTRACTOR_VERSION}`] : undefined;
  if (rules === undefined) return undefined;
  return `the stored vocabulary was built with ${rules[0] ? "older" : "newer"} rules (${rules[1]}): run \`streets setup\` to build it again`;
}
