/**
 * What a step left running behind it, and how it is said. Free of node, so the page, the CLI and
 * the sandbox share one meaning. Only a step outside the sandbox can leave anything: in bwrap the
 * namespace ends with the step, so a step there has no `Leftover` at all, which is not the same as
 * a check that found nothing.
 */

/** A process found alive after its step. `killed` is false when it was still alive after the signal. */
export interface Stray {
  readonly pid: number;
  /** The process's command name, cut to plain characters: it came from the run. */
  readonly name: string;
  readonly killed: boolean;
}

export interface Leftover {
  /** Processes found alive after the step, each killed or not. */
  readonly strays: readonly Stray[];
  /** Processes found that `strays` does not list, because its length is capped. */
  readonly more: number;
  /**
   * Of those `more`, how many were not killed. Set whenever `more` is above 0, and a cut list lists
   * the processes that were not killed first, so a name left out never hides a survivor. Absent
   * with `more` above 0 means it is not known, which is taken as "may be running".
   */
  readonly moreAlive?: number;
  /** The step's output stayed open after it ended, and no process could be found to kill: one may still be running. */
  readonly held: boolean;
  /** Why the check could not run. Then nothing is known of what was left behind, and "none" is never said. */
  readonly notChecked?: string;
}

/** The most processes a merged leftover lists. */
export const STRAY_LIMIT = 20;

/**
 * The leftovers of every step of a run as one. Steps with none (in the sandbox) add nothing; when
 * every step was in the sandbox the run has none. A step whose check could not run keeps the whole
 * run "not checked", whatever the other steps found.
 */
export function mergeLeftovers(steps: readonly (Leftover | undefined)[]): Leftover | undefined {
  const present = steps.filter((step): step is Leftover => step !== undefined);
  if (present.length === 0) return undefined;
  const found = new Map<number, Stray>();
  let more = 0;
  // Names already cut from an earlier merge, with how many of them were not killed (unknown counts as all).
  let moreAlive = 0;
  for (const step of present) {
    more += step.more;
    moreAlive += step.more > 0 ? (step.moreAlive ?? step.more) : 0;
    for (const stray of step.strays) found.set(stray.pid, stray);
  }
  let all = [...found.values()];
  // A cut list keeps the processes that were not killed: the ones a reviewer must see.
  if (all.length > STRAY_LIMIT) all = [...all.filter((stray) => !stray.killed), ...all.filter((stray) => stray.killed)];
  const cut = all.slice(STRAY_LIMIT);
  more += cut.length;
  moreAlive += cut.filter((stray) => !stray.killed).length;
  const reasons = [...new Set(present.flatMap((step) => (step.notChecked === undefined ? [] : [step.notChecked])))];
  return {
    strays: all.slice(0, STRAY_LIMIT),
    more,
    ...(more > 0 ? { moreAlive } : {}),
    held: present.some((step) => step.held),
    ...(reasons.length === 0 ? {} : { notChecked: reasons.join("; ") }),
  };
}

const named = (strays: readonly Stray[]): string => strays.map((stray) => `${stray.name} (pid ${stray.pid})`).join(", ");

/**
 * What was left behind, in one sentence for the Tests row's note, the About note and the CLI.
 * "No process left behind" is said only by a check that ran; a check that could not run says
 * "leftovers not checked".
 */
export function leftoverText(leftover: Leftover): string {
  const killed = leftover.strays.filter((stray) => stray.killed);
  const alive = leftover.strays.filter((stray) => !stray.killed);
  const parts = [
    ...(killed.length > 0 ? [`left behind: ${named(killed)} killed`] : []),
    ...(alive.length > 0 ? [`left behind: ${named(alive)} not killable, still running on this machine`] : []),
    ...(leftover.more > 0 ? [`${leftover.more} more left behind, not listed (${leftover.moreAlive === undefined ? "not known whether killed" : leftover.moreAlive === 0 ? "all killed" : `${leftover.moreAlive} not killable, still running`})`] : []),
    ...(leftover.held ? ["a process the step started kept its output open and could not be found, so it may still be running"] : []),
    ...(leftover.notChecked === undefined ? [] : [`leftovers not checked (${leftover.notChecked})`]),
  ];
  return parts.length === 0 ? "no process left behind" : parts.join("; ");
}

/** Whether something may still be running: a process that was not killed, one not listed that may not have been, or output held open by one that could not be found. */
export function leftoverRunning(leftover: Leftover): boolean {
  return leftover.strays.some((stray) => !stray.killed) || (leftover.more > 0 && (leftover.moreAlive ?? leftover.more) > 0) || leftover.held;
}

/** Whether a reviewer must see this: something may still be running, or the check did not run. A killed process is only worth saying. */
export function leftoverWarns(leftover: Leftover): boolean {
  return leftoverRunning(leftover) || leftover.notChecked !== undefined;
}
