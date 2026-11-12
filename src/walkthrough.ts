import type { Claim } from "./claims.ts";
import { askCached } from "./link.ts";
import type { AgentRunner, Asked } from "./link.ts";
import { TOUR_PROMPT_VERSION, TOUR_SCHEMA, resolveTour, tourPrompt, validateTour } from "./tour.ts";
import type { Place, Tour } from "./tour.ts";
import type { NodeId } from "./graph.ts";

export type TourOutcome =
  /** `--walkthrough` was not given. */
  | { readonly status: "off" }
  | Asked<Tour>;

export interface TourRequest {
  readonly claims: readonly Claim[];
  readonly places: readonly Place[];
  readonly runner: AgentRunner;
  readonly cacheDir: string;
  /** Ask the agent again even when the cache holds a tour. */
  readonly rewalk: boolean;
  readonly timeoutMs: number;
}

/** Asks an agent for a tour of the change, cached by the prompt: its version, the claims and the place lines. */
export function walkthrough(request: TourRequest): Promise<TourOutcome> {
  const { claims, places, runner, cacheDir, rewalk, timeoutMs } = request;
  return askCached<Tour>({
    prompt: tourPrompt(claims, places),
    schema: TOUR_SCHEMA,
    promptVersion: TOUR_PROMPT_VERSION,
    // Kept and cached in the ids the prompt showed; resolveTour maps them to this graph's ids on every load.
    check: (output) => validateTour(output, claims.length, places.map((place) => ({ ...place, id: place.promptId as NodeId }))),
    resolve: (tour) => resolveTour(tour, places),
    usable: (saved) => Array.isArray(saved.stops),
    runner,
    cacheDir,
    fresh: rewalk,
    timeoutMs,
  });
}
