import { posix } from "node:path";
import ts from "typescript";
import type { FileTree } from "./graph.ts";
import { isDiscovered, isTestFile } from "./test-files.ts";
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

/** What a local name is bound to: node's assert module, or one of its functions. */
type Binding = { readonly kind: "module"; readonly strict: boolean } | { readonly kind: "function"; readonly name: string; readonly strict: boolean };

const ASSERT_MODULE = /^(?:node:)?assert(\/strict)?$/;

const stringOf = (node: ts.Node | undefined): string | undefined => (node !== undefined && ts.isStringLiteralLike(node) ? node.text : undefined);

/** The module `require("assert")` names, with `.strict` taken off, or undefined. */
function requiredAssert(node: ts.Expression): { strict: boolean } | undefined {
  if (ts.isPropertyAccessExpression(node) && node.name.text === "strict") {
    const inner = requiredAssert(node.expression);
    return inner === undefined ? undefined : { strict: true };
  }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
    const match = ASSERT_MODULE.exec(stringOf(node.arguments[0]) ?? "");
    return match === null ? undefined : { strict: match[1] !== undefined };
  }
  return undefined;
}

/** Records what the declaration binds, if it binds node's assert. Called in source order. */
function bind(node: ts.Node, bindings: Map<string, Binding>): void {
  if (ts.isImportDeclaration(node) && node.importClause !== undefined) {
    const match = ASSERT_MODULE.exec(stringOf(node.moduleSpecifier) ?? "");
    if (match === null) return;
    const strict = match[1] !== undefined;
    const { name, namedBindings } = node.importClause;
    if (name !== undefined) bindings.set(name.text, { kind: "module", strict });
    if (namedBindings !== undefined && ts.isNamespaceImport(namedBindings)) bindings.set(namedBindings.name.text, { kind: "module", strict });
    if (namedBindings !== undefined && ts.isNamedImports(namedBindings)) {
      for (const element of namedBindings.elements) {
        const imported = (element.propertyName ?? element.name).text;
        bindings.set(element.name.text, imported === "strict" ? { kind: "module", strict: true } : { kind: "function", name: imported, strict });
      }
    }
  }
  if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
    const init = node.initializer;
    const required = requiredAssert(init);
    const from = ts.isIdentifier(init) ? bindings.get(init.text) : ts.isPropertyAccessExpression(init) && init.name.text === "strict" && ts.isIdentifier(init.expression) && bindings.get(init.expression.text)?.kind === "module" ? { kind: "module" as const, strict: true } : undefined;
    const source = required !== undefined ? { kind: "module" as const, strict: required.strict } : from;
    if (source === undefined) return;
    if (ts.isIdentifier(node.name)) bindings.set(node.name.text, source);
    else if (ts.isObjectBindingPattern(node.name) && source.kind === "module") {
      for (const element of node.name.elements) {
        if (!ts.isIdentifier(element.name)) continue;
        const imported = element.propertyName !== undefined && ts.isIdentifier(element.propertyName) ? element.propertyName.text : element.name.text;
        bindings.set(element.name.text, imported === "strict" ? { kind: "module", strict: true } : { kind: "function", name: imported, strict: source.strict });
      }
    }
  }
}

/** The assertion a call is, if it is one: assert(...), assert.x(...), t.assert.x(...), a bound assertion function, or a matcher on expect(...). */
function assertionOf(call: ts.CallExpression, bindings: ReadonlyMap<string, Binding>): Assertion | undefined {
  const constant = call.arguments.length > 0 && call.arguments.every(isLiteral);
  const chain = chainOf(call.expression);
  if (chain !== undefined) {
    const [first = "", second] = chain;
    const bound = bindings.get(first);
    if (bound?.kind === "module") {
      return { name: chain.length === 1 ? "assert" : (chain.at(-1) ?? ""), constant, plain: !bound.strict && second !== "strict" };
    }
    if (bound?.kind === "function" && chain.length === 1) return { name: bound.name === "default" ? "assert" : bound.name, constant, plain: !bound.strict };
    // Not imported here: a global, a helper, or the test context's own.
    if (bound === undefined && (first === "assert" || first === "strict" || (first === "t" && second === "assert" && chain.length > 2))) {
      return { name: chain.length === 1 ? "assert" : (chain.at(-1) ?? ""), constant, plain: false };
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
    return { name: names.at(-1) ?? "", constant: subject.arguments.length > 0 && subject.arguments.every(isLiteral), plain: false };
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
  const bindings = new Map<string, Binding>();
  // The names the enclosing tests call their context, each with the test it belongs to.
  const visit = (node: ts.Node, titles: readonly string[], current: Found, contexts: ReadonlyMap<string, Found>): void => {
    bind(node, bindings);
    if (ts.isCallExpression(node)) {
      // A parameter called `context` or `test` is the test's own, and `context.skip()` skips; it starts no suite.
      const own = chainOf(node.expression);
      const test = own?.length === 2 && contexts.has(own[0] ?? "") && (own[1] === "skip" || own[1] === "todo") ? undefined : testCall(node, titles.length > 0);
      if (test !== undefined) {
        const path = [...titles, titleOf(node)];
        const name = path.join(" > ");
        const made = entry(name, test.kind);
        for (const marker of [...test.markers, ...optionMarkers(node)]) made.markers.add(marker);
        if (test.kind === "test") tests.set(name, (tests.get(name) ?? 0) + 1);
        const callback = [...node.arguments].reverse().find((arg) => ts.isFunctionLike(arg));
        const parameter = callback !== undefined && ts.isFunctionLike(callback) ? callback.parameters[0]?.name : undefined;
        const inner = parameter !== undefined && ts.isIdentifier(parameter) ? new Map(contexts).set(parameter.text, made) : contexts;
        for (const arg of node.arguments) visit(arg, path, made, inner);
        // The call that made the callee (each, skipIf) is not a test of its own.
        if (ts.isCallExpression(node.expression)) ts.forEachChild(node.expression, (child) => visit(child, titles, current, contexts));
        return;
      }
      const assertion = assertionOf(node, bindings);
      if (assertion !== undefined) current.assertions.push(assertion);
      const chain = chainOf(node.expression);
      const owner = chain?.length === 2 ? contexts.get(chain[0] ?? "") : undefined;
      const last = chain?.at(-1);
      if (owner !== undefined && (last === "skip" || last === "todo")) owner.markers.add(last);
    }
    ts.forEachChild(node, (child) => visit(child, titles, current, contexts));
  };
  visit(source, [], outside, new Map());
  return { found, tests };
}

interface Totals {
  count: number;
  constant: number;
  loose: number;
}

/** Everything the same name holds, summed: two tests with one title are one test to compare. */
function totalsOf(entries: readonly Found[] | undefined): Totals {
  const totals = { count: 0, constant: 0, loose: 0 };
  for (const found of entries ?? []) {
    for (const assertion of found.assertions) {
      totals.count += 1;
      if (assertion.constant) totals.constant += 1;
      if (LOOSE.has(assertion.name) || (assertion.plain && COERCING.has(assertion.name))) totals.loose += 1;
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
  // A deleted file is a move only when it pairs with one file the head added at a path node --test
  // still finds; each added file pairs once. A move out of the test run is a removal.
  const added = new Map<string, string[]>();
  for (const [path, text] of head) if (!base.has(path)) added.set(text, [...(added.get(text) ?? []), path]);
  const deletedFiles: { path: string; tests: number; movedTo?: string }[] = [];
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
      const pair = added.get(before) ?? [];
      const found = pair.findIndex(isDiscovered);
      if (found >= 0) {
        pair.splice(found, 1);
        continue;
      }
      const tests = reads ? [...parse(before, path).tests.values()].reduce((sum, n) => sum + n, 0) : 0;
      deletedFiles.push(pair[0] === undefined ? { path, tests } : { path, tests, movedTo: pair[0] });
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
      const why = weakness(totalsOf(entries), totalsOf(now.found.get(name)));
      if (why !== undefined && now.found.has(name)) weakened.push({ file: path, name, why });
    }
  }
  return { deletedFiles, removedTests: removedTests.sort(byFileThenName), markers: markers.sort((a, b) => byFileThenName(a, b) || (a.marker < b.marker ? -1 : 1)), weakened: weakened.sort(byFileThenName) };
}
