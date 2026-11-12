import { extract } from "../extract/extract.ts";
import type { FileTree } from "../graph.ts";
import { collectVocabulary, keyOf } from "../vocabulary.ts";
import type { MembershipInput } from "./membership-gate.ts";
import { inputOf, unitsOf } from "./membership-source.ts";

/** Which term and which function a stored case is about. */
export interface MembershipPick {
  /** The term as a person would write it ("order flow"); it is looked up by its key, so case and plural do not matter. */
  readonly phrase: string;
  /** The file the function is written in. */
  readonly path: string;
  /** The function's, class's or constant's qualified name. */
  readonly unit: string;
}

/**
 * Builds what the membership gate judges for one stored case, the way `streets setup --judge`
 * builds it: the tree is extracted, the vocabulary is collected from it, and the term and the unit
 * are read from those with `inputOf`, the function the setup uses. Throws, naming what was not
 * found, when the term is not one the vocabulary collects or the unit is not one setup would ask about.
 */
export function membershipInputFor(tree: FileTree, pick: MembershipPick): MembershipInput {
  const graph = extract(tree);
  const vocabulary = collectVocabulary({ graph, tree });
  const key = keyOf(pick.phrase);
  const term = vocabulary.terms.find((one) => one.key === key);
  if (term === undefined) throw new Error(`"${pick.phrase}" is not a term of this tree (terms: ${vocabulary.terms.map((one) => one.name).join(", ")})`);
  const unit = unitsOf(graph, tree).find((one) => one.path === pick.path && one.name === pick.unit);
  if (unit === undefined) throw new Error(`${pick.unit} in ${pick.path} is not a unit setup asks about`);
  return inputOf({ unit, term }, tree);
}
