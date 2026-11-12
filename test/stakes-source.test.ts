import { expect, test } from "vitest";
import { extract } from "../src/extract/extract.ts";
import type { FileTree } from "../src/graph.ts";
import { effectSets } from "../src/effects.ts";
import { HARM_CATALOGUE, HARM_CATALOGUE_VERSION, harmKind } from "../src/harm-catalogue.ts";
import type { HarmKind } from "../src/harm-catalogue.ts";
import { collectVocabulary } from "../src/vocabulary.ts";
import { jevCost } from "../src/jev/client.ts";
import type { JevClient, JevRequest, JevResponse } from "../src/jev/client.ts";
import { judgeMemberships, narrow, unitsOf } from "../src/jev/membership-source.ts";
import { memberships as buildMemberships } from "../src/memberships.ts";
import type { StoredMemberships } from "../src/memberships.ts";
import { MAX_MEMBERS_SHOWN, MAX_MEMBER_LINES, STAKES_THRESHOLDS, stakesGate } from "../src/jev/stakes-gate.ts";
import { MAX_STAKES_PAIRS, answerByCode, effectReader, judgeStakes, membersDigest, stakePairKey, stakesInputOf, termMembers } from "../src/jev/stakes-source.ts";
import type { FactReader, TermMembers } from "../src/jev/stakes-source.ts";
import type { StakeRecord } from "../src/stakes.ts";

const secret = "ghp_1234567890abcdefABCDEF1234567890abcd";
const shop: Record<string, string> = {
  "docs/guide.md": "# Order flow\n\nHow an order moves from cart to shipment.\n\n## Payment providers\n\nWe charge cards through one provider.\n\n## Zebra crossing\n\nA word nothing in the code shares.\n",
  "src/payments/stripe.ts": `// Charges a card through the payment provider.\nexport async function chargeCard(amount: number): Promise<void> {\n  await fetch("https://api.pay.example/v1/charge", { method: "POST", body: String(amount) });\n  const key = "${secret}";\n  void key;\n}\n`,
  "src/orders/place.ts": "export function placeOrder(): void {}\nexport function cancelOrder(): void {}\n",
};

const read = (files: Record<string, string>) => {
  const tree: FileTree = new Map(Object.entries(files));
  const graph = extract(tree);
  const vocabulary = collectVocabulary({ graph, tree });
  return { tree, graph, terms: vocabulary.terms, units: unitsOf(graph, tree) };
};

const membershipClient = (rows: (term: string, unit: string) => number): JevClient => ({
  model: "fake-1",
  async ask(request): Promise<JevResponse> {
    const term = /^Term: (.*)$/m.exec(request.state.term ?? "")?.[1] ?? "?";
    const unit = /^(?:function|class|constant) (\S+) in /m.exec(request.state.code ?? "")?.[1] ?? "?";
    return { answers: { belongs: { type: "yes-no", yes: rows(term, unit) }, incidental: { type: "yes-no", yes: 0.02 } }, usage: { inputTokens: 100, outputTokens: 3, usd: jevCost(100) }, model: "fake-1" };
  },
});

/** Memberships judged with a fake classifier: "Order flow" gets both order functions, "payments" gets chargeCard. */
async function judged(files: Record<string, string> = shop, rows: (term: string, unit: string) => number = (term, unit) => ((term === "Order flow" && /Order$/.test(unit)) || (term === "payments" && unit === "chargeCard") ? 0.97 : 0.03)) {
  const world = read(files);
  const narrowed = narrow(world.units, world.terms, world.tree);
  const outcome = await judgeMemberships({ pairs: narrowed.pairs, tree: world.tree, previous: new Map(), client: membershipClient(rows) });
  const stored: StoredMemberships = buildMemberships(world.units, narrowed, outcome, "fake-1");
  return { ...world, stored, members: termMembers(stored, world.units, world.terms) };
}

const answer = (yes: number): JevResponse => ({ answers: { harm: { type: "yes-no", yes } }, usage: { inputTokens: 100, outputTokens: 3, usd: jevCost(100) }, model: "fake-1" });
const clientOf = (reply: (request: JevRequest, call: number) => JevResponse | Promise<JevResponse>): JevClient & { requests: JevRequest[] } => {
  const requests: JevRequest[] = [];
  return {
    model: "fake-1",
    requests,
    async ask(request) {
      requests.push(request);
      return reply(request, requests.length);
    },
  };
};
const judgeKinds = HARM_CATALOGUE.filter((kind) => kind.answer === "judgement");
const withMembers = (members: ReadonlyMap<string, TermMembers>): TermMembers[] => [...members.values()].filter((one) => one.members.length > 0);

test("a term's members are the functions mapped to it that are current: a confident no, the middle band and a stale mapping are not members", async () => {
  const { members, terms, units } = await judged();
  const orderFlow = members.get(terms.find((term) => term.name === "Order flow")!.key)!;
  expect(orderFlow.members.map((member) => member.unit.name).sort()).toEqual(["cancelOrder", "placeOrder"]);
  const payments = [...members.values()].find((one) => one.term.name === "payments")!;
  expect(payments.members.map((member) => member.unit.name)).toEqual(["chargeCard"]);
  // Every term is in the map, with no members when none is mapped to it: its stakes are unknown, never none.
  expect(members.size).toBe(terms.length);
  expect([...members.values()].filter((one) => one.members.length === 0).length).toBeGreaterThan(0);
  expect(units.length).toBeGreaterThan(0);
});

test("members are ranked by how sure the mapping was, then by key; a term's unknown pairs are counted", async () => {
  const { members } = await judged(shop, (term, unit) => (term === "Order flow" && unit === "cancelOrder" ? 0.99 : term === "Order flow" && unit === "placeOrder" ? 0.93 : 0.03));
  const orderFlow = [...members.values()].find((one) => one.term.name === "Order flow")!;
  expect(orderFlow.members.map((member) => member.unit.name)).toEqual(["cancelOrder", "placeOrder"]);
  expect(orderFlow.unknown).toBe(0);
});

test("a pair that was not judged or is stale makes the term's members incomplete: counted as unknown pairs", async () => {
  const world = read(shop);
  const narrowed = narrow(world.units, world.terms, world.tree);
  const failing = { model: "fake-1", ask: () => Promise.reject(new Error("down")) } satisfies JevClient;
  const outcome = await judgeMemberships({ pairs: narrowed.pairs, tree: world.tree, previous: new Map(), client: failing });
  const stored = buildMemberships(world.units, narrowed, outcome, "fake-1");
  const members = termMembers(stored, world.units, world.terms);
  expect(withMembers(members)).toEqual([]);
  expect([...members.values()].some((one) => one.unknown > 0)).toBe(true);
});

test("the digest covers every mapped member's key and digest: a changed member or a changed membership changes it, a function outside the term does not", async () => {
  const base = await judged();
  const orderOf = (world: Awaited<ReturnType<typeof judged>>) => [...world.members.values()].find((one) => one.term.name === "Order flow")!;
  const changed = await judged({ ...shop, "src/orders/place.ts": "export function placeOrder(): void { return; }\nexport function cancelOrder(): void {}\n" });
  expect(membersDigest(orderOf(changed).members)).not.toBe(membersDigest(orderOf(base).members));
  const outside = await judged({ ...shop, "src/payments/stripe.ts": `${shop["src/payments/stripe.ts"]}\nexport function other(): void {}\n` });
  expect(membersDigest(orderOf(outside).members)).toBe(membersDigest(orderOf(base).members));
  const fewer = await judged(shop, (term, unit) => (term === "Order flow" && unit === "placeOrder" ? 0.97 : 0.03));
  expect(membersDigest(orderOf(fewer).members)).not.toBe(membersDigest(orderOf(base).members));
  expect(membersDigest(orderOf(base).members)).toMatch(/^[0-9a-f]{32}$/);
});

test("the input shows the term and its members, strongest first, capped and counted, with secrets withheld and long bodies cut", async () => {
  const many: Record<string, string> = { "docs/guide.md": "# Order flow\n\nHow an order moves.\n" };
  for (let n = 0; n < MAX_MEMBERS_SHOWN + 3; n++) many[`src/orders/o${n}.ts`] = `function placeOrder${n}(): void {\n${Array.from({ length: MAX_MEMBER_LINES + 10 }, (_, line) => `  const l${line} = "${secret}";`).join("\n")}\n}\n`;
  const world = await judged(many, () => 0.97);
  const term = [...world.members.values()].find((one) => one.term.name === "Order flow")!;
  const input = stakesInputOf({ kind: harmKind("privacy")!, entry: term, tree: world.tree });
  expect(input.kind).toBe("privacy");
  expect(input.members).toHaveLength(MAX_MEMBERS_SHOWN);
  expect(input.omittedMembers).toBe(term.members.length - MAX_MEMBERS_SHOWN);
  expect(input.members[0]!.code).toHaveLength(MAX_MEMBER_LINES);
  expect(input.members[0]!.cutLines).toBeGreaterThan(0);
  expect(JSON.stringify(stakesGate.state(input))).not.toContain("1234567890abcdef");
  expect(input.term.name).toBe("Order flow");
});

test("a kind with an effect fact shows the member's derived effects of that resource, and a kind without one shows none", async () => {
  const world = await judged();
  const payments = [...world.members.values()].find((one) => one.term.name === "payments")!;
  const effects = effectSets(world.graph);
  const network = stakesInputOf({ kind: harmKind("server-side-request-forgery")!, entry: payments, tree: world.tree, effects });
  expect(network.members[0]!.effects.join("\n")).toMatch(/network fetch/);
  expect(network.members[0]!.effects.join("\n")).not.toContain("/v1/charge");
  expect(stakesInputOf({ kind: harmKind("money")!, entry: payments, tree: world.tree, effects }).members[0]!.effects).toEqual([]);
  expect(stakesInputOf({ kind: harmKind("server-side-request-forgery")!, entry: payments, tree: world.tree }).members[0]!.effects).toEqual([]);
});

test("each term with members is asked once per kind that needs judgement, a record keeps the exact request, the answers, the thresholds, the digest and the catalogue version", async () => {
  const world = await judged();
  const client = clientOf(() => answer(0.97));
  const asked = withMembers(world.members);
  const out = await judgeStakes({ terms: world.members, tree: world.tree, previous: new Map(), client });
  expect(client.requests).toHaveLength(asked.length * judgeKinds.length);
  expect(out.asked).toBe(asked.length * judgeKinds.length);
  expect(out.reused).toBe(0);
  expect(out.records).toHaveLength(asked.length * judgeKinds.length);
  const record = out.records[0]!;
  expect(record).toMatchObject({ tier: "judged", question: { id: "stakes", version: "stakes-v1" }, thresholds: STAKES_THRESHOLDS, verdict: "flagged", model: "fake-1", catalogueVersion: HARM_CATALOGUE_VERSION });
  const entry = world.members.get(record.term)!;
  expect(record.membersDigest).toBe(membersDigest(entry.members));
  expect(record.members).toBe(entry.members.length);
  expect(record.shown.questions.harm!.criteria).toEqual({ true: harmKind(record.kind)!.yes, false: harmKind(record.kind)!.no });
  expect(out.usd).toBeCloseTo(jevCost(100) * client.requests.length);
});

test("a term with no mapped member is never asked and has no record: its stakes are unknown, not none", async () => {
  const world = await judged(shop, () => 0.03);
  expect(withMembers(world.members)).toEqual([]);
  const client = clientOf(() => answer(0.03));
  const out = await judgeStakes({ terms: world.members, tree: world.tree, previous: new Map(), client });
  expect(client.requests).toHaveLength(0);
  expect(out.records).toEqual([]);
  expect(out.asked).toBe(0);
});

test("an answer already stored is reused when the members, the term, the request, the thresholds, the model and the catalogue are all the same; otherwise it is asked again", async () => {
  const world = await judged();
  const first = await judgeStakes({ terms: world.members, tree: world.tree, previous: new Map(), client: clientOf(() => answer(0.03)) });
  const previous = new Map<string, StakeRecord>(first.records.map((record) => [stakePairKey(record.term, record.kind), record]));
  const again = clientOf(() => answer(0.03));
  const second = await judgeStakes({ terms: world.members, tree: world.tree, previous, client: again });
  expect(again.requests).toHaveLength(0);
  expect(second.reused).toBe(first.records.length);
  expect(second.usd).toBe(0);
  const other = { ...clientOf(() => answer(0.03)), model: "fake-2" };
  expect((await judgeStakes({ terms: world.members, tree: world.tree, previous, client: other })).asked).toBe(first.records.length);
  const newer = clientOf(() => answer(0.03));
  expect((await judgeStakes({ terms: world.members, tree: world.tree, previous, client: newer, catalogueVersion: HARM_CATALOGUE_VERSION + 1 })).asked).toBe(first.records.length);
});

test("a member that changed is asked again, and the old record, if the call fails, is kept and marked stale: a changed member is never trusted by its old answer", async () => {
  const world = await judged();
  const first = await judgeStakes({ terms: world.members, tree: world.tree, previous: new Map(), client: clientOf(() => answer(0.03)) });
  const previous = new Map<string, StakeRecord>(first.records.map((record) => [stakePairKey(record.term, record.kind), record]));
  const edited = await judged({ ...shop, "src/orders/place.ts": "export function placeOrder(): void { return; }\nexport function cancelOrder(): void {}\n" });
  const down = { model: "fake-1", ask: () => Promise.reject(new Error("down")) } satisfies JevClient;
  const out = await judgeStakes({ terms: edited.members, tree: edited.tree, previous, client: down });
  const orderKey = [...edited.members.values()].find((one) => one.term.name === "Order flow")!.term.key;
  const old = out.records.filter((record) => record.term === orderKey);
  expect(old.length).toBe(judgeKinds.length);
  expect(old.every((record) => record.stale === "the term's members changed")).toBe(true);
  expect(out.notJudged.length).toBeGreaterThan(0);
  // The payments term did not change: its answers were reused, not marked.
  expect(out.records.filter((record) => record.term !== orderKey).every((record) => record.stale === undefined)).toBe(true);
});

test("a call that fails or answers unreadably has no record and is listed with why: no answer is never a no", async () => {
  const world = await judged();
  const client = clientOf((_request, call) => {
    if (call === 1) throw new Error("boom");
    if (call === 2) return { ...answer(0.5), answers: { harm: { type: "unreadable", why: "bad", raw: "?" } } };
    return answer(0.5);
  });
  const total = withMembers(world.members).length * judgeKinds.length;
  const out = await judgeStakes({ terms: world.members, tree: world.tree, previous: new Map(), client });
  expect(out.notJudged).toHaveLength(2);
  expect(out.records).toHaveLength(total - 2);
});

test("pairs over the limit are not asked, are counted and are listed by term and kind, the terms with the most members first", async () => {
  const world = await judged();
  const client = clientOf(() => answer(0.5));
  const out = await judgeStakes({ terms: world.members, tree: world.tree, previous: new Map(), client, maxPairs: 3 });
  const asked = withMembers(world.members);
  expect(client.requests).toHaveLength(3);
  expect(out.overLimit).toBe(asked.length * judgeKinds.length - 3);
  expect(out.cut).toHaveLength(out.overLimit);
  const biggest = [...asked].sort((a, b) => b.members.length - a.members.length || (a.term.key < b.term.key ? -1 : 1))[0]!;
  expect(out.records.every((record) => record.term === biggest.term.key)).toBe(true);
  expect(out.records.map((record) => record.kind)).toEqual(judgeKinds.slice(0, 3).map((kind) => kind.id));
  expect(MAX_STAKES_PAIRS).toBeGreaterThan(1000);
});

test("only the kinds given are asked: a kind that missed the bench bar is not asked", async () => {
  const world = await judged();
  const client = clientOf(() => answer(0.5));
  const some = [harmKind("money")!, harmKind("privacy")!];
  const out = await judgeStakes({ terms: world.members, tree: world.tree, previous: new Map(), client, kinds: some });
  expect(client.requests).toHaveLength(withMembers(world.members).length * 2);
  expect(new Set(out.records.map((record) => record.kind))).toEqual(new Set(["money", "privacy"]));
});

const fakeKind: HarmKind = { id: "fake-network", name: "a fake network kind", group: "other", yes: "A mistake here could reach the network.", no: "Nothing here reaches the network.", answer: "code", facts: ["effects on the network"] };

test("a kind that code answers exactly is filled by code and Jev is never asked (the catalogue has none yet, so this is a fake kind)", async () => {
  expect(HARM_CATALOGUE.some((kind) => kind.answer === "code")).toBe(false);
  const world = await judged();
  const client = clientOf(() => answer(0.5));
  const reader: FactReader = (_fact, unit) => (unit.name === "chargeCard" ? true : false);
  const out = await judgeStakes({ terms: world.members, tree: world.tree, previous: new Map(), client, kinds: [fakeKind], reader });
  expect(client.requests).toHaveLength(0);
  expect(out.records).toEqual([]);
  const byTerm = new Map(out.derived.map((one) => [world.members.get(one.term)!.term.name, one]));
  expect(byTerm.get("payments")).toMatchObject({ tier: "derived", kind: "fake-network", answer: "yes", facts: ["effects on the network"], catalogueVersion: HARM_CATALOGUE_VERSION });
  expect(byTerm.get("Order flow")).toMatchObject({ answer: "no" });
  expect(out.asked).toBe(0);
});

test("code answers yes when a member has the fact, no only when every member is known not to, and otherwise unknown: unknown is never no", () => {
  const unit = (name: string) => ({ unit: { name } as never, belongs: 1 });
  const members = [unit("a"), unit("b")];
  expect(answerByCode(fakeKind, members, (_fact, one) => one.name === "a")).toBe("yes");
  expect(answerByCode(fakeKind, members, () => false)).toBe("no");
  expect(answerByCode(fakeKind, members, (_fact, one) => (one.name === "a" ? false : undefined))).toBe("unknown");
  expect(answerByCode(fakeKind, [], () => false)).toBe("unknown");
  expect(() => answerByCode({ ...fakeKind, facts: [] }, members, () => false)).toThrow(/derived fact/);
});

test("the default reader says yes for an effect a member's own calls make and never says no, since only direct calls are seen", async () => {
  const world = await judged();
  const read = effectReader(effectSets(world.graph));
  const charge = world.units.find((unit) => unit.name === "chargeCard")!;
  const place = world.units.find((unit) => unit.name === "placeOrder")!;
  expect(read("effects on the network", charge)).toBe(true);
  expect(read("effects on the network", place)).toBeUndefined();
  expect(read("dependency changes", charge)).toBeUndefined();
});
