import { MAX_CANDIDATES } from "./jev/membership-source.ts";
import { certificationOf, effectOf, pairKeyOf, vocabularyDigest } from "./corrections.ts";
import type { CertificationState } from "./corrections.ts";
import { pairStatus } from "./memberships.ts";
import { withProposed } from "./propose.ts";
import type { StoredVocabulary } from "./setup.ts";
import { shown } from "./stored-names.ts";

/*
 * Certifying a stored vocabulary. THE RULE for what a certification stands on: the terms as the person was shown them
 * (`vocabularyDigest`), the corrections, and completeness. A vocabulary built from anything unread, stale, cut or not judged is
 * incomplete, and incomplete data is never certified: `streets vocabulary certify` refuses it and names why, and a vocabulary
 * certified earlier that has since become incomplete reads "certified ..., vocabulary changed since". Completeness is checked
 * here on its own and never inferred from the status "found", which only says that a term exists.
 */

type Stored = Pick<StoredVocabulary, "vocabulary" | "memberships" | "proposals" | "corrections" | "certification">;

const MAX_NAMED = 5;
const plural = (count: number, one: string): string => `${count} ${count === 1 ? one : `${one}s`}`;
const named = (paths: readonly string[]): string => `${paths.slice(0, MAX_NAMED).map(shown).join(", ")}${paths.length > MAX_NAMED ? `, and ${paths.length - MAX_NAMED} more` : ""}`;

/** The terms as everything reads them, and the model that proposed some. */
const reviewed = (stored: Stored) => ({ terms: withProposed(stored.vocabulary.terms, stored.proposals), model: stored.proposals?.model });

/**
 * What stands in the way of certifying, one phrase each, or none when the vocabulary is whole: terms that are unknown, files that could not be read (named),
 * code no adapter reads, and, once memberships were judged, pairs that are not judged, stale, or left out by the cap. A pair a person
 * answered, or whose term a person removed, is known and is not counted. `headUnread` is what the tree being drawn cannot read (shown
 * names), for the page.
 */
export function gapsOf(stored: Stored, headUnread: readonly string[] = []): string[] {
  const { vocabulary, memberships } = stored;
  const gaps: string[] = [];
  if (vocabulary.status === "unknown") gaps.push(`the terms are unknown, which is not none: ${shown(vocabulary.reason ?? "something could not be read")}`);
  if (vocabulary.unread.length > 0) gaps.push(`${plural(vocabulary.unread.length, "file")} could not be read: ${named(vocabulary.unread.map((one) => one.path))}`);
  if (vocabulary.notAnalysed > 0) gaps.push(`${plural(vocabulary.notAnalysed, "text file")} in a language no adapter reads, so its words were not collected`);
  if (headUnread.length > 0) gaps.push(`${plural(headUnread.length, "code file")} in this tree not read: ${named(headUnread)}`);
  if (memberships === undefined) return gaps;
  const effect = effectOf(reviewed(stored).terms, stored.corrections ?? []);
  /** A pair is known when a person answered it, or its term is gone. */
  const known = (unit: string, key: string): boolean => {
    const visible = effect.resolve(key);
    return visible === undefined || effect.pairs.has(pairKeyOf(unit, key)) || effect.pairs.has(pairKeyOf(unit, visible));
  };
  const records = new Map(memberships.records.map((record) => [pairKeyOf(record.unit, record.term), record]));
  let notJudged = 0;
  let stale = 0;
  let cut = 0;
  for (const unit of memberships.units) {
    for (const key of unit.candidates) {
      if (known(unit.key, key)) continue;
      const status = pairStatus(records.get(pairKeyOf(unit.key, key)));
      if (status === "not judged") notJudged += 1;
      else if (status === "stale") stale += 1;
    }
    for (const key of unit.cut) if (!known(unit.key, key)) cut += 1;
  }
  if (notJudged > 0) gaps.push(`${plural(notJudged, "pair")} not judged`);
  if (stale > 0) gaps.push(`${stale} ${stale === 1 ? "answer is" : "answers are"} stale`);
  if (cut > 0) gaps.push(`${plural(cut, "pair")} left out by the cap of ${MAX_CANDIDATES} per function`);
  return gaps;
}

/** The digest of what a person is shown of the terms in this store, for a certification to record. */
export const digestOfStored = (stored: Stored): string => vocabularyDigest(reviewed(stored).terms, reviewed(stored).model);

/** Whether the stored vocabulary is certified: the one answer for the command, the report and the page. */
export function certificationOfStored(stored: Stored, headUnread: readonly string[] = []): CertificationState {
  const { terms, model } = reviewed(stored);
  return certificationOf(terms, stored.corrections ?? [], stored.certification, { model, gaps: gapsOf(stored, headUnread) });
}
