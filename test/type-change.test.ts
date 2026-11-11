import { expect, test } from "vitest";
import { typeChange } from "../src/type-change.ts";

test("a member added, removed and a member whose type changed, one line each", () => {
  expect(typeChange("{ a: string; b: number; c: 1 }", "{ a: string; b: number | null; d: 2 }")).toEqual(["~ b: number → number | null", "+ d: 2", "− c: 1"]);
});

test("a method's changed parameter and a removed method, as in TownView", () => {
  const before = "{ show(town: Town): void; highlight(ids: readonly NodeId[], chosen?: ResourceKind): void; flyTo(id: NodeId): void; reset(): void; cyclePixel(): 1 }";
  const after = "{ show(town: Town): void; highlight(ids: readonly NodeId[], chosen?: ResourceKind | readonly ResourceKind[]): void; flyTo(id: NodeId): void; reset(): void }";
  expect(typeChange(before, after)).toEqual(["~ highlight(chosen?): ResourceKind → ResourceKind | readonly ResourceKind[]", "− cyclePixel(): 1"]);
});

test("a method that gains a parameter or changes its return type", () => {
  expect(typeChange("{ f(a: 1): void }", "{ f(a: 1, b: 2): string }")).toEqual(["+ f(b: 2)", "~ f returns: void → string"]);
  expect(typeChange("{ f(a: 1, b: 2): void }", "{ f(a: 1): void }")).toEqual(["− f(b: 2)"]);
});

test("nested object literals read as a path", () => {
  expect(typeChange("{ opts: { a: 1; deep: { x: 1 } }; id: 1 }", "{ opts: { a: 2; deep: { x: 1; y: 2 }; z: 3 }; id: 1 }")).toEqual([
    "~ opts.a: 1 → 2",
    "+ opts.deep.y: 2",
    "+ opts.z: 3",
  ]);
});

test("a modifier or optionality change names the whole member", () => {
  expect(typeChange("{ readonly a: string }", "{ a?: string }")).toEqual(["~ readonly a: string → a?: string"]);
});

test("union members of a type alias: added and removed", () => {
  expect(typeChange('= "a" | "b"', '= "a" | "c" | "d"')).toEqual(['+ "c"', '+ "d"', '− "b"']);
  expect(typeChange("= | { k: 1 } | { k: 2 }", "= | { k: 1 }")).toEqual(["− { k: 2 }"]);
});

test("an object type alias reads as members", () => {
  expect(typeChange("= { a: 1 }", "= { a: 1; b: 2 }")).toEqual(["+ b: 2"]);
});

test("extends and generics: what was added, removed or changed", () => {
  expect(typeChange("extends A { x: 1 }", "extends A, B { x: 1 }")).toEqual(["+ extends B"]);
  expect(typeChange("extends A, B { x: 1 }", "extends A { x: 1 }")).toEqual(["− extends B"]);
  expect(typeChange("<T> { x: T }", "<T, U = 1> { x: T }")).toEqual(["~ generics: <T> → <T, U = 1>"]);
  expect(typeChange("{ x: 1 }", "extends A { x: 1 }")).toEqual(["+ extends A"]);
});

test("a member's order alone is no change", () => {
  expect(typeChange("{ a: 1; b: 2 }", "{ b: 2; a: 1 }")).toEqual([]);
});

test("text that cannot be read apart falls back to null; arms that differ are listed as they are", () => {
  expect(typeChange("{ a: 1; a: 2 }", "{ a: 1 }")).toBeNull();
  expect(typeChange("= string", "= number")).toBeNull();
  expect(typeChange("= { a: 1 }", '= "x" | "y"')).toBeNull();
  expect(typeChange("{ a: 1", "{ a: 1; b: 2 }")).toBeNull();
  expect(typeChange("{ a: 1 }", "= { a: 1; b: 2 }")).toBeNull();
  expect(typeChange("= A & { a: 1 } | B", "= A & { a: 2 } | B")).toEqual(["+ A & { a: 2 }", "− A & { a: 1 }"]);
});

test("an intersection's parts are added or removed like union members", () => {
  expect(typeChange("= A & B", "= A & B & C")).toEqual(["+ & C"]);
});

test("a conditional type is never split into false union arms", () => {
  const a = '= T extends string ? "a" | "b" : "c"';
  const b = '= T extends string ? "a" | "d" : "c"';
  expect(typeChange(a, b)).toBeNull();
  expect(typeChange("= () => 1 | 2", "= () => 1 | 3")).toBeNull();
});

test("reordered call signatures are never listed as nothing", () => {
  const before = '{ (x: string): "str"; (x: unknown): "any"; version: 1 }';
  const after = '{ (x: unknown): "any"; (x: string): "str"; version: 2 }';
  expect(typeChange(before, after)).toBeNull();
  expect(typeChange("{ new (a: 1): A; new (a: 2): B }", "{ new (a: 2): B; new (a: 1): A }")).toBeNull();
  expect(typeChange('{ (x: string): "str"; v: 1 }', '{ (x: string): "str"; (x: number): "n"; v: 1 }')).toEqual(['+ (x: number): "n"']);
});

test("a reordered intersection is never listed as only its other changes", () => {
  const before = "= { (x: string): 1 } & { (x: unknown): 2 } & { v: 1 }";
  const after = "= { (x: unknown): 2 } & { (x: string): 1 } & { v: 2 }";
  expect(typeChange(before, after)).toBeNull();
  expect(typeChange("= A & B", "= B & A")).toBeNull();
});

test("template literal types are never split into false arms", () => {
  expect(typeChange("= `a${`x|y`}` | \"b\"", "= `a${`x|z`}` | \"b\"")).toBeNull();
  expect(typeChange("{ a: `x${string}` }", "{ a: `y${string}` }")).toBeNull();
});
