import { expect, test } from "vitest";
import { extract } from "../src/extract/extract.ts";
import { isCodeNode } from "../src/graph.ts";
import type { FileTree } from "../src/graph.ts";
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
    "({ a = …, b }: { a?: string; b: number } = …, [c = …] = …)",
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
