import { describe, expect, test } from "vitest";
import { extract } from "../src/extract/extract.ts";
import { isCodeNode } from "../src/graph.ts";

/** Every class and function of one file as "name: exported|private signature", in id order. */
function contractsOf(path: string, text: string): string[] {
  return extract(new Map([[path, text]])).nodes.flatMap((node) =>
    isCodeNode(node) ? [`${node.qualifiedName}: ${node.exported ? "exported" : "private"} ${node.signature}`] : [],
  );
}

const exportedNames = (path: string, text: string): string[] =>
  extract(new Map([[path, text]])).nodes.flatMap((node) => (isCodeNode(node) && node.exported ? [node.qualifiedName] : []));

describe("what a file exports, in ECMAScript modules", () => {
  test("export function, export class and export default", () => {
    expect(
      exportedNames(
        "a.js",
        "export function f() {}\nexport class C {}\nexport async function g() {}\nexport default function () {}\nfunction local() {}\n",
      ),
    ).toEqual(["C", "default", "f", "g"]);
  });

  test("export const holding a function, arrow or class expression; other bindings are left for later", () => {
    expect(
      exportedNames("a.js", "export const f = (a) => a;\nexport const g = function () {};\nexport const K = class {};\nexport const X = 3;\n"),
    ).toEqual(["K", "f", "g"]);
  });

  test("export { f } and export { f as g } name a local function; a re-export does not", () => {
    expect(
      exportedNames(
        "a.js",
        "function f() {}\nconst g = () => 1;\nfunction hidden() {}\nexport { f, g as renamed };\nexport { other } from './b.js';\n",
      ),
    ).toEqual(["f", "g"]);
  });

  test("export default of a name or an expression", () => {
    expect(exportedNames("a.js", "function f() {}\nexport default f;\n")).toEqual(["f"]);
    expect(exportedNames("b.js", "export default class {}\n")).toEqual(["default"]);
    expect(exportedNames("c.js", "export default (a) => a;\n")).toEqual(["default"]);
  });

  test("a nested function and a method are never exported", () => {
    expect(
      contractsOf("a.js", "export function outer() { function inner() {} }\nexport class C { m() {} }\n"),
    ).toEqual(["C: exported { m() }", "C.m: private ()", "outer: exported ()", "outer.inner: private ()"]);
  });

  test("a type-only export and an ambient declaration are not code", () => {
    expect(exportedNames("a.ts", "function f() {}\nexport type { f };\nexport declare function g(): void;\n")).toEqual([]);
  });
});

describe("what a file exports, in CommonJS", () => {
  test("module.exports = a function, a class or a name", () => {
    expect(exportedNames("a.js", "module.exports = function legacy() {};\n")).toEqual(["legacy"]);
    expect(exportedNames("b.js", "class C {}\nfunction f() {}\nmodule.exports = C;\n")).toEqual(["C"]);
    expect(exportedNames("c.js", "module.exports = class {};\n")).toEqual(["\"module.exports\""]);
  });

  test("module.exports = { ... } exports its function-valued members", () => {
    expect(
      exportedNames(
        "a.js",
        "function a() {}\nfunction b() {}\nfunction c() {}\nmodule.exports = { a, y: b, m() {}, n: () => 1, k: 3 };\n",
      ),
    ).toEqual(["\"module.exports.m\"", "\"module.exports.n\"", "a", "b"]);
  });

  test("exports.f = ... and module.exports.f = ...", () => {
    expect(
      exportedNames(
        "a.js",
        "function a() {}\nfunction b() {}\nfunction c() {}\nexports.a = a;\nmodule.exports.b = b;\nexports.d = function () {};\nexports.e = module.exports.e = () => 1;\n",
      ),
    ).toEqual(["\"exports.d\"", "\"module.exports.e\"", "a", "b"]);
  });

  test("a file that assigns something else exports nothing", () => {
    expect(exportedNames("a.js", "function f() {}\nconst x = f;\nobj.exports = f;\nexports.a.b = f;\n")).toEqual([]);
  });
});

describe("a function's signature", () => {
  test("is its parameter list and return type annotation as written", () => {
    expect(
      contractsOf(
        "a.ts",
        "export function f(a: string, b?: number, ...rest: boolean[]): Promise<void> {}\nexport const g = <T extends object>(x: T = {} as T): T => x;\n",
      ),
    ).toEqual([
      "f: exported (a: string, b?: number, ...rest: boolean[]): Promise<void>",
      "g: exported <T extends object>(x: T = {} as T): T",
    ]);
  });

  test("records no return type when none is written, and no types in plain JavaScript", () => {
    expect(contractsOf("a.js", "export function f(a, { b, c } = {}, [d] = []) { return 1; }\n")).toEqual([
      "f: exported (a, { b, c } = {}, [d] = [])",
    ]);
  });

  test("async and generator functions say so", () => {
    expect(contractsOf("a.js", "export async function f(a) {}\nexport function* g() {}\n")).toEqual([
      "f: exported async (a)",
      "g: exported * ()",
    ]);
  });

  test("an arrow's lone parameter reads as a parameter list", () => {
    expect(contractsOf("a.js", "export const f = a => a;\nexport const g = (a) => a;\n")).toEqual([
      "f: exported (a)",
      "g: exported (a)",
    ]);
  });

  test("reformatting, comments and trailing commas leave it alone", () => {
    const tidy = contractsOf("a.ts", "export function f(a: string, b = [1, 2]): number { return 1; }\n");
    const messy = contractsOf(
      "a.ts",
      "export function f(\n  a:   string, // the name\n  b = [ 1,\n 2 ],\n  /* trailing */\n):\n  number\n{ return 1; }\n",
    );
    expect(messy).toEqual(tidy);
  });

  test("a change to a parameter, a default or the return type changes it", () => {
    const sigs = [
      "export function f(a: string): void {}",
      "export function f(a: number): void {}",
      "export function f(a: string, b?: number): void {}",
      "export function f(a: string): number {}",
      "export function f(a = 'x  y'): void {}",
      "export function f(a = 'x y'): void {}",
    ].map((source) => contractsOf("a.ts", `${source}\n`)[0]);
    expect(new Set(sigs).size).toBe(sigs.length);
  });

  test("overloads are the signature callers see, not the implementation's", () => {
    expect(
      contractsOf(
        "a.ts",
        "export function f(a: string): string;\nexport function f(a: number): number;\nexport function f(a: any): any { return a; }\n",
      ),
    ).toEqual(["f: exported (a: string): string; (a: number): number"]);
  });

  test("a method and an object member have their own", () => {
    expect(contractsOf("a.js", "class C { static make(a, b) {} get size() {} }\n")).toEqual([
      "C: private { static make(a, b); get size() }",
      'C."get size": private ()',
      'C."static make": private (a, b)',
    ]);
  });
});

describe("a class's signature", () => {
  test("is its heritage clause and its public methods, in source order", () => {
    expect(
      contractsOf(
        "a.ts",
        "export class Square<T> extends Shape<T> implements Sized, Named {\n  private secret(a: number) {}\n  protected inner() {}\n  #hidden() {}\n  constructor(public side: number) { super(); }\n  area(): number { return 1; }\n  static unit(): Square<number> { return new Square(1); }\n  get half(): number { return 1; }\n  set half(v: number) {}\n  field = 1;\n  async load?(id: string): Promise<void> {}\n}\n",
      )[0],
    ).toBe(
      "Square: exported <T> extends Shape<T> implements Sized, Named { constructor(public side: number); area(): number; static unit(): Square<number>; get half(): number; set half(v: number); async load?(id: string): Promise<void> }",
    );
  });

  test("lists abstract and overloaded methods, which have no body", () => {
    expect(
      contractsOf(
        "a.ts",
        "export abstract class A {\n  abstract run(a: string): void;\n  m(a: string): void;\n  m(a: number): void;\n  m(a: any) {}\n}\n",
      )[0],
    ).toBe("A: exported { abstract run(a: string): void; m(a: string): void; m(a: number): void; m(a: any) }");
  });

  test("an empty class and one extending an expression", () => {
    expect(contractsOf("a.js", "export class A {}\nexport class B extends mixin(A) {}\n")).toEqual([
      "A: exported {}",
      "B: exported extends mixin(A) {}",
    ]);
  });

  test("a change to a private method or the body of a public one leaves it alone", () => {
    const before = contractsOf("a.js", "export class A { m(a) { return 1; } #p() {} }\n")[0];
    const after = contractsOf("a.js", "export class A { m(a) { return 2; } #q(x) { x; } }\n")[0];
    expect(after).toBe(before);
  });
});
