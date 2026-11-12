import { setUp as realSetUp } from "../src/setup.ts";
import type { SetupRequest, SetupResult } from "../src/setup.ts";

/**
 * `setUp` with the stakes step off: no kind of harm is asked about. For the tests of the vocabulary and
 * the memberships, which count the requests their fake classifier gets and must not depend on which
 * kinds the committed bench result (gates/stakes/kinds.json) lets a real run ask about.
 */
export const setUp = (request: SetupRequest): Promise<SetupResult> => realSetUp({ ...request, deps: { kindChoice: { asked: [], notJudged: [] }, ...request.deps } });
