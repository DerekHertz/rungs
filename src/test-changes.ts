import { posix } from "node:path";
import ts from "typescript";
import type { FileTree } from "./graph.ts";
import { isTestFile } from "./test-files.ts";
import type { Marker, TestChanges } from "./test-changes-types.ts";

const OUTSIDE = "(outside any test)";
const SOURCE = /\.[cm]?[jt]sx?$/;

const SUITES = new Set(["describe", "suite", "context", "xdescribe", "fdescribe"]);
const TESTS = new Set(["test", "it", "xit", "fit", "xtest", "specify"]);
const BASE_MARKERS: Readonly<Record<string, Marker>> = { xit: "skip", xtest: "skip", xdescribe: "skip", fit: "only", fdescribe: "only" };
const SUFFIX_MARKERS: Readonly<Record<string, Marker>> = { skip: "skip", skipIf: "skip", todo: "todo", only: "only" };
const MODIFIERS = new Set(["each", "concurrent", "sequential", "runIf", "fails"]);
const OPTION_MARKERS = new Set<string>(["skip", "todo", "only"]);

/**
 * The assertions that say least: they pass for any truthy value. Swapping an exact assertion for
 * one of these is the usual way a test is made to pass.
 */
const LOOSE = new Set(["ok", "assert", "toBeTruthy", "toBeDefined"]);

interface Assertion {
  readonly name: string;
  readonly constant: boolean;
  /** Called on node:assert's default export, where equal compares with ==. */
  readonly plain: boolean;
}

/** In node:assert (not /strict) these coerce; their strict twins do not. */
const COERCING = new Set(["equal", "deepEqual", "notEqual", "notDeepEqual"]);

interface Found {
  readonly kind: "test" | "suite";
  readonly assertions: Assertion[];
  readonly markers: Set<Marker>;
}

interface Parsed {
  /** Every test and suite by its titles joined with " > "; one that appears twice is one entry with both. */
  readonly found: Map<string, Found[]>;
  /** The tests only, counted by name. */
  readonly tests: Map<string, number>;
  /** The file imports node:assert/strict, so its `assert.equal` is strict. */
  readonly strict: boolean;
}

const isLiteral = (node: ts.Node): boolean =>
  ts.isStringLiteralLike(node) ||
  ts.isNumericLiteral(node) ||
  ts.isBigIntLiteral(node) ||
  ts.isRegularExpressionLiteral(node) ||
  node.kind === ts.SyntaxKind.TrueKeyword ||
  node.kind === ts.SyntaxKind.FalseKeyword ||
  node.kind === ts.SyntaxKind.NullKeyword ||
  (ts.isIdentifier(node) && node.text === "undefined") ||
  (ts.isPrefixUnaryExpression(node) && isLiteral(node.operand));

/** `a.b.c` as ["a", "b", "c"]; undefined when it is anything but names joined by dots. */
function chainOf(node: ts.Expression): string[] | undefined {
  if (ts.isIdentifier(node)) return [node.text];
  if (ts.isPropertyAccessExpression(node)) {
    const inner = chainOf(node.expression);
    return inner === undefined ? undefined : [...inner, node.name.text];
  }
  return undefined;
}

/** The test or suite call this is, with the markers its own spelling gives it, or undefined. */
function testCall(call: ts.CallExpression, nested: boolean): { kind: "test" | "suite"; markers: Marker[] } | undefined {
  let callee: ts.Expression = call.expression;
  // test.each(rows)("title", fn) and test.skipIf(cond)("title", fn) call a call.
  const markers: Marker[] = [];
  while (ts.isCallExpression(callee)) {
    const inner = chainOf(callee.expression);
    const last = inner?.at(-1);
    if (last === "skipIf") markers.push("skip");
    else if (last !== "each" && last !== "runIf") return undefined;
    callee = callee.expression;
  }
  let chain = chainOf(callee);
  // Inside a test, t.test(...) and t.describe(...) start subtests, whatever the context is called.
  const [outer, inner] = chain ?? [];
  if (nested && chain !== undefined && outer !== undefined && inner !== undefined && !SUITES.has(outer) && !TESTS.has(outer) && (SUITES.has(inner) || TESTS.has(inner))) chain = chain.slice(1);
  const [head, ...rest] = chain ?? [];
  if (head === undefined) return undefined;
  const kind = SUITES.has(head) ? "suite" : TESTS.has(head) ? "test" : undefined;
  if (kind === undefined) return undefined;
  const base = BASE_MARKERS[head];
  if (base !== undefined) markers.push(base);
  for (const word of rest) {
    const marker = SUFFIX_MARKERS[word];
    if (marker !== undefined) markers.push(marker);
    else if (!MODIFIERS.has(word)) return undefined;
  }
  return { kind, markers };
}

function titleOf(call: ts.CallExpression): string {
  const first = call.arguments[0];
  if (first !== undefined && ts.isStringLiteralLike(first)) return first.text;
  return first === undefined ? "" : `<${first.getText()}>`;
}

/** The markers an options object gives: { skip: true } or { skip: "reason" }, never { skip: false }. */
function optionMarkers(call: ts.CallExpression): Marker[] {
  const found: Marker[] = [];
  for (const arg of call.arguments) {
    if (!ts.isObjectLiteralExpression(arg)) continue;
    for (const property of arg.properties) {
      if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name))) continue;
      const name = property.name.text;
      const value = property.initializer;
      const off = value.kind === ts.SyntaxKind.FalseKeyword || (ts.isIdentifier(value) && value.text === "undefined") || value.kind === ts.SyntaxKind.NullKeyword;
      if (OPTION_MARKERS.has(name) && !off) found.push(name as Marker);
    }
  }
  return found;
}

/** The assertion a call is, if it is one: assert(...), assert.x(...), strict.x(...), t.assert.x(...), or a matcher on expect(...). */
function assertionOf(call: ts.CallExpression): Assertion | undefined {
  const chain = chainOf(call.expression);
  if (chain !== undefined) {
    const [first, second] = chain;
    const last = chain.at(-1) ?? "";
    if (first === "assert" || first === "strict" || (first === "t" && second === "assert" && chain.length > 2)) {
      const name = chain.length === 1 ? "assert" : last;
      const plain = first === "assert" && second !== "strict";
      return { name, constant: call.arguments.length > 0 && call.arguments.every(isLiteral), plain };
    }
  }
  // expect(x).toBe(y), expect(x).not.toBe(y), expect(x).resolves.toEqual(y): the matcher is the assertion.
  let subject: ts.Expression = call.expression;
  const names: string[] = [];
  while (ts.isPropertyAccessExpression(subject)) {
    names.unshift(subject.name.text);
    subject = subject.expression;
  }
  if (names.length > 0 && ts.isCallExpression(subject) && ts.isIdentifier(subject.expression) && subject.expression.text === "expect") {
    const matcher = names.at(-1) ?? "";
    return { name: matcher, constant: subject.arguments.length > 0 && subject.arguments.every(isLiteral), plain: false };
  }
  return undefined;
}

function parse(text: string, path: string): Parsed {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found = new Map<string, Found[]>();
  const tests = new Map<string, number>();
  const entry = (name: string, kind: "test" | "suite"): Found => {
    const made: Found = { kind, assertions: [], markers: new Set() };
    found.set(name, [...(found.get(name) ?? []), made]);
    return made;
  };
  const outside = entry(OUTSIDE, "suite");
  let strict = false;
  const visit = (node: ts.Node, titles: readonly string[], current: Found): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && /^(?:node:)?assert\/strict$/.test(node.moduleSpecifier.text)) strict = true;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require" && node.arguments[0] !== undefined && ts.isStringLiteralLike(node.arguments[0]) && /^(?:node:)?assert\/strict$/.test(node.arguments[0].text)) strict = true;
    if (ts.isCallExpression(node)) {
      const test = testCall(node, titles.length > 0);
      if (test !== undefined) {
        const path = [...titles, titleOf(node)];
        const name = path.join(" > ");
        const made = entry(name, test.kind);
        for (const marker of [...test.markers, ...optionMarkers(node)]) made.markers.add(marker);
        if (test.kind === "test") tests.set(name, (tests.get(name) ?? 0) + 1);
        for (const arg of node.arguments) visit(arg, path, made);
        // The call that made the callee (each, skipIf) is not a test of its own.
        if (ts.isCallExpression(node.expression)) ts.forEachChild(node.expression, (child) => visit(child, titles, current));
        return;
      }
      const assertion = assertionOf(node);
      if (assertion !== undefined) current.assertions.push(assertion);
      const chain = chainOf(node.expression);
      const last = chain?.at(-1);
      if (chain?.length === 2 && chain[0] === "t" && last !== undefined && (last === "skip" || last === "todo")) current.markers.add(last);
    }
    ts.forEachChild(node, (child) => visit(child, titles, current));
  };
  visit(source, [], outside);
  return { found, tests, strict };
}

interface Totals {
  count: number;
  constant: number;
  loose: number;
}

/** Everything the same name holds, summed: two tests with one title are one test to compare. */
function totalsOf(entries: readonly Found[] | undefined, strict: boolean): Totals {
  const totals = { count: 0, constant: 0, loose: 0 };
  for (const found of entries ?? []) {
    for (const assertion of found.assertions) {
      totals.count += 1;
      if (assertion.constant) totals.constant += 1;
      if (LOOSE.has(assertion.name) || (assertion.plain && !strict && COERCING.has(assertion.name))) totals.loose += 1;
    }
  }
  return totals;
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

function weakness(before: Totals, after: Totals): string | undefined {
  if (after.count < before.count) return `${plural(before.count, "assertion")} became ${after.count}`;
  if (after.constant > before.constant) return `${plural(after.constant - before.constant, "assertion")} of constants added`;
  if (after.loose > before.loose) return `${plural(after.loose - before.loose, "assertion")} loosened (ok, toBeTruthy, toBeDefined, a bare assert, or equal in place of strictEqual)`;
  return undefined;
}

const byFileThenName = (a: { file: string; name: string }, b: { file: string; name: string }): number =>
  a.file < b.file ? -1 : a.file > b.file ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/**
 * Compares the test files of two trees. The changes are found by name, so a renamed test counts as
 * a removed one and a new one: the rules lean toward saying too much, because a quiet miss is the
 * failure that matters. Only JavaScript and TypeScript files are read for tests; any other test
 * file is only noticed when it is deleted.
 */
export function testChanges(base: FileTree, head: FileTree): TestChanges {
  // A deleted file is a move only when it pairs with one file the head added; each added file pairs once.
  const added = new Map<string, string[]>();
  for (const [path, text] of head) if (!base.has(path)) added.set(text, [...(added.get(text) ?? []), path]);
  const deletedFiles: { path: string; tests: number }[] = [];
  const removedTests: { file: string; name: string }[] = [];
  const markers: { file: string; name: string; marker: Marker }[] = [];
  const weakened: { file: string; name: string; why: string }[] = [];
  const markersOf = (parsed: Parsed): Set<string> => {
    const set = new Set<string>();
    for (const [name, entries] of parsed.found) for (const found of entries) for (const marker of found.markers) set.add(JSON.stringify([name, marker]));
    return set;
  };
  for (const path of [...new Set([...base.keys(), ...head.keys()])].sort()) {
    if (!isTestFile(path)) continue;
    const before = base.get(path);
    const after = head.get(path);
    const reads = SOURCE.test(posix.basename(path));
    if (after === undefined) {
      if (before === undefined) continue;
      const pair = added.get(before);
      if (pair !== undefined && pair.length > 0) {
        pair.pop();
        continue;
      }
      deletedFiles.push({ path, tests: reads ? [...parse(before, path).tests.values()].reduce((sum, n) => sum + n, 0) : 0 });
      continue;
    }
    if (!reads || before === after) continue;
    const now = parse(after, path);
    const was = before === undefined ? undefined : parse(before, path);
    const seen = was === undefined ? new Set<string>() : markersOf(was);
    for (const key of markersOf(now)) {
      if (seen.has(key)) continue;
      const [name, marker] = JSON.parse(key) as [string, Marker];
      markers.push({ file: path, name, marker });
    }
    if (was === undefined) continue;
    for (const [name, count] of was.tests) if ((now.tests.get(name) ?? 0) < count) removedTests.push({ file: path, name });
    for (const [name, entries] of was.found) {
      const why = weakness(totalsOf(entries, was.strict), totalsOf(now.found.get(name), now.strict));
      if (why !== undefined && now.found.has(name)) weakened.push({ file: path, name, why });
    }
  }
  return { deletedFiles, removedTests: removedTests.sort(byFileThenName), markers: markers.sort((a, b) => byFileThenName(a, b) || (a.marker < b.marker ? -1 : 1)), weakened: weakened.sort(byFileThenName) };
}
