import type { Entry } from "../arrival.ts";
import { element } from "./review-panel.ts";

export interface ArrivalInput {
  /** What is compared, in one line. */
  readonly compared: string;
  readonly tests: Entry;
  readonly tour: Entry;
  readonly openTests: () => void;
  readonly startTour: () => void;
}

/** The opening view, and the way to change its tests entry when a run that was still going ends. */
export interface Arrival {
  readonly element: HTMLElement;
  setTests(entry: Entry): void;
}

/** One entry's button: kept focusable when off so its words and reason are read, but it opens nothing. */
function entryButton(entry: Entry, act: () => void): { readonly button: HTMLButtonElement; readonly set: (entry: Entry) => void } {
  const button = element("button", "rv-entry");
  button.type = "button";
  let enabled = false;
  const set = (next: Entry): void => {
    enabled = next.enabled;
    button.textContent = next.label;
    button.title = next.note;
    button.classList.toggle("off", !next.enabled);
    if (next.enabled) button.removeAttribute("aria-disabled");
    else button.setAttribute("aria-disabled", "true");
  };
  set(entry);
  button.addEventListener("click", () => {
    if (enabled) act();
  });
  return { button, set };
}

/** The top of the opening view: what is compared, and the two direct entries. Text only; nothing here is markup. */
export function renderArrival(input: ArrivalInput): Arrival {
  const wrap = element("section", "rv-arrival");
  wrap.setAttribute("aria-label", "This run");
  const compared = element("p", "rv-compared", input.compared);
  const entries = element("div", "rv-entries");
  const tests = entryButton(input.tests, input.openTests);
  entries.append(tests.button, entryButton(input.tour, input.startTour).button);
  wrap.append(compared, entries);
  return { element: wrap, setTests: tests.set };
}
