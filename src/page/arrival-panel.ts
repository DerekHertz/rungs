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

/** The top of the opening view: what is compared, and the two direct entries. Text only; nothing here is markup. */
export function renderArrival(input: ArrivalInput): HTMLElement {
  const wrap = element("section", "rv-arrival");
  wrap.setAttribute("aria-label", "This run");
  const compared = element("p", "rv-compared", input.compared);
  const entries = element("div", "rv-entries");
  for (const [entry, act] of [[input.tests, input.openTests], [input.tour, input.startTour]] as const) {
    const button = element("button", "rv-entry", entry.label);
    button.type = "button";
    button.title = entry.note;
    if (entry.enabled) button.addEventListener("click", act);
    else {
      // Kept focusable so its words and reason are read, but it opens nothing.
      button.setAttribute("aria-disabled", "true");
      button.classList.add("off");
    }
    entries.append(button);
  }
  wrap.append(compared, entries);
  return wrap;
}
