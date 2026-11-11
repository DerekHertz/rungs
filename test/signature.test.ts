import { expect, test } from "vitest";
import { extract } from "../src/extract/extract.ts";
import { isCodeNode } from "../src/graph.ts";
import type { FileTree } from "../src/graph.ts";
import { compare } from "../src/compare.ts";
import { narrationPrompt } from "../src/narration.ts";
import { pseudocode } from "../src/pseudocode.ts";
import { placesOf } from "../src/tour.ts";
import { promptSignature } from "../src/signature.ts";

const signatureOf = (code: string, name: string): string => {
  const tree: FileTree = new Map([["package.json", "{}\n"], ["a.ts", code]]);
  const node = extract(tree).nodes.find((candidate) => isCodeNode(candidate) && candidate.qualifiedName === name);
  if (node === undefined || !isCodeNode(node)) throw new Error(`no ${name}`);
  return node.signature;
};

test("a default is shown as an ellipsis, names and annotations stay", () => {
  const signature = signatureOf('export function f(token = "SECRET_LITERAL", allowed = user.isAdmin ? allow() : deny(), n: number = 3): string { return token; }', "f");
  expect(signature).toContain("SECRET_LITERAL");
  expect(promptSignature(signature)).toBe("(token = …, allowed = …, n: number = …): string");
});

test("defaults inside destructuring, type parameters and class methods are hidden too", () => {
  expect(promptSignature(signatureOf('export function g({ a = "SECRET_A", b }: { a?: string; b: number } = { b: 1 }, [c = new Map<string, "SECRET_C">()] = []) {}', "g"))).toBe(
    "(…: { a?: string; b: number } = …, … = …)",
  );
  expect(promptSignature(signatureOf('export function h<T = "SECRET_T">(x: T) {}', "h"))).toBe("<T = …>(x: T)");
  expect(promptSignature(signatureOf('export class K { open(path = "SECRET_P", flag: boolean = f(1, 2)): void {} }', "K"))).toBe("{ open(path = …, flag: boolean = …): void }");
});

test("flavour and overloads survive", () => {
  expect(promptSignature(signatureOf("export async function* s(a = 1) {}", "s"))).toBe("async * (a = …)");
  expect(promptSignature("(a: number): void; (a: string, b = SECRET): void")).toBe("(a: number): void; (a: string, b = …): void");
});

test("a signature that does not parse is withheld, never passed on", () => {
  expect(promptSignature('(a = "SECRET" +')).toBe("(signature withheld)");
});

const SECRETS: string[] = [
  'export function f({ [lookup("SECRET")]: value }) { return value; }',
  'export class C { f = (x = "SECRET") => x; }',
  'export function f(token = "SECRET") {}',
  'export function f(a: typeof import("SECRET")) {}',
  "export function f(a: `pre-SECRET-${string}`) {}",
  'export function f(a: "SECRET" | 1) {}',
  'export function f<T extends "SECRET" = "SECRET">(x: T) {}',
  'export function f({ a = "SECRET" }: { a?: string } = { a: "SECRET" }) {}',
  'export class C extends mixin("SECRET") { m(a = "SECRET") {} }',
  'export class C { static x: "SECRET" = "SECRET"; y = "SECRET"; get z(): string { return "SECRET"; } }',
  'export function f(a: { "SECRET": number; [k: string]: "SECRET" }) {}',
  'export function f(cb: (x: "SECRET") => void = () => "SECRET") {}',
  'export function f(a: import("SECRET").T) {}',
  'export function f(a = (() => "SECRET")()): asserts a is "SECRET" {}',
  'export function f(...[x = "SECRET"]: any[]) {}',
  'export function f(a: [x: "SECRET", ...rest: string[]]) {}',
  "export async function* f(a = `SECRET${1}`) {}",
  'export const f = (x = "SECRET") => x;',
  'export class C { constructor(private p = "SECRET") {} }',
  'export function f(a: "SECRET"): void;\nexport function f(a: string) {}',
  'export class C { static { init("SECRET"); } m<T = "SECRET">(a?: T): typeof SECRET {} }',
  'export function f(a: { [K in "SECRET"]: 1 }) {}',
];

test.each(SECRETS)("no source text reaches the narration or tour prompt from %s", (code) => {
  const before: FileTree = new Map([["package.json", "{}\n"]]);
  const after: FileTree = new Map([["package.json", "{}\n"], ["a.ts", `${code}\n`]]);
  const graph = extract(after);
  const nodes = graph.nodes.filter(isCodeNode);
  expect(nodes.length).toBeGreaterThan(0);
  const text = [
    ...nodes.filter((node) => node.level === "function").map((node) => narrationPrompt(node, pseudocode(graph, after, node.id) ?? []).user),
    ...placesOf(compare(extract(before), graph), graph).map((place) => place.line),
    ...nodes.map((node) => promptSignature(node.signature)),
  ].join("\n");
  expect(text).not.toContain("SECRET");
});

test("what the allow-list keeps reads as the signature", () => {
  expect(promptSignature(signatureOf('export class C { f = (x = "SECRET") => x; g(a?: number, ...rest: string[]): void {} }', "C"))).toBe("{ f = …; g(a?: number, ...rest: string[]): void }");
  expect(promptSignature(signatureOf('export function f(a: "SECRET" | null, b: typeof x, c: Map<string, number[]>): Promise<void> {}', "f"))).toBe('(a: "…" | null, b: typeof …, c: Map<string, number[]>): Promise<void>');
});

// A computed member name is part of the node's id (`C."[\"SECRET\"]"`), which every prompt carries as a name; that is the graph's identity, not a signature.
test("computed member names in a class signature are placeholders", () => {
  const signature = signatureOf('export class C { ["SECRET"]() {} get [k("SECRET")](): string { return ""; } }', "C");
  expect(promptSignature(signature)).toBe("{ […](); get […](): string }");
});
