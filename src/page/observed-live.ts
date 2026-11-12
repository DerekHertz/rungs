import { followObserved } from "../observed-follow.ts";
import type { ObservedDocument } from "../observed-types.ts";

/** Reads /observed.json; null when it cannot be read. */
export async function readObserved(): Promise<ObservedDocument | null> {
  try {
    const response = await fetch("/observed.json");
    return response.ok ? ((await response.json()) as ObservedDocument) : null;
  } catch {
    return null;
  }
}

/**
 * Follows a test run the server is still doing (the same polling as the judged marks): when the
 * run ends, `ended` gets the document, and the page draws what it holds. Nothing is followed for
 * a document that is not `running`.
 */
export function followTestRun(pictureTree: string, first: ObservedDocument | null, ended: (document: ObservedDocument) => void): void {
  if (first?.status !== "running") return;
  void followObserved(pictureTree, readObserved, (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)), ended);
}
