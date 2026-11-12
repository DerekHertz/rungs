import { expect, test } from "vitest";
import { extract } from "../src/extract/extract.ts";
import type { FileTree } from "../src/graph.ts";
import { collectVocabulary } from "../src/vocabulary.ts";
import { jevCost } from "../src/jev/client.ts";
import type { JevClient, JevRequest, JevResponse } from "../src/jev/client.ts";
import { judgeMemberships, narrow, pairKey, unitsOf } from "../src/jev/membership-source.ts";
import type { MembershipRecord } from "../src/memberships.ts";

const shop: Record<string, string> = {
  "package.json": '{ "description": "Checkout service for the shop" }\n',
  "docs/guide.md": "# Order flow\n\nHow an order moves from cart to shipment.\n\n## Payment providers\n\nWe charge cards through one provider.\n",
  "src/payments/stripe.ts": "// Charges a card through the payment provider.\nexport function chargeCard(amount: number): void {\n  void amount;\n}\nfunction helper(): void {}\n",
  "src/orders/place.ts": "export function placeOrder(): void {}\nexport class OrderBook {\n  add(): void {}\n}\nexport const ORDER_LIMIT = 5;\n",
};
const read = () => {
  const tree: FileTree = new Map(Object.entries(shop));
  const graph = extract(tree);
  const vocabulary = collectVocabulary({ graph, tree });
  return { tree, narrowed: narrow(unitsOf(graph, tree), vocabulary.terms, tree) };
};

const full = (belongs: number): JevResponse => ({
  answers: { belongs: { type: "yes-no", yes: belongs }, incidental: { type: "yes-no", yes: 0.02 } },
  usage: { inputTokens: 100, outputTokens: 3, usd: jevCost(100) },
  model: "fake-1",
});
const partial = (incidental?: "unreadable"): JevResponse => ({
  answers: { belongs: { type: "yes-no", yes: 0.97 }, ...(incidental === undefined ? {} : { incidental: { type: "unreadable" as const, why: "not a probability", raw: "?" } }) },
  usage: { inputTokens: 100, outputTokens: 3, usd: jevCost(100) },
  model: "fake-1",
});
const clientOf = (answer: () => JevResponse): JevClient & { requests: JevRequest[] } => {
  const requests: JevRequest[] = [];
  return {
    model: "fake-1",
    requests,
    async ask(request) {
      requests.push(request);
      return answer();
    },
  };
};
const byPair = (records: readonly MembershipRecord[]): Map<string, MembershipRecord> => new Map(records.map((record) => [pairKey(record.unit, record.term), record]));

test.each([undefined, "unreadable" as const])("a call with a missing or unreadable answer (%s) is not judged: no record, listed with why, never a middle band", async (incidental) => {
  const { tree, narrowed } = read();
  const out = await judgeMemberships({ pairs: narrowed.pairs, tree, previous: new Map(), client: clientOf(() => partial(incidental)) });
  expect(out.records).toEqual([]);
  expect(out.notJudged).toHaveLength(narrowed.pairs.length);
  expect(out.notJudged[0]!.reason).toMatch(/answer.*could not be read/);
});

test("a pair whose answer was incomplete is asked again, and a stored record that lost an answer is never reused as it is", async () => {
  const { tree, narrowed } = read();
  const first = await judgeMemberships({ pairs: narrowed.pairs, tree, previous: new Map(), client: clientOf(() => partial()) });
  const again = clientOf(() => full(0.97));
  const second = await judgeMemberships({ pairs: narrowed.pairs, tree, previous: byPair(first.records), client: again });
  expect(again.requests).toHaveLength(narrowed.pairs.length);
  expect(second.records).toHaveLength(narrowed.pairs.length);
  const damaged = byPair(second.records.map((record) => ({ ...record, answers: { belongs: record.answers.belongs! } })));
  const third = clientOf(() => full(0.97));
  await judgeMemberships({ pairs: narrowed.pairs, tree, previous: damaged, client: third });
  expect(third.requests).toHaveLength(narrowed.pairs.length);
});

test("the per-run limit counts only pairs that must be asked: reused answers do not use it, so every pair is judged in the end", async () => {
  const { tree, narrowed } = read();
  const total = narrowed.pairs.length;
  expect(total).toBeGreaterThan(3);
  let previous = new Map<string, MembershipRecord>();
  let askedInAll = 0;
  for (let run = 0; run < total && previous.size < total; run++) {
    const out = await judgeMemberships({ pairs: narrowed.pairs, tree, previous, client: clientOf(() => full(0.97)), maxPairs: 2 });
    expect(out.asked).toBeLessThanOrEqual(2);
    expect(out.reused).toBe(previous.size);
    askedInAll += out.asked;
    previous = byPair(out.records);
  }
  expect(previous.size).toBe(total);
  expect(askedInAll).toBe(total);
});
