/** The derived list of what a change did to the tests, as /test-changes.json serves it; free of node so the page can read it too. */

/**
 * What a change did to the tests, read from the two trees' text and nothing that ran. A test has
 * to run the change's own code, so the change decides how its tests turn out; this is what is
 * left to see without running anything. Every fact here is derived.
 */
export interface TestChanges {
  /**
   * Test files of the base that the head no longer runs: deleted, or moved to a path `node --test`
   * does not find (`movedTo`).
   */
  readonly deletedFiles: readonly { readonly path: string; readonly tests: number; readonly movedTo?: string }[];
  /** Tests of a file the head still has whose name is gone, suites included in the name. */
  readonly removedTests: readonly { readonly file: string; readonly name: string }[];
  /** A removed test paired with the one test added in its describe path: the same test under a new name. Not a removal. */
  readonly renamed: readonly { readonly file: string; readonly from: string; readonly to: string }[];
  /** A skip, todo or only that the head has and the base did not, on the test or suite it marks. */
  readonly markers: readonly { readonly file: string; readonly name: string; readonly marker: Marker; readonly callback?: CallbackLines }[];
  readonly weakened: readonly { readonly file: string; readonly name: string; readonly why: string; readonly callback?: CallbackLines }[];
  /** Given when the places are asked for (the picture's): test files both trees have whose text differs, the base test files the change edited. */
  readonly edited?: readonly string[];
}

/**
 * The lines of the callback of a test, in the head's file, given only when the test's name is held
 * once in the file, so the picture can find its room by place and never by a title two tests share.
 */
export interface CallbackLines {
  readonly start: number;
  readonly end: number;
}

export type Marker = "skip" | "todo" | "only";
