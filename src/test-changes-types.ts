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
  /**
   * A removed test paired with the one test added in its describe path: the same test under a new name. Not a removal.
   * Given the places, each side's callback lines (the base's for `fromCallback`, the head's for `callback`) when the name is held once there.
   */
  readonly renamed: readonly {
    readonly file: string;
    readonly from: string;
    readonly to: string;
    readonly fromCallback?: CallbackLines;
    readonly callback?: CallbackLines;
    /** Given with the places: each side's describe path and title as an array (`from` and `to` join it with " > ", which two different paths can share). */
    readonly fromTitles?: readonly string[];
    readonly toTitles?: readonly string[];
    /** Given with the places: the renamed test asserts less than before. */
    readonly weakened?: true;
  }[];
  /** A skip, todo or only that the head has and the base did not, on the test or suite it marks. */
  readonly markers: readonly { readonly file: string; readonly name: string; readonly marker: Marker; readonly callback?: CallbackLines }[];
  readonly weakened: readonly { readonly file: string; readonly name: string; readonly why: string; readonly callback?: CallbackLines }[];
  /** Given when the places are asked for (the picture's): test files both trees have whose text differs, the base test files the change edited. */
  readonly edited?: readonly string[];
  /**
   * Given with the places: for each source file that either tree has and whose text differs, the callbacks of the
   * test and suite calls the runner reads (`test.each(rows)("title", fn)` and `it.skip("title", fn)` included), by
   * lines in the base and in the head. A callback outside this list is an ordinary function, whatever its callee is called.
   */
  readonly callbacks?: readonly { readonly file: string; readonly base: readonly TestCallback[]; readonly head: readonly TestCallback[] }[];
}

/** A test or suite callback: its lines, and the call that makes it a test, as `test.each("title")`. */
export interface TestCallback extends CallbackLines {
  readonly label: string;
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
