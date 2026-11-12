import { count, effectsText, restsOnIt, testReachText } from "./defining.ts";
import type { Why } from "./defining.ts";
import type { LineRange, NodeId } from "./graph.ts";

/*
 * The file card: what a selected file is and why to care, as a fixed template filled with facts and
 * no generated sentence. This module is free of node:* and of the DOM, so the server's document
 * (src/vocabulary-doc.ts), the page and the tests share it.
 *
 * Tiers, never mixed (SPEC rule 2): a file's terms are judged (a classifier's probability that a
 * function belongs to a term, stored by `streets setup --judge`); the vocabulary's own words and
 * their lines are derived; the role, what rests on the file and what the change did to it are derived.
 * A state that is not known is said as exactly that: no vocabulary, not judged, stale. It is never
 * "no terms", which is said only of a file whose every function was judged and belongs to none.
 */

/** A term and the best probability that one of a file's functions belongs to it. */
export interface DocTermRef {
  readonly key: string;
  readonly name: string;
  /** Jev's probability that the code belongs to the term, 0 to 1. */
  readonly probability: number;
}

/** What is known of the terms of a file's functions, classes and constants in the head. */
export interface DocFile {
  readonly path: string;
  /** Terms with a current member in this file, strongest first. */
  readonly terms: readonly DocTermRef[];
  readonly units: {
    readonly total: number;
    readonly withTerm: number;
    /** No answer for it: the function is new since the vocabulary was built, or its pair was never judged. */
    readonly notJudged: number;
    /** Its answer is out of date: the function changed since it was judged. */
    readonly stale: number;
    /** Every candidate the narrowing rule picked has a current judgement, and none is mapped. */
    readonly noTerm: number;
    /** No term shares a word with it, by the narrowing rule (derived): nothing was asked of the classifier, so it is not "judged". */
    readonly noCandidate: number;
  };
  /** The units with a current term, by node id, so an entry about one function can name its terms. */
  readonly members: readonly { readonly id: NodeId; readonly terms: readonly DocTermRef[] }[];
}

/** One place a term was written, as the vocabulary pinned it (derived). */
export interface DocPin {
  readonly source: string;
  /** Null when the path was withheld (it was shaped like a secret): the page says "withheld". */
  readonly path: string | null;
  readonly range: LineRange | null;
  readonly written: string;
  /** The head's file to open for it; present only when the head's file is the file the pin was read from (its digest equals the stored one). */
  readonly id?: NodeId;
  /** Why it cannot be opened, when it cannot: "the file changed since setup", "the file is not in this tree" or "the path was withheld". Absent for a folder. */
  readonly why?: string;
}

/** A function, class or constant judged a member of a term (judged), with how sure the classifier was. */
export interface DocMember {
  readonly path: string | null;
  readonly name: string | null;
  readonly level: string;
  readonly probability: number;
  /** "stale": the function changed (or is gone) since it was judged, so it is not counted. */
  readonly state: "member" | "stale";
  readonly why?: string;
  /** The head's node to open for it. */
  readonly id?: NodeId;
}

export interface DocTerm {
  readonly key: string;
  readonly name: string;
  /** "has members", "no members" or "not known": never "no members" while a pair is not judged. */
  readonly summary: { readonly kind: "has members" | "no members" | "not known"; readonly why: string };
  readonly pins: readonly DocPin[];
  readonly members: readonly DocMember[];
  /** Members left out of the list to keep the document short, counted and never dropped silently. */
  readonly membersOmitted?: number;
}

/** `GET /vocabulary.json`: the stored vocabulary read against the head's tree. */
export interface VocabularyDoc {
  /** The vocabulary and its pins are derived; memberships (`judged`) are a judged fact, shown as such. */
  readonly tier: "derived";
  /** "none": nothing stored for the repository. "unreadable": a stored file that cannot be trusted. */
  readonly state: "none" | "unreadable" | "stored";
  readonly why?: string;
  /** Set when the stored vocabulary was built with other rules than this version's. */
  readonly rules?: string;
  readonly built?: { readonly ref: string; readonly commit: string };
  readonly termsStatus?: "found" | "none" | "unknown";
  readonly reason?: string;
  /** Whether `streets setup --judge` has stored memberships. */
  readonly judged: boolean;
  readonly model?: string;
  readonly terms: readonly DocTerm[];
  /** Files whose path was withheld from the store. */
  readonly withheldPaths: number;
  readonly files: readonly DocFile[];
}

/** A probability for people: floored, so an answer that is not certain never reads as 100%. */
export const percent = (probability: number): string => `${Math.floor(probability * 100)}%`;

/** A stored path or name that was withheld reads as "withheld". */
export const shownPath = (path: string | null): string => (path === null ? "withheld" : path);

export interface TermChip {
  readonly key: string;
  readonly name: string;
  readonly text: string;
}

export interface TermsLine {
  readonly chips: readonly TermChip[];
  /** What is not a chip: a state, or what is unknown beside the chips. */
  readonly text: string;
  /** A caveat about the vocabulary as a whole. */
  readonly note?: string;
}

const NO_VOCABULARY = "no vocabulary yet (run streets setup)";
const UNITS = "functions, classes and constants";

/** The terms line of a file: its terms with their probabilities, or exactly why there are none to show. */
export function termsLine(doc: VocabularyDoc | null | undefined, file: DocFile | undefined, unread = false): TermsLine {
  if (doc === null) return { chips: [], text: "vocabulary unavailable: the page could not load it" };
  if (doc === undefined || doc.state === "none") return { chips: [], text: NO_VOCABULARY };
  if (doc.state === "unreadable") return { chips: [], text: `the stored vocabulary could not be read (${doc.why ?? "unknown reason"}): run streets setup` };
  const note = doc.rules === undefined ? {} : { note: `built with other rules (${doc.rules}): run streets setup` };
  const say = (text: string, chips: readonly TermChip[] = []): TermsLine => ({ chips, text, ...note });
  if (doc.terms.length === 0 && doc.termsStatus === "none") return say("no terms: everything was read and the repository wrote none");
  if (doc.terms.length === 0 && doc.termsStatus === "unknown") return say(`terms unknown: ${doc.reason ?? "something could not be read"}`);
  if (!doc.judged) return say("not judged (run streets setup --judge)");
  if (unread) return say("not judged: the file could not be read");
  const units = file?.units;
  const chips = (file?.terms ?? []).map((term) => ({ key: term.key, name: term.name, text: `${term.name} ${percent(term.probability)}` }));
  const stale = units?.stale ?? 0;
  const notJudged = units?.notJudged ?? 0;
  if (chips.length > 0) return say([notJudged > 0 ? `${notJudged} of ${units!.total} ${UNITS} not judged` : "", stale > 0 ? `${stale} stale` : ""].filter((part) => part !== "").join(", "), chips);
  if (units === undefined || units.total === 0) return say(`no function, class or constant in it to map to a term`);
  if (doc.rules !== undefined && stale > 0) return say("stale (rules changed: run streets setup)");
  if (notJudged > 0) return say(stale > 0 ? `not judged, ${stale} stale` : "not judged");
  if (stale > 0) return say("stale: the function changed since it was judged");
  const { total, noTerm, noCandidate } = units;
  if (noTerm === 0) return say(total === 1 ? "no candidate term: no term shares a word with its function, class or constant" : `no candidate term: no term shares a word with any of its ${total} ${UNITS}`);
  if (noCandidate === 0) return say(total === 1 ? "no term: its function, class or constant was judged and is not mapped to one" : `no term: all ${total} ${UNITS} were judged and none is mapped to one`);
  return say(`no term: ${noTerm} of ${total} ${UNITS} judged and none is mapped to one, ${noCandidate} with no candidate term`);
}

/** What a file's harm is, judged. Stakes are not built yet (#199): until they are, the card has no such row. */
export interface Stakes {
  readonly harms: readonly { readonly kind: string; readonly probability: number }[];
}

export type CardTier = "judged" | "derived";

export interface CardLine {
  readonly label: string;
  readonly tier: CardTier;
  readonly text: string;
  /** Clickable terms, for the terms line. */
  readonly chips?: readonly TermChip[];
  readonly note?: string;
  /** The list behind a count, one entry each. Absent when there is none. */
  readonly list?: readonly string[];
}

export interface CardRow {
  readonly id: "is" | "rests" | "harm" | "did";
  readonly label: string;
  readonly lines: readonly CardLine[];
}

/**
 * The harm row: the kinds of harm a mistake in the file could do, judged. STAKES (#199): this is
 * the one place the row is made. Called with nothing it returns nothing, and the card omits it,
 * never an empty row.
 */
export function harmRow(stakes?: Stakes): CardRow | undefined {
  if (stakes === undefined || stakes.harms.length === 0) return undefined;
  return { id: "harm", label: "What kind of harm a mistake here could do", lines: [{ label: "harm", tier: "judged", text: stakes.harms.map((harm) => `${harm.kind} ${percent(harm.probability)}`).join(", ") }] };
}

export interface CardInput {
  readonly doc: VocabularyDoc | null | undefined;
  /** The file's entry in the vocabulary document; undefined when it has none. */
  readonly file: DocFile | undefined;
  /** The file's role, or undefined for a file the table does not recognise. */
  readonly role: string | undefined;
  /** What the comparison did to the file: added, altered, moved. */
  readonly kind?: string;
  readonly why: Why;
  /** Optional until stakes exist (#199). */
  readonly stakes?: Stakes;
}

/** The card: what it is, what rests on it, what harm a mistake could do (when stakes exist), what this change did to it. */
export function fileCard(input: CardInput): CardRow[] {
  const { why } = input;
  const terms = termsLine(input.doc, input.file, why.unread);
  const rests = why.dependents.length === 0 && why.unknownDependents === 0 ? "no file rests on it" : restsOnIt(why.dependents.length, why.unknownDependents);
  const did: CardLine[] = [];
  const add = (text: string, list: readonly string[] = []): void => {
    did.push({ label: "", tier: "derived", text, ...(list.length === 0 ? {} : { list }) });
  };
  if (input.kind !== undefined) add(input.kind);
  if (why.unread) add("could not read: contracts and effects not compared");
  else {
    add(why.contracts.length === 0 ? "no contract moved" : `${count(why.contracts.length, "contract")} moved`, why.contracts);
    add(effectsText(why.effects), why.effects);
  }
  add(testReachText(why), why.testReaches);
  const harm = harmRow(input.stakes);
  return [
    {
      id: "is",
      label: "What it is",
      lines: [
        { label: "terms", tier: "judged", text: terms.text, chips: terms.chips, ...(terms.note === undefined ? {} : { note: terms.note }) },
        { label: "role", tier: "derived", text: input.role ?? "no role: the path matches no convention" },
      ],
    },
    { id: "rests", label: "What rests on it", lines: [{ label: "files", tier: "derived", text: rests, ...(why.dependents.length === 0 ? {} : { list: why.dependents }) }] },
    ...(harm === undefined ? [] : [harm]),
    { id: "did", label: "What this change did to it", lines: did },
  ];
}

/**
 * The names of the terms the thing a risk or contract entry is about belongs to: a function's own
 * terms, or a file's when the entry is about the file. A function that belongs to none names none;
 * the file's terms are never borrowed for it. Empty without a vocabulary, never a guess.
 */
export function termsNaming(doc: VocabularyDoc | null | undefined, path: string, ids: readonly NodeId[]): string[] {
  const file = doc?.state === "stored" ? doc.files.find((one) => one.path === path) : undefined;
  if (file === undefined) return [];
  const names = new Set<string>();
  for (const id of ids) {
    const refs = id === `file:${path}` ? file.terms : (file.members.find((member) => member.id === id)?.terms ?? []);
    for (const ref of refs) names.add(ref.name);
  }
  return [...names];
}
