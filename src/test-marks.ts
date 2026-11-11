import type { CallbackLines, TestChanges } from "./test-changes-types.ts";

/*
 * Which test files and tests the picture marks, from facts alone (SPEC, The picture; Review:
 * Risks). A file is marked "weakened" when the change removed, weakened or newly skipped, todo'd
 * or only'd one of its tests, and "edited" when the change altered a base test file without any of
 * that. A test's room is marked inside the file for the tests that were weakened or marked. A
 * removed test has no room in the head, so only its file shows it. Node-free: the page reads it.
 */

export type TestMark = "weakened" | "edited";

export interface TestMarks {
  /** The mark of each test file, by path. Only a test file both trees have can be marked. */
  readonly files: ReadonlyMap<string, TestMark>;
  /** Per test file, the callback lines of the tests whose rooms are marked; a test whose name two tests share has none. */
  readonly tests: ReadonlyMap<string, readonly CallbackLines[]>;
}

export const NO_TEST_MARKS: TestMarks = { files: new Map(), tests: new Map() };

export function testMarks(changes: TestChanges): TestMarks {
  // A new test file has no base to weaken, and a moved one is the same file: only an edited one counts.
  const existing = new Set(changes.edited ?? []);
  const files = new Map<string, TestMark>();
  const tests = new Map<string, CallbackLines[]>();
  const mark = (file: string, callback: CallbackLines | undefined): void => {
    if (!existing.has(file)) return;
    files.set(file, "weakened");
    if (callback !== undefined) tests.set(file, [...(tests.get(file) ?? []), callback]);
  };
  for (const test of changes.removedTests) mark(test.file, undefined);
  for (const test of changes.weakened) mark(test.file, test.callback);
  for (const test of changes.markers) mark(test.file, test.callback);
  for (const file of existing) if (!files.has(file)) files.set(file, "edited");
  return { files, tests };
}

const TEST_CALLEES = new Set(["test", "it", "describe", "suite", "context", "skip", "only", "todo", "concurrent", "sequential", "fails"]);
const CALLBACK = /^([\w$]+)\(("(?:[^"\\]|\\.)*")\) callback$/;

/** The (text, ordinal) pairs of a qualified name, as the graph writes them. */
function segments(name: string): string[] {
  const texts: string[] = [];
  let rest = name;
  while (rest !== "") {
    const quoted = /^"(?:[^"\\]|\\.)*"/.exec(rest)?.[0];
    const head = quoted ?? /^[^.@]+/.exec(rest)?.[0] ?? rest;
    texts.push(quoted === undefined ? head : (JSON.parse(quoted) as string));
    rest = rest.slice(head.length).replace(/^@\d+/, "").replace(/^\./, "");
  }
  return texts;
}

/** The titles a test function is reported under, or undefined when any level is not a test or suite call. */
export function titlesOf(qualifiedName: string): string[] | undefined {
  const titles: string[] = [];
  for (const text of segments(qualifiedName)) {
    const match = CALLBACK.exec(text);
    if (match === null || !TEST_CALLEES.has(match[1] ?? "")) return undefined;
    titles.push(JSON.parse(match[2] ?? '""') as string);
  }
  return titles;
}
