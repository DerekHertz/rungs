/** How often the page asks whether the picked PR has new commits. */
export const POLL_MS = 3 * 60 * 1000;
/** No two checks start closer than this, however often the window gains focus. */
export const MIN_GAP_MS = 60 * 1000;

/** Whether a check for new commits may start now: never while one is out, never inside the gap after the last start. */
export function mayCheck(now: number, lastStarted: number | null, inFlight: boolean): boolean {
  return !inFlight && (lastStarted === null || now - lastStarted >= MIN_GAP_MS);
}
