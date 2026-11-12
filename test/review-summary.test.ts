import { expect, test } from "vitest";
import { noNewCallsText, claimGroups, claimsSummary, contractsSummary, foldersOf, resourceSummaries, signatureChange, testsSummary, unmentionedSummary } from "../src/review-summary.ts";
import type { EffectGroup } from "../src/review.ts";
import type { ContractRow } from "../src/review.ts";
import type { NodeId } from "../src/graph.ts";

test("an added destructured parameter shows by name, without its default", () => {
  const before = "({ card, steps, tlc = false, verdict })";
  const after = "({ card, steps, tlc = false, harness = false, verdict })";
  expect(signatureChange(before, after).text).toBe("+ harness");
});

test("added, removed and re-defaulted parameters of a plain list", () => {
  expect(signatureChange("(a, b = 1, c)", "(a, b = 2, d)").text).toBe("+ d  − c  ~ b");
});

test("a renamed destructured binding is a change of that parameter, not a new one", () => {
  expect(signatureChange("({ a, contracts })", "({ a, contracts: profileFile })").text).toBe("~ contracts");
});

test("commas inside nested brackets and strings do not split a parameter", () => {
  expect(signatureChange("(a, b = [1, 2], c = {x: 1, y: 2})", "(a, b = [1, 2], c = {x: 1, y: 2}, d = f(1, 2))").text).toBe("+ d");
});

test("a changed return type is named after the parameters", () => {
  expect(signatureChange("(a: number): string", "(a: number, b: string): number").text).toBe("+ b: string  returns string → number");
});

test("a signature with no parameter list falls back to the differing middle", () => {
  expect(signatureChange("class A extends B", "class A extends C").text).toBe("− B  + C");
});

test("reordering, async and name changes are never summarised as a partial list", () => {
  expect(signatureChange("function f(a, b)", "async function f(b, a, c)").text).toBe("signature changed");
  expect(signatureChange("(a, b)", "(b, a)").text).toBe("signature changed");
  expect(signatureChange("function f(a)", "function* f(a)").text).toBe("signature changed");
  expect(signatureChange("(a, b)", "(a, b = 1)").text).toBe("~ b");
  expect(signatureChange("(a, b)", "(a, b?)").text).toBe("~ b");
  expect(signatureChange("(a, b)", "(a, ...b)").text).toBe("~ b");
});

test("identical signatures give no change", () => {
  expect(signatureChange("(a)", "(a)").text).toBe("");
});

const group = (resource: EffectGroup["resource"], target: EffectGroup["target"], calls: number): EffectGroup => ({
  resource,
  target,
  rows: Array.from({ length: calls }, (_, i) => ({ id: `function:a.js#f${i}` as NodeId, label: `f${i}`, path: "a.js", operation: "op", range: { start: 1, end: 1 } })),
});

test("effect groups fold into their resource, unknown and absent targets included", () => {
  const out = resourceSummaries([
    group("process", { literal: "git" }, 3),
    group("process", "unknown", 2),
    group("process", "none", 1),
    group("file system", "unknown", 4),
  ]);
  expect(out.map((r) => [r.resource, r.calls, r.targets.length])).toEqual([
    ["process", 6, 3],
    ["file system", 4, 1],
  ]);
});

const row = (path: string, label: string): ContractRow => ({ kind: "row", move: { kind: "added", id: `function:${path}#${label}` as NodeId, before: null, after: "()" }, id: `function:${path}#${label}` as NodeId, label, path, level: "function", unmentioned: false });

test("added contracts group by folder, biggest first, root files together", () => {
  const out = foldersOf([row("src/a.js", "x"), row("src/a.js", "y"), row("lib/deep/b.js", "z"), row("src/c.js", "w"), row("top.js", "t")]);
  expect(out.map((f) => [f.folder, f.rows.length])).toEqual([
    ["src", 3],
    ["(root)", 1],
    ["lib/deep", 1],
  ]);
});

test("claims split into unlinked first and linked, only when links were made", () => {
  const claims = [{ ids: [] as string[] }, { ids: ["a"] }, { ids: [] as string[] }];
  expect(claimGroups(claims, true).map((g) => [g.name, g.items.length])).toEqual([
    ["unlinked", 2],
    ["linked", 1],
  ]);
  expect(claimGroups(claims, false).map((g) => [g.name, g.items.length])).toEqual([["all", 3]]);
});

test("each row's number comes first", () => {
  expect(claimsSummary(null, [], "off")).toBe("no description");
  expect(claimsSummary("d", [{ ids: ["a"] }, { ids: [] }, { ids: ["b", "c"] }], "ok")).toBe("2 of 3 linked");
  expect(claimsSummary("d", [{ ids: [] }], "off")).toBe("1 claim, not linked");
  expect(unmentionedSummary({ files: 103, calls: 114 })).toBe("103 files · 114 new calls out");
  expect(unmentionedSummary({ files: 1, calls: 0 })).toBe("1 file");
  expect(unmentionedSummary({ files: 26, calls: 0, moves: 1, movedFiles: 25 })).toBe("1 file · 1 move group");
  expect(unmentionedSummary({ files: 25, calls: 0, moves: 1, movedFiles: 25 })).toBe("1 move group");
  expect(unmentionedSummary({ files: null, calls: 2 })).toBe("2 new calls out");
  expect(unmentionedSummary({ files: 0, calls: 0 })).toBe("nothing");
  expect(unmentionedSummary({ files: 0, calls: 0, agent: { files: 14, calls: 0, changed: 0 } })).toBe("14 files linked by the agent only");
  expect(unmentionedSummary({ files: 2, calls: 0, agent: { files: 1, calls: 3, changed: 0 } })).toBe("2 files · 1 file linked by the agent only · 3 new calls out linked by the agent only");
  expect(unmentionedSummary({ files: 0, calls: 0, agent: { files: 0, calls: 0, changed: 0 } })).toBe("nothing");
  expect(contractsSummary({ changed: 2, effects: 0, removed: 0, unexported: 0, exposed: 0, moved: 0, added: 118 })).toBe("2 changed · 118 added");
  expect(contractsSummary({ changed: 0, effects: 0, removed: 0, unexported: 0, exposed: 0, moved: 0, added: 0 })).toBe("none");
  expect(claimsSummary("d", [], "ok", 3)).toBe("no claims · 3 context lines");
  expect(claimsSummary("d", [], "ok", 1)).toBe("no claims · 1 context line");
  expect(claimsSummary("d", [{ ids: ["a"] }], "ok", 4)).toBe("1 of 1 linked");
  expect(unmentionedSummary({ files: 2, calls: 0, changed: 3 })).toBe("2 files · 3 effects changed");
  expect(unmentionedSummary({ files: null, calls: 0, changed: 1 })).toBe("1 effect changed");
  expect(contractsSummary({ changed: 2, effects: 0, removed: 0, unexported: 0, exposed: 0, moved: 0, added: 0 }, 4)).toBe("2 changed · 4 effects changed");
  expect(contractsSummary({ changed: 0, effects: 0, removed: 0, unexported: 0, exposed: 0, moved: 0, added: 0 }, 1)).toBe("1 effects changed");
});

test("commas inside generics do not split parameters", () => {
  const change = signatureChange("f(value: Map<string, number>)", "f(value: Map<string, boolean>)");
  expect(change.modified).toEqual(["value"]);
  expect(change.text).toBe("~ value");
  expect(signatureChange("f(a: Map<string, number>)", "f(a: Map<string, number>, b: number)").text).toBe("+ b: number");
});

test("no description means unmentioned is not checked, never nothing", () => {
  expect(unmentionedSummary({ files: null, calls: 0 })).toBe("not checked, no description");
  expect(unmentionedSummary({ files: 0, calls: 0 })).toBe("nothing");
  expect(unmentionedSummary({ files: 0, calls: 0, agent: { files: 14, calls: 0, changed: 0 } })).toBe("14 files linked by the agent only");
  expect(unmentionedSummary({ files: 2, calls: 0, agent: { files: 1, calls: 3, changed: 0 } })).toBe("2 files · 1 file linked by the agent only · 3 new calls out linked by the agent only");
  expect(unmentionedSummary({ files: 0, calls: 0, agent: { files: 0, calls: 0, changed: 0 } })).toBe("nothing");
});

test("the tests row says fail of total, or why there is no run", () => {
  const noControl = { status: "failed", why: "x" } as const;
  const ran = { tier: "observed", tree: "t", status: "ran", counts: { pass: 187, fail: 23, skip: 0 }, control: noControl } as const;
  expect(testsSummary(ran as never, 0)).toBe("23 fail of 210 (no control run)");
  const counts = { regression: 2, environment: 21, fixed: 0, passes: 0, skipped: 0, "head only": 0, "base only": 0, unclear: 0 };
  const controlled = { ...ran, control: { status: "ran", seconds: 1, counts, baseOnly: [] } };
  expect(testsSummary(controlled as never, 0)).toBe("2 regressions · 21 environment of 210");
  expect(testsSummary({ ...controlled, control: { ...controlled.control, counts: { ...counts, regression: 0, environment: 23 } } } as never, 0)).toBe("no regressions · 23 environment of 210");
  // With a control run the counts are the verdicts': skipped, one-sided and ambiguous tests are not passes.
  const clean = { ...controlled, counts: { pass: 10, fail: 0, skip: 0 } };
  expect(testsSummary({ ...clean, control: { ...controlled.control, counts: { ...counts, regression: 0, environment: 0, passes: 8, skipped: 1, "head only": 1 } } } as never, 0)).toBe("no regressions · 2 not compared of 10");
  expect(testsSummary({ ...clean, control: { ...controlled.control, counts: { ...counts, regression: 0, environment: 0, passes: 10 } } } as never, 0)).toBe("10 pass");
  expect(testsSummary({ ...clean, control: { ...controlled.control, counts: { ...counts, regression: 0, environment: 0, passes: 9, "base only": 1 } } } as never, 0)).toBe("no regressions · 1 not compared of 10");
  expect(testsSummary({ tier: "observed", tree: "t", status: "running", stage: "control" }, 0)).toBe("running the control run…");
  expect(testsSummary({ tier: "observed", tree: "t", status: "running", stage: "tests" }, 0)).toBe("running tests…");
  expect(testsSummary({ tier: "observed", tree: "t", status: "stopped", why: "x" }, 0)).toBe("not run");
  expect(testsSummary({ ...ran, counts: { pass: 5, fail: 0, skip: 1 } } as never, 0)).toBe("5 pass · 1 skip");
  expect(testsSummary({ ...ran, counts: { pass: 0, fail: 0, skip: 10 } } as never, 0)).toBe("10 skip");
  expect(testsSummary({ tier: "observed", tree: "t", status: "refused", why: "x" }, 0)).toBe("not run");
  expect(testsSummary({ tier: "observed", tree: "t", status: "unreliable" } as never, 0)).toBe("results unreliable");
  expect(testsSummary({ ...ran, status: "failed" } as never, 0)).toBe("run failed");
  expect(testsSummary(null, 3)).toBe("3 weakened or removed");
  expect(testsSummary(ran as never, 3)).toBe("23 fail of 210 (no control run) · 3 weakened");
});

test("the empty state of new calls out never says none while an agent-only call is counted", () => {
  expect(noNewCallsText(0)).toMatch(/^No new call reaches/);
  expect(noNewCallsText(1)).toBe("Every other new call out is mentioned.");
  expect(unmentionedSummary({ files: 0, calls: 0, agent: { files: 0, calls: 0, changed: 1 } })).toBe("1 effect changed linked by the agent only");
});
