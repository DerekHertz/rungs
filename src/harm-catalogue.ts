import type { ResourceKind } from "./graph.ts";

/**
 * The kinds of harm a mistake in code can cause. It ships with Systems to Streets, is the same for
 * every repository and names none. Hand-maintained data, reviewed as text: change an entry or add
 * one and raise HARM_CATALOGUE_VERSION and append the new hash to test/harm-catalogue-versions.json,
 * so a stored answer says which catalogue its kinds came from (the effects catalogue works the same
 * way, through EXTRACTOR_VERSION and test/effect-catalog-versions.json).
 */
// Version 1's ledger entry was rewritten once, in review of the pull request that introduced the
// catalogue, before any release or any stored answer used it. From the first merge on, an entry
// is never edited: change the catalogue, bump this and append a new entry.
export const HARM_CATALOGUE_VERSION = 1;

/**
 * A fact Systems to Streets already derives, by the name the catalogue uses for it. `module` and
 * `function` say where it is computed, so a rename cannot leave a kind pointing at nothing; for
 * an effect, `resource` is the resource kind its edges reach.
 */
export interface DerivedFact {
  readonly module: string;
  readonly function: string;
  readonly resource?: ResourceKind;
}

export const DERIVED_FACTS = {
  "dependency changes": { module: "src/dependencies.ts", function: "diffDependencies" },
  "effects on a process": { module: "src/effects.ts", function: "changedEffects", resource: "process" },
  "effects on the file system": { module: "src/effects.ts", function: "changedEffects", resource: "file system" },
  "effects on the network": { module: "src/effects.ts", function: "changedEffects", resource: "network" },
} as const satisfies Readonly<Record<string, DerivedFact>>;

export type DerivedFactName = keyof typeof DERIVED_FACTS;

export interface HarmKind {
  /** Stable key, never reused for another kind once a version has shipped. */
  readonly id: string;
  readonly name: string;
  /** "security" is OWASP's Top 10; "other" is the rest. */
  readonly group: "security" | "other";
  /** The yes criteria of a Jev question "could a mistake here cause this harm?". Plain and short. */
  readonly yes: string;
  /** The no criteria of that question. */
  readonly no: string;
  /**
   * "code": a derived fact answers it exactly, and Jev is never asked. "judgement": it needs
   * Jev. No kind is "code" yet: a dependency change is exact but "vulnerable" is not (removing an
   * unused dependency is a change, a vulnerable call into an unchanged one is not), and an
   * unreadable manifest is unknown, not "no change" (diffDependencies returns nothing for it).
   * Unknown stays unknown: a kind Jev misses the bar on is shown as not judged, never as no.
   */
  readonly answer: "code" | "judgement";
  /**
   * The derived facts that bear on this kind. For "code" they are the whole answer (at least
   * one). For "judgement" they are what code already knows and shows beside the question.
   */
  readonly facts: readonly DerivedFactName[];
}

export const HARM_CATALOGUE: readonly HarmKind[] = [
  {
    id: "access-control",
    name: "access control",
    group: "security",
    yes: "A mistake in this code could let a user or caller read or change something they are not allowed to, or skip a check of who may do what. Code that makes or changes such a check counts.",
    no: "This code takes no part in deciding who may do what, and the change alters no check of who may do what; it changes no one's access.",
    answer: "judgement",
    facts: [],
  },
  {
    id: "cryptography-and-secrets",
    name: "cryptography and secrets",
    group: "security",
    yes: "A mistake in this code could weaken encryption, hashing, certificate checks or random values, or expose a key, token, password or other secret. Code that makes or changes such protection counts.",
    no: "This code handles no secret and protects nothing with encryption, hashing or random values, and the change alters no such protection; it changes none.",
    answer: "judgement",
    facts: [],
  },
  {
    id: "injection",
    name: "injection",
    group: "security",
    yes: "A mistake in this code could let outside input be run or read as a command, query, path, markup or serialized object instead of plain data. Code that escapes, validates or parameterises such input counts, since a mistake there causes it.",
    no: "No outside input can reach a command, query, path, markup or deserializer through this code, and the change alters no escaping, validation or parameterisation; it changes none.",
    answer: "judgement",
    facts: ["effects on a process", "effects on the file system"],
  },
  {
    id: "insecure-design",
    name: "insecure design",
    group: "security",
    yes: "A mistake in this code could remove or weaken a safeguard the design depends on, such as a limit, a check, a trust boundary or a safe default. Code that is such a safeguard counts.",
    no: "This code is not a safeguard and holds no limit, check, trust boundary or safe default that the design relies on; the change is no change to one.",
    answer: "judgement",
    facts: [],
  },
  {
    id: "misconfiguration",
    name: "misconfiguration",
    group: "security",
    yes: "A mistake in this code could ship an unsafe setting, default, permission, debug mode, error detail or exposed service. Code that sets or changes any of these counts.",
    no: "This code sets no default, permission, mode, error detail or exposure, and the change alters none; it changes no setting.",
    answer: "judgement",
    facts: [],
  },
  {
    id: "vulnerable-dependencies",
    name: "vulnerable dependencies",
    group: "security",
    yes: "A mistake in this code could bring in or keep a dependency with a known weakness, or use a vulnerable part of one. Adding, upgrading, downgrading, pinning or removing a declared dependency counts, and so does code that calls into one.",
    no: "The change touches no declared dependency and no code that calls into one; it changes no dependency use.",
    answer: "judgement",
    facts: ["dependency changes"],
  },
  {
    id: "authentication",
    name: "authentication",
    group: "security",
    yes: "A mistake in this code could let someone sign in as another user, skip sign-in, use a weak or reused credential, or keep a session or credential longer than intended. Code that makes or changes any of these counts.",
    no: "This code takes no part in proving who a user is, or in creating, checking, recovering or ending a session or credential, and the change alters none; it changes no such step.",
    answer: "judgement",
    facts: [],
  },
  {
    id: "software-and-data-integrity-failures",
    name: "software and data integrity failures",
    group: "security",
    yes: "A mistake in this code could let untrusted code, data or an update be trusted without a check: a tampered build, release or deploy, an unsigned update, an unverified pipeline step, or insecure deserialization at run time. Code that makes or changes such a check counts.",
    no: "This code is no part of how the project is built, installed, released, updated or deployed, trusts no code or data from outside, and the change alters no integrity check; it changes none.",
    answer: "judgement",
    facts: [],
  },
  {
    id: "security-logging-and-monitoring-failures",
    name: "security logging and monitoring failures",
    group: "security",
    yes: "A mistake in this code could drop a record or an alert needed to detect or answer an attack, loosen a monitoring threshold, or write something sensitive into a log or error message. Code that makes or changes logging, alerting or a threshold counts.",
    no: "This code writes no log, audit record, alert or error message and sets no monitoring threshold, and the change alters none; it changes nothing that is recorded or raised.",
    answer: "judgement",
    facts: [],
  },
  {
    id: "server-side-request-forgery",
    name: "server-side request forgery",
    group: "security",
    yes: "A mistake in this code could let outside input choose the address this server calls, so it reaches a place it should not. Code that checks an address or keeps an allow-list counts, since a mistake there causes it.",
    no: "This code makes no request to an address that outside input can influence, and the change alters no address check or allow-list; it changes none.",
    answer: "judgement",
    facts: ["effects on the network"],
  },
  {
    id: "data-loss-or-corruption",
    name: "data loss or corruption",
    group: "other",
    yes: "A mistake in this code could delete, overwrite, truncate or garble stored data, or save data that is wrong or half written, even if the data could be recovered or rebuilt.",
    no: "This code only reads data and writes, moves or deletes nothing stored, and the change alters no such write; it changes none.",
    answer: "judgement",
    facts: ["effects on the file system"],
  },
  {
    id: "privacy",
    name: "privacy",
    group: "other",
    yes: "A mistake in this code could collect, keep, show or send personal data to someone who should not have it. Code that decides who may see such data counts.",
    no: "This code touches no personal data and sends nothing about a person anywhere, and the change alters no rule about who sees it; it changes none.",
    answer: "judgement",
    facts: ["effects on the network"],
  },
  {
    id: "availability",
    name: "availability",
    group: "other",
    yes: "A mistake in this code could make a program or service crash, hang, loop without end, use unbounded memory, disk or time, or refuse to serve, wherever it runs.",
    no: "This code has no way to crash, hang, loop without end, use unbounded resources or block other work, and the change adds none; it changes no limit or timeout.",
    answer: "judgement",
    facts: ["effects on a process", "effects on the network"],
  },
  {
    id: "money",
    name: "money",
    group: "other",
    yes: "A mistake in this code could charge, pay out or price something wrongly, or lose or double count an amount of money. Code that rounds, converts or totals an amount counts.",
    no: "This code handles no price, balance, payment, bill or other amount of money, and the change alters none; it changes no amount.",
    answer: "judgement",
    facts: [],
  },
  {
    id: "compatibility-for-callers",
    name: "compatibility for callers",
    group: "other",
    yes: "A mistake in this code could break something that calls or reads it from outside, such as another program, a script, a stored or published format, or a command's output.",
    no: "Nothing outside this change calls or reads this code, its output or any format it writes, and the change alters none; it changes no interface.",
    answer: "judgement",
    facts: [],
  },
  {
    id: "what-users-see",
    name: "what users see",
    group: "other",
    yes: "A mistake in this code could show a user something wrong, missing, confusing or broken in what they read or use, including text, layout, messages and output.",
    no: "This code never reaches a screen, message or output that a person reads, and the change alters none; it changes no text or layout.",
    answer: "judgement",
    facts: [],
  },
];

const BY_ID: ReadonlyMap<string, HarmKind> = new Map(HARM_CATALOGUE.map((kind) => [kind.id, kind]));

export const harmKind = (id: string): HarmKind | undefined => BY_ID.get(id);

/** The text the ledger hashes: every entry and the fact registry, never the version itself, so a bump with no change keeps the hash. */
export function serializeHarmCatalogue(): string {
  return JSON.stringify({ kinds: HARM_CATALOGUE, facts: DERIVED_FACTS });
}
