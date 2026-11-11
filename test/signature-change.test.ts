import { expect, test } from "vitest";
import { signatureSummary } from "../src/signature-change.ts";

test("the PR 14 prComment case: two optional parameters added to a destructured parameter", () => {
  const before = "({ card, steps, sha, repoUrl, usage, checked, version, checks, costs, drawnBy })";
  const after = "({ card, steps, sha, repoUrl, usage, checked, version, checks, costs, drawnBy, sections = [], tlc = false })";
  expect(signatureSummary(before, after)).toEqual(["Added optional parameters: sections = [], tlc = false"]);
});

test("a destructured member gained: one optional", () => {
  expect(signatureSummary("({ a, b })", "({ a, b, c = [] })")).toEqual(["Added optional parameter: c = []"]);
});

test("parameters added (required and optional) and removed", () => {
  expect(signatureSummary("f(a)", "f(a, b: number, c?: string, d = 1)")).toEqual(["Added optional parameters: c?: string, d = 1", "Added required parameter: b: number"]);
  expect(signatureSummary("f(a, b = 2)", "f(a)")).toEqual(["Removed parameter: b = 2"]);
});

test("a default changed, added or removed", () => {
  expect(signatureSummary("f(a = 1)", "f(a = 2)")).toEqual(["Default changed: a = 1 → 2"]);
  expect(signatureSummary("f(a)", "f(a = 2)")).toEqual(["Default added: a = 2"]);
  expect(signatureSummary("f(a = 1)", "f(a)")).toEqual(["Default removed: a (was 1), now required"]);
});

test("optional and required flipped", () => {
  expect(signatureSummary("f(a?: string)", "f(a: string)")).toEqual(["a is now required"]);
  expect(signatureSummary("f(a: string)", "f(a?: string)")).toEqual(["a is now optional"]);
});

test("a parameter renamed at the same position with the same type and default", () => {
  expect(signatureSummary("f(a: string, b = 1)", "f(a: string, c = 1)")).toEqual(["Renamed parameter: b → c"]);
  expect(signatureSummary("f(a: string)", "f(c: number)")).toEqual(["Added required parameter: c: number", "Removed parameter: a: string"]);
});

test("a parameter type and the return type changed", () => {
  expect(signatureSummary("f(a: string): void", "f(a: number): string")).toEqual(["Type of a: string → number", "Return type changed: void → string"]);
  expect(signatureSummary("async f(a)", "async f(a): Promise<void>")).toEqual(["Return type changed: (inferred) → Promise<void>"]);
});

test("a destructured member removed", () => {
  expect(signatureSummary("({ a, b = 1 })", "({ a })")).toEqual(["Removed parameter: b = 1"]);
});

test("types with arrows, generics and nested brackets are read whole", () => {
  expect(signatureSummary("f(cb: (x: number) => void, m: Map<string, number>)", "f(cb: (x: number) => void, m: Map<string, number>, z = [1, 2])")).toEqual(["Added optional parameter: z = [1, 2]"]);
});

test("anything not read exactly gives null", () => {
  expect(signatureSummary("f(a): 1; f(a, b): 2", "f(a): 1; f(a, b, c): 2")).toBeNull();
  expect(signatureSummary("f(...args, a)", "f(...args)")).toBeNull();
  expect(signatureSummary("f(a, ...rest)", "f(...rest, a)")).toBeNull();
  expect(signatureSummary("f(a = `x`)", "f(a = `y`)")).toBeNull();
  expect(signatureSummary("f(a, (b)", "f(a, b)")).toBeNull();
  expect(signatureSummary("f(a, b)", "f(b, a)")).toBeNull();
  expect(signatureSummary("({ a })", "(a)")).toBeNull();
  expect(signatureSummary("({ a }: A)", "({ a, b }: B)")).toBeNull();
  expect(signatureSummary("f(a)", "g(a, b)")).toBeNull();
  expect(signatureSummary("f(a)", "f(a)")).toBeNull();
});
