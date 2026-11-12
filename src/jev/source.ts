import { treeDigest } from "../observed.ts";
import type { FileTree } from "../graph.ts";
import { claimRunner } from "./claim-source.ts";
import { standardRunner } from "./standard-source.ts";
import type { JudgeSubject } from "./subject.ts";
import type { Tiering } from "../tier-facts.ts";
import { clientFor } from "./client.ts";
import type { JevClient } from "./client.ts";
import type { JudgedRun, JudgedSource, JudgingEvents } from "./store.ts";

/** What a gate's runner is given for one comparison. */
export interface GateContext {
  readonly client: JevClient;
  readonly cacheDir: string;
  /** Tree digests of the base and the head, for the judged store's key. */
  readonly base: string;
  readonly head: string;
  readonly baseTree: FileTree;
  readonly headTree: FileTree;
  /** The comparison, its derived facts and the claims with their links. */
  readonly subject: JudgeSubject;
  /** Told what is pending and what has been answered, as the run goes. */
  readonly events?: JudgingEvents;
}

/**
 * A gate's runner turns a comparison into the items its gate judges and runs `judgeItems` over
 * them. Each gate adds its runner here; the claim gate is first, then the standard gate.
 */
export type GateRunner = (context: GateContext) => Promise<JudgedRun>;
export const GATE_RUNNERS: readonly GateRunner[] = [claimRunner, standardRunner];

export interface SourceRequest {
  readonly judge: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly baseTree: FileTree;
  readonly headTree: FileTree;
  readonly cacheDir: string;
  /** Tests inject a fake; the command line leaves it out and gets the real client. */
  readonly client?: JevClient;
  readonly runners?: readonly GateRunner[];
  /** The reviewer's tier table and the stored vocabulary the tiers are picked from (see tieringOf). */
  readonly tiering?: Tiering;
}

/**
 * The server's judged source. Off (no --judge, or no key) it sends nothing and says why; on, it
 * runs each gate once, in the background after the server listens, and the store answers every later load.
 */
export function judgedSource(request: SourceRequest): JudgedSource {
  const { judge, env, baseTree, headTree, cacheDir, runners = GATE_RUNNERS, tiering } = request;
  if (!judge) return { status: "off", reason: "judging is off: pass --judge to send source text to TypeSafe", load: () => Promise.resolve([]) };
  const key = env.TYPESAFE_API_KEY;
  if (request.client === undefined && (key === undefined || key === "")) {
    return { status: "off", reason: "no TYPESAFE_API_KEY in the environment: nothing sent, every judged check reads not judged", load: () => Promise.resolve([]) };
  }
  const client = request.client ?? clientFor(true, env);
  const digests = { base: treeDigest(baseTree), head: treeDigest(headTree) };
  return { status: "on", gates: runners.length, ...(tiering === undefined ? {} : { tiering }), load: (subject, events) => Promise.all(runners.map((runner) => runner({ client, cacheDir, ...digests, baseTree, headTree, subject, ...(events === undefined ? {} : { events }) }))) };
}
