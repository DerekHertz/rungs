import { posix } from "node:path";
import { roleOf } from "./extract/roles.ts";

/** What `node --test` finds on its own, beside the files Rungs gives the role "tests". */
const NODE_TEST_NAME = /^(?:test|.*[-_.]test|test-.*)\.[cm]?[jt]s$/;

/**
 * True for a file that is test code: one in a test folder, named like a test, or one `node --test`
 * would pick up. This is the one list of what counts as a test file, so a change that deletes or
 * weakens a test and the run that takes tests from the base agree on which files those are.
 */
export function isTestFile(path: string): boolean {
  return roleOf(path, true) === "tests" || NODE_TEST_NAME.test(posix.basename(path));
}
