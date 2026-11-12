import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { certificationOf, certificationText, correctionsDigest, describeCorrection, effectOf, noLongerApply, vocabularyDigest } from "./corrections.ts";
import type { Certification, Correction, Effect } from "./corrections.ts";
import { EMPTY_ANSWER } from "./file-card.ts";
import { looksSecret } from "./prompt-safe.ts";
import { readStored, storeFile, termsOf, writeStored } from "./setup.ts";
import type { StoredVocabulary } from "./setup.ts";
import type { Term } from "./vocabulary.ts";
import { shown } from "./stored-names.ts";

const execFileAsync = promisify(execFile);

/*
 * `streets vocabulary <command>`: a person confirms, renames, merges or removes a term, corrects a
 * (function, term) pair, and certifies the vocabulary. The corrections are stored with the
 * vocabulary (src/corrections.ts) and win over judged answers. No model is called, and no key is
 * needed. Everything printed from the store goes through `shown`: text shaped like a secret is
 * withheld, as it is in setup's report. A stored file that cannot be read is reported and never
 * written over: only `streets setup` replaces it, and it copies the old file aside first.
 */

export const VOCABULARY_USAGE = `usage: streets vocabulary <command> [--dir <dir>] [--by <name>]
  list                          the terms, what was done to them, the corrections and whether it is certified
  confirm <term>                say the term is right
  rename <term> <name>          show the term under another name
  merge <term> <into>           fold the term into another: it takes the union of their members
  remove <term>                 take the term out: it is not shown and its answers do not count
  member <function> <term> yes|no   say whether a function belongs to a term (the function is its name,
                                path#name, or a full key such as function:src/a.ts#a)
  certify                       record that you looked at the terms and corrections as they are now
A <term> is its key or its name. --dir is the repository (default: here). --by is who you are; without it
the name comes from git config user.name, and never from the email. The vocabulary is the one
\`streets setup\` stored; a correction is kept by every later setup.`;

export interface CommandDeps {
  readonly cacheDir: string;
  /** The clock; the current time when left out. */
  readonly now?: () => Date;
  /** `git config user.name` of the repository; what git says when left out. */
  readonly gitName?: (dir: string) => Promise<string | undefined>;
}

export interface CommandResult {
  readonly code: number;
  readonly out: readonly string[];
  readonly err: readonly string[];
}

const done = (...out: string[]): CommandResult => ({ code: 0, out, err: [] });
const refuse = (...err: string[]): CommandResult => ({ code: 1, out: [], err });
const usage = (why: string): CommandResult => ({ code: 2, out: [], err: [why, VOCABULARY_USAGE] });

async function gitName(dir: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["config", "user.name"], { cwd: dir, encoding: "utf8" });
    return stdout.trim() === "" ? undefined : stdout.trim();
  } catch {
    return undefined;
  }
}

const MAX_NAME_CHARS = 80;

/** A name a person gives (their own, or a term's new one): short, one line, and nothing shaped like a secret, since it is stored and shown. */
function cleanName(text: string, what: string): { readonly name: string } | { readonly refused: string } {
  const name = text.trim();
  if (name === "") return { refused: `${what} is empty` };
  if (name.length > MAX_NAME_CHARS) return { refused: `${what} is longer than ${MAX_NAME_CHARS} characters` };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return { refused: `${what} has a control character in it` };
  if (looksSecret(name)) return { refused: `${what} is shaped like a secret, so it is not stored or shown` };
  return { name };
}

type Terms = readonly Term[];

/** The stored term a person means by `text`: a key exactly, else a name or spelling (as stored or as renamed) without regard to case. */
function findTerm(text: string, terms: Terms, effect: Effect): { readonly key: string } | { readonly refused: string } {
  const exact = terms.filter((term) => term.key === text);
  const lower = text.toLowerCase();
  const found = exact.length > 0 ? exact : terms.filter((term) => [term.name, effect.nameOf(term.key), ...term.spellings].some((name) => name.toLowerCase() === lower));
  if (found.length === 1) return { key: found[0]!.key };
  if (found.length === 0) return { refused: `no term is called "${shown(text)}": streets vocabulary list shows them` };
  return { refused: `"${shown(text)}" is the name of several terms, so give the key of one: ${found.map((term) => `${shown(term.key)} (${shown(effect.nameOf(term.key))})`).join(", ")}` };
}

type Found<T> = T | { readonly refused: string };
const refused = <T extends object>(value: Found<T>): value is { readonly refused: string } => "refused" in value;

/** The stored function a person means: its key, path#name or name, among the functions the store judged; a full key that the store has not seen is taken as typed. */
function findUnit(text: string, stored: StoredVocabulary): Found<{ readonly key: string; readonly label: string }> {
  const units = stored.memberships?.units ?? [];
  const tiers = [units.filter((unit) => unit.key === text), units.filter((unit) => `${unit.path}#${unit.name}` === text), units.filter((unit) => unit.name === text)];
  const found = tiers.find((tier) => tier.length > 0) ?? [];
  if (found.length === 1) return { key: found[0]!.key, label: `${shown(found[0]!.name)} in ${shown(found[0]!.path)}` };
  if (found.length > 1) return { refused: `"${shown(text)}" is several functions, so give path#name: ${found.map((unit) => `${shown(unit.path)}#${shown(unit.name)}`).join(", ")}` };
  if (/^(function|class|constant):./.test(text)) return { key: text, label: shown(text) };
  return { refused: `the store has not judged a function called "${shown(text)}": give a full key such as function:src/a.ts#a (the function's level, its path, #, its name)` };
}

/** The visible terms a model's word is part of: a model's proposal, or a term any part of which is one. */
const proposedKeys = (stored: StoredVocabulary, effect: Effect): Set<string> => {
  const claimed = new Set(termsOf(stored).filter((term) => term.claimed !== undefined).map((term) => term.key));
  return new Set([...effect.visible.keys()].filter((key) => effect.sources(key).some((source) => claimed.has(source))));
};

const listLines = (stored: StoredVocabulary, effect: Effect, corrections: readonly Correction[]): string[] => {
  const { vocabulary } = stored;
  const lines = [`streets vocabulary: ${shown(stored.repo)}, built from ${shown(stored.base.ref)} at ${stored.base.commit.slice(0, 7)}`];
  const all = termsOf(stored);
  const proposed = proposedKeys(stored, effect);
  lines.push(`  ${certificationText(certificationOf(all, corrections, stored.certification))}`);
  if (vocabulary.status === "unknown") lines.push(`  terms: unknown, which is not none and not zero: ${shown(vocabulary.reason ?? "something could not be read")}`);
  else lines.push(`  terms: ${effect.visible.size} shown${all.length === effect.visible.size ? "" : ` of ${all.length}`}${proposed.size === 0 ? "" : `, ${proposed.size} of them proposed by ${shown(stored.proposals?.model ?? "a model")}, or including a part it proposed (claimed)`}`);
  if (stored.proposals?.answered === 0) lines.push(`  ${EMPTY_ANSWER} (own words reached ${stored.proposals.basis.mapped} of ${stored.proposals.basis.of} files, under half)`);
  for (const term of effect.visible.values()) {
    const marks = [proposed.has(term.key) ? "proposed by a model (claimed)" : "", term.confirmed === undefined ? "" : `confirmed by ${shown(term.confirmed.by)} at ${term.confirmed.at}`, term.renamedFrom === undefined ? "" : `renamed from ${shown(term.renamedFrom)}`, term.mergedFrom === undefined ? "" : `merged in: ${term.mergedFrom.map(shown).join(", ")}`].filter((mark) => mark !== "");
    lines.push(`    ${shown(term.name)} (${shown(term.key)})${marks.length === 0 ? "" : `: ${marks.join("; ")}`}`);
  }
  const hidden = all.filter((term) => !effect.visible.has(term.key));
  if (hidden.length > 0) lines.push(`  removed or merged away: ${hidden.map((term) => `${shown(effect.nameOf(term.key))} (${shown(term.key)})`).join(", ")}`);
  // The functions a store judged are known to it; without judging the page checks them against the tree it draws.
  const gone = noLongerApply(effect, corrections, stored.memberships === undefined ? undefined : new Set(stored.memberships.units.map((unit) => unit.key)));
  lines.push(`  corrections: ${corrections.length}${corrections.length === 0 ? "" : `, ${gone.length} no longer apply`}`);
  for (const one of corrections) lines.push(`    ${one.at} ${shown(one.by)}: ${describeCorrection(one)}`);
  for (const one of gone) lines.push(`    no longer applies: ${describeCorrection(one.correction)} (${one.why})`);
  if (stored.memberships === undefined && corrections.some((one) => one.kind === "member")) lines.push("    (functions are not checked here: nothing was judged, so the page checks them against the tree it draws)");
  return lines;
};

/** `streets vocabulary ...`: what it prints and the exit code, for the caller to print and exit with. */
export async function vocabularyCommand(argv: readonly string[], deps: CommandDeps): Promise<CommandResult> {
  let parsed: ReturnType<typeof parseArgs<{ options: { dir: { type: "string" }; by: { type: "string" }; help: { type: "boolean" } }; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: [...argv], allowPositionals: true, options: { dir: { type: "string" }, by: { type: "string" }, help: { type: "boolean" } } });
  } catch (error) {
    return usage((error as Error).message);
  }
  const { values, positionals } = parsed;
  const [command, ...args] = positionals;
  if (values.help) return done(VOCABULARY_USAGE);
  if (command === undefined) return usage("streets vocabulary needs a command");
  const arity: Readonly<Record<string, number>> = { list: 0, confirm: 1, rename: 2, merge: 2, remove: 1, member: 3, certify: 0 };
  if (!Object.hasOwn(arity, command)) return usage(`unknown command "${shown(command)}"`);
  if (args.length !== arity[command]) return usage(`${command} takes ${arity[command]} argument${arity[command] === 1 ? "" : "s"}, not ${args.length}`);

  const dir = resolve(values.dir ?? ".");
  let file: string;
  try {
    file = await storeFile(dir, deps.cacheDir);
  } catch (error) {
    return refuse(`${(error as Error).message}`);
  }
  const previous = await readStored(file);
  if (previous.kind === "missing") return refuse("no vocabulary is stored for this repository: run `streets setup` first");
  if (previous.kind === "unreadable") return refuse(`the stored vocabulary could not be read (${shown(previous.why)}), so nothing was changed: run \`streets setup\`, which copies the old file aside before it builds a new one`);
  const { stored, whole } = previous;
  const corrections = stored.corrections ?? [];
  const effect = effectOf(termsOf(stored), corrections);
  if (command === "list") return done(...listLines(stored, effect, corrections));

  const who = values.by ?? (await (deps.gitName ?? gitName)(dir));
  if (who === undefined) return refuse("who is this? pass --by <name>, or set git config user.name (the email is never used)");
  const author = cleanName(who, "the name");
  if ("refused" in author) return refuse(author.refused);
  const stamp = { by: author.name, at: (deps.now ?? (() => new Date()))().toISOString() };
  const write = async (next: Record<string, unknown>): Promise<void> => writeStored(file, { ...whole, ...next });
  const named = (key: string): string => shown(effect.nameOf(key));

  if (command === "certify") {
    if (stored.vocabulary.status === "unknown") return refuse(`the terms are unknown, which is not none: ${shown(stored.vocabulary.reason ?? "something could not be read")}. Nothing was certified`);
    const state = certificationOf(termsOf(stored), corrections, stored.certification);
    if (state.kind === "certified") return done(`already certified: ${certificationText(state)}`);
    const certification: Certification = { ...stamp, vocabulary: vocabularyDigest(termsOf(stored)), corrections: correctionsDigest(corrections) };
    await write({ certification });
    const claimed = proposedKeys(stored, effect).size;
    return done(`certified by ${shown(stamp.by)} at ${stamp.at}: ${effect.visible.size} terms shown${claimed === 0 ? "" : ` (${claimed} proposed by a model, claimed, now vouched for by you)`}, ${corrections.length} corrections`);
  }

  const record = async (correction: Correction, say: string): Promise<CommandResult> => {
    await write({ corrections: [...corrections, correction] });
    return done(say);
  };
  if (command === "member") {
    const unit = findUnit(args[0]!, stored);
    if (refused(unit)) return refuse(unit.refused);
    const term = findTerm(args[1]!, termsOf(stored), effect);
    if (refused(term)) return refuse(term.refused);
    const answer = args[2];
    if (answer !== "yes" && answer !== "no") return usage(`member ends in yes or no, not "${shown(answer ?? "")}"`);
    const belongs = answer === "yes";
    return record({ ...stamp, kind: "member", unit: unit.key, term: term.key, belongs, label: `${unit.label}, term ${named(term.key)}` }, `${belongs ? "yes" : "no"}: ${unit.label} ${belongs ? "belongs to" : "does not belong to"} ${named(term.key)}`);
  }
  const first = findTerm(args[0]!, termsOf(stored), effect);
  if (refused(first)) return refuse(first.refused);
  const { key } = first;
  const label = named(key);
  switch (command) {
    case "confirm":
      return record({ ...stamp, kind: "confirm", term: key, label }, `confirmed ${label}`);
    case "remove": {
      const absorbed = termsOf(stored).filter((term) => term.key !== key && effect.resolve(term.key) === key);
      return record({ ...stamp, kind: "remove", term: key, label }, `removed ${label}${absorbed.length === 0 ? "" : `; merged into it, so removed with it: ${absorbed.map((term) => named(term.key)).join(", ")}`}`);
    }
    case "rename": {
      const name = cleanName(args[1]!, "the new name");
      if ("refused" in name) return refuse(name.refused);
      if (name.name === effect.nameOf(key)) return refuse(`it is already called ${label}`);
      return record({ ...stamp, kind: "rename", term: key, name: name.name, label }, `renamed ${label} to ${shown(name.name)}`);
    }
    default: {
      // merge
      const other = findTerm(args[1]!, termsOf(stored), effect);
      if (refused(other)) return refuse(other.refused);
      const into = other.key;
      if (into === key) return refuse("a term cannot be merged into itself");
      const target = effect.resolve(into);
      if (target === undefined) return refuse(`${named(into)} is removed (or merged into a removed term), so nothing can be merged into it: confirm it first`);
      if (target !== into) return refuse(`${named(into)} is merged into ${named(target)}: merge into that`);
      if (effect.sources(into).includes(key)) return refuse(`${named(into)} is already part of ${label}`);
      return record({ ...stamp, kind: "merge", term: key, into, label: `${label} into ${named(into)}` }, `merged ${label} into ${named(into)}`);
    }
  }
}
