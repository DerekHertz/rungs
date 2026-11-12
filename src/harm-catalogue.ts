import type { ResourceKind } from "./graph.ts";

/**
 * The kinds of harm a mistake in code can cause. It ships with Systems to Streets, is the same for
 * every repository and names none. Hand-maintained data, reviewed as text: change an entry or add
 * one and raise HARM_CATALOGUE_VERSION and append the new hash to test/harm-catalogue-versions.json,
 * so a stored answer says which catalogue its kinds came from (the effects catalogue works the same
 * way, through EXTRACTOR_VERSION and test/effect-catalog-versions.json).
 */
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
  /** Stable key, never reused for another kind. */
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
   * Jev. Unknown stays unknown: a kind Jev misses the bar on is shown as not judged, never as no.
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
    yes: "A mistake in this code could let a user or caller read or change something they are not allowed to, or skip a check of who may do what.",
    no: "This code makes or relies on no decision about who may do what, or a mistake in it could not widen anyone's access.",
    answer: "judgement",
    facts: [],
  },
  {
    id: "cryptography-and-secrets",
    name: "cryptography and secrets",
    group: "security",
    yes: "A mistake in this code could weaken encryption, hashing or random values, or expose a key, token, password or other secret.",
    no: "This code handles no secret and does no encryption, hashing or random-value work that protects something.",
    answer: "judgement",
    facts: [],
  },
  {
    id: "injection",
    name: "injection",
    group: "security",
    yes: "A mistake in this code could let outside input be run or read as a command, query, path or markup instead of as plain data.",
    no: "This code never passes outside input into a command, query, path or markup, or it passes it only as escaped or fixed data.",
    answer: "judgement",
    facts: ["effects on a process", "effects on the file system"],
  },
  {
    id: "insecure-design",
    name: "insecure design",
    group: "security",
    yes: "A mistake in this code could remove a safeguard the design depends on, such as a limit, a check, a trust boundary or a safe default.",
    no: "This code is not a safeguard and holds no limit, check, trust boundary or safe default that the rest of the design relies on.",
    answer: "judgement",
    facts: [],
  },
  {
    id: "misconfiguration",
    name: "misconfiguration",
    group: "security",
    yes: "A mistake in this code could ship an unsafe setting, default, permission, debug mode or exposed service.",
    no: "This code sets no default, permission, mode or exposure, or a mistake in it would only change something harmless.",
    answer: "judgement",
    facts: [],
  },
  {
    id: "vulnerable-dependencies",
    name: "vulnerable dependencies",
    group: "security",
    yes: "The change adds, removes or changes a declared dependency: its name, its version range or the list it is in.",
    no: "The change leaves every declared dependency exactly as it was.",
    answer: "code",
    facts: ["dependency changes"],
  },
  {
    id: "authentication",
    name: "authentication",
    group: "security",
    yes: "A mistake in this code could let someone sign in as another user, skip sign-in, or keep a session or credential longer than intended.",
    no: "This code takes no part in proving who a user is, or in creating, checking or ending a session or credential.",
    answer: "judgement",
    facts: [],
  },
  {
    id: "supply-chain-and-build-integrity",
    name: "supply chain and build integrity",
    group: "security",
    yes: "A mistake in this code could let untrusted code or a tampered artifact into what is built, installed, released or deployed.",
    no: "This code is not part of how the project is built, installed, released or deployed, and brings in nothing from outside.",
    answer: "judgement",
    facts: ["dependency changes"],
  },
  {
    id: "logging",
    name: "logging",
    group: "security",
    yes: "A mistake in this code could drop a record needed to see what happened, or write something sensitive into a log or error message.",
    no: "This code writes no log, audit record or error message, and decides nothing about what is recorded.",
    answer: "judgement",
    facts: [],
  },
  {
    id: "server-side-request-forgery",
    name: "server-side request forgery",
    group: "security",
    yes: "A mistake in this code could let outside input choose the address this server calls, so it reaches a place it should not.",
    no: "This code makes no request to another address, or the address is fixed or checked against an allowed list.",
    answer: "judgement",
    facts: ["effects on the network"],
  },
  {
    id: "data-loss-or-corruption",
    name: "data loss or corruption",
    group: "other",
    yes: "A mistake in this code could delete, overwrite, truncate or garble stored data, or save data that is wrong or half written.",
    no: "This code only reads data, or writes only what can be rebuilt and is never the sole copy.",
    answer: "judgement",
    facts: ["effects on the file system"],
  },
  {
    id: "privacy",
    name: "privacy",
    group: "other",
    yes: "A mistake in this code could collect, keep, show or send personal data to someone who should not have it.",
    no: "This code touches no personal data and sends nothing about a person anywhere.",
    answer: "judgement",
    facts: ["effects on the network"],
  },
  {
    id: "availability",
    name: "availability",
    group: "other",
    yes: "A mistake in this code could make the program or service crash, hang, run out of resources or refuse to serve users.",
    no: "A mistake in this code could not stop the program or service from running, or it runs only offline and in the background.",
    answer: "judgement",
    facts: ["effects on a process", "effects on the network"],
  },
  {
    id: "money",
    name: "money",
    group: "other",
    yes: "A mistake in this code could charge, pay out or price something wrongly, or lose or double count an amount of money.",
    no: "This code handles no price, balance, payment, bill or other amount of money.",
    answer: "judgement",
    facts: [],
  },
  {
    id: "compatibility-for-callers",
    name: "compatibility for callers",
    group: "other",
    yes: "A mistake in this code could break something that calls it from outside, such as another program, a script or a stored format.",
    no: "This code has no caller outside this repository, and no stored or published format depends on it.",
    answer: "judgement",
    facts: [],
  },
  {
    id: "what-users-see",
    name: "what users see",
    group: "other",
    yes: "A mistake in this code could show a user something wrong, missing, confusing or broken in what they read or use.",
    no: "This code never reaches a screen, message or output that a person reads.",
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
