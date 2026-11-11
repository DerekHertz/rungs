import { posix } from "node:path";
import { roleOf } from "./extract/roles.ts";

/** What `node --test` finds on its own, beside the files Systems to Streets gives the role "tests". */
const NODE_TEST_NAME = /^(?:test|.*[-_.]test|test-.*)\.[cm]?[jt]s$/;

/**
 * True for a file that is test code: one in a test folder, named like a test, or one `node --test`
 * would pick up. This is the one list of what counts as a test file, so a change that deletes or
 * weakens a test and the run that takes tests from the base agree on which files those are.
 */
export function isTestFile(path: string): boolean {
  return roleOf(path, true) === "tests" || NODE_TEST_NAME.test(posix.basename(path));
}

/**
 * True for a path `node --test` runs when it is given no files: a test-like name anywhere, or any
 * script inside a folder called `test`. A file moved out of this set is no longer run.
 */
export function isDiscovered(path: string): boolean {
  if (NODE_TEST_NAME.test(posix.basename(path))) return true;
  return /\.[cm]?[jt]s$/.test(path) && posix.dirname(path).split("/").includes("test");
}
