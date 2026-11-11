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
  /** A skip, todo or only that the head has and the base did not, on the test or suite it marks. */
  readonly markers: readonly { readonly file: string; readonly name: string; readonly marker: Marker }[];
  readonly weakened: readonly { readonly file: string; readonly name: string; readonly why: string }[];
}

export type Marker = "skip" | "todo" | "only";
