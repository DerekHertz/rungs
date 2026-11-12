import { jevCost } from "../src/jev/client.ts";
import type { JevAnswer, JevClient, JevRequest, JevResponse } from "../src/jev/client.ts";
import { yesOf } from "../src/jev/gate.ts";
import type { Gate } from "../src/jev/gate.ts";
import type { JudgeSubject } from "../src/jev/subject.ts";

/** A toy gate: is the claim shown by the text? Yes at or above `shown`, no at or below `broken`, else undecided. */
export interface ToyInput {
  readonly claim: string;
  readonly text: string;
}

export const toyGate: Gate<ToyInput> = {
  id: "toy",
  version: "toy-v1",
  questions: {
    shown: {
      type: "yes-no",
      instructions: "Is the claim shown by the text?",
      criteria: { true: "Everything the claim says is visible in the text.", false: "Some part of the claim is not visible in the text, or the text says otherwise." },
    },
  },
  state: (input) => ({ claim: input.claim, text: input.text }),
  decide(answers, thresholds) {
    const yes = yesOf(answers, "shown");
    if (yes === undefined) return "undecided";
    if (yes >= (thresholds.shown ?? 0.9)) return "settled";
    if (yes <= (thresholds.broken ?? 0.1)) return "flagged";
    return "undecided";
  },
};

export const toyThresholds = { shown: 0.9, broken: 0.1 };

export type Ask = (request: JevRequest) => Promise<JevResponse>;

export const response = (yes: number, inputTokens = 100): JevResponse => ({
  answers: { shown: { type: "yes-no", yes } satisfies JevAnswer },
  usage: { inputTokens, outputTokens: 3, usd: jevCost(inputTokens) },
  model: "fake-1",
});

/** A fake client that reads the state the way a careful model would: the text must contain the claim. */
export function fakeClient(over?: (request: JevRequest, calls: number) => JevResponse | Promise<JevResponse>): JevClient & { requests: JevRequest[] } {
  const requests: JevRequest[] = [];
  return {
    model: "fake-1",
    requests,
    async ask(request) {
      requests.push(request);
      if (over !== undefined) return over(request, requests.length);
      const { claim = "", text = "" } = request.state;
      if (text.includes(claim)) return response(0.97);
      return response(/cannot tell/i.test(text) ? 0.5 : 0.03);
    },
  };
}

/** A fake that obeys steering text in the state: the failure the bench's steering cases exist to catch. */
export function gullibleClient(): JevClient {
  return fakeClient((request) => (/answer yes/i.test(request.state.text ?? "") ? response(0.99) : response(0.03)));
}

/** A comparison with nothing in it, for tests of the judged document that name no claim. */
export const emptySubject: JudgeSubject = {
  comparison: { extractorVersion: "", changes: [], effects: [], changedEffects: [], imports: [], sections: [], dependencies: [] },
  contracts: [],
  claims: [],
  baseTree: new Map(),
  headTree: new Map(),
  head: new Map(),
  base: new Map(),
};
