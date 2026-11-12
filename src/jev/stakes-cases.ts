import { effectSets } from "../effects.ts";
import { extract } from "../extract/extract.ts";
import type { FileTree } from "../graph.ts";
import { harmKind } from "../harm-catalogue.ts";
import { collectVocabulary, keyOf } from "../vocabulary.ts";
import { unitsOf } from "./membership-source.ts";
import type { StakesInput } from "./stakes-gate.ts";
import { stakesInputOf } from "./stakes-source.ts";

/** Which term, which of its members and which kind of harm a stored case is about. */
export interface StakesPick {
  /** The term as a person would write it; it is looked up by its key, so case and plural do not matter. */
  readonly phrase: string;
  /** The catalogue id of the kind of harm. */
  readonly kind: string;
  /** The term's members, strongest mapping first: the file each is written in and its qualified name. */
  readonly members: readonly { readonly path: string; readonly unit: string }[];
}

/**
 * Builds what the stakes gate judges for one stored case, the way `streets setup --judge` builds it:
 * the tree is extracted, the vocabulary is collected from it, and the term and its members are read
 * from those and shown with `stakesInputOf`, the function the setup uses. A case's members are
 * picked by hand (a case is about the question, not about the membership edge). Throws, naming what
 * was not found, when the term is not one the vocabulary collects, a member is not a unit setup asks
 * about, or the kind is not in the catalogue.
 */
export function stakesInputFor(tree: FileTree, pick: StakesPick): StakesInput {
  const kind = harmKind(pick.kind);
  if (kind === undefined) throw new Error(`"${pick.kind}" is not a kind of harm in the catalogue`);
  const graph = extract(tree);
  const vocabulary = collectVocabulary({ graph, tree });
  const key = keyOf(pick.phrase);
  const term = vocabulary.terms.find((one) => one.key === key);
  if (term === undefined) throw new Error(`"${pick.phrase}" is not a term of this tree (terms: ${vocabulary.terms.map((one) => one.name).join(", ")})`);
  const units = unitsOf(graph, tree);
  const members = pick.members.map((one, at) => {
    const unit = units.find((found) => found.path === one.path && found.name === one.unit);
    if (unit === undefined) throw new Error(`${one.unit} in ${one.path} is not a unit setup asks about`);
    return { unit, belongs: 1 - at / 1000 };
  });
  return stakesInputOf({ kind, entry: { term, members, unknown: 0 }, tree, effects: effectSets(graph) });
}
