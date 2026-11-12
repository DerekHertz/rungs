import type { Comparison, ContractMove } from "../compare.ts";
import type { FileTree, NodeId } from "../graph.ts";
import type { Standards } from "../standards.ts";

/** Which file owns a node, and the node's own name, by node identity: ids are never taken apart by string. */
export type Owners = ReadonlyMap<NodeId, { readonly path: string; readonly name: string }>;

/** One claim as the claims document lists it: `index` is its place in /claims.json's `claims`. */
export interface ClaimSubject {
  readonly index: number;
  /** The description's own words behind the claim (a restatement is the agent's, and loses detail). */
  readonly text: string;
  /** The changed files the agent linked to it; none means the claim is not judged. */
  readonly ids: readonly NodeId[];
}

/** What the server hands a gate runner: the comparison, the derived facts already computed from it, and the claims with their links. */
export interface JudgeSubject {
  readonly comparison: Comparison;
  readonly contracts: readonly ContractMove[];
  readonly claims: readonly ClaimSubject[];
  readonly baseTree: FileTree;
  readonly headTree: FileTree;
  /** Owners of the head graph's nodes, and of the base graph's. */
  readonly head: Owners;
  readonly base: Owners;
  /** The written rules of the base (see collectStandards): the standard gate's rules. */
  readonly standards: Standards;
}
