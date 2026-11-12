import type { ObservedDocument } from "./observed-types.ts";
import { POLL_FIRST_MS, POLL_GIVE_UP, POLL_LAST_MS } from "./judged-follow.ts";

/** What the page may attach to its picture: the document if it is of the picture's tree, else "stopped", so another tree's results are never drawn on this picture. */
export function ofPicture(document: ObservedDocument | null, pictureTree: string): ObservedDocument | null {
  if (document === null || document.tree === pictureTree) return document;
  return { tier: "observed", tree: pictureTree, status: "stopped", why: "the server now serves another tree" };
}

/**
 * The page's wait for the test run, the same polling as followJudging: it reads a `running`
 * /observed.json again after a second, easing out to five, and shows the first document that is
 * not `running`. The reader and clock are handed in. Five failed reads in a row end the wait with
 * the tests "not run" and why: a run the page cannot see is never shown as passing or as zero failures.
 */
export async function followObserved(pictureTree: string, read: () => Promise<ObservedDocument | null>, sleep: (ms: number) => Promise<void>, show: (document: ObservedDocument) => void): Promise<void> {
  let wait = POLL_FIRST_MS;
  let failures = 0;
  for (;;) {
    await sleep(wait);
    wait = Math.min(POLL_LAST_MS, Math.round(wait * 1.5));
    const document = await read();
    if (document === null) {
      failures += 1;
      if (failures < POLL_GIVE_UP) continue;
      show({ tier: "observed", tree: pictureTree, status: "stopped", why: "the page could not read the server's test progress" });
      return;
    }
    failures = 0;
    const mine = ofPicture(document, pictureTree);
    if (mine !== document || document.status !== "running") {
      show(mine ?? document);
      return;
    }
  }
}
