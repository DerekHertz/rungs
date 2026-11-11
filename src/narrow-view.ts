/**
 * Which one view a narrow screen shows. A wide screen shows them side by side, so the state is only
 * read by the narrow layout; it is kept at every width so a window that narrows lands somewhere sensible.
 */
export type View = "list" | "town" | "evidence";

export interface ViewState {
  readonly view: View;
  /** The view the evidence was opened from, which "Back" returns to. */
  readonly from: View;
  /** The view the reviewer was on before the tour took the screen, which closing the tour returns to. */
  readonly before: View | undefined;
  /** False when there is no review list to show (no comparison). */
  readonly hasList: boolean;
}

export type ViewEvent =
  /** The reviewer pressed a switch. `evidence` says whether anything is open to show. */
  | { readonly type: "show"; readonly view: View; readonly evidence: boolean }
  /** A file or block was selected, so its evidence is open. */
  | { readonly type: "opened" }
  /** The evidence closed: Back, the close button, or Esc. */
  | { readonly type: "closed" }
  /** The tour came to a stop: the town shows what it outlines. */
  | { readonly type: "tour-started" }
  /** The tour closed. `resume` is true for its own Close, which returns to the view behind it; a pick that ended it keeps the view. */
  | { readonly type: "tour-ended"; readonly resume: boolean };

/** The list first when there is one: it is where the tests and the tour start. */
export function firstView(hasList: boolean): ViewState {
  return { view: hasList ? "list" : "town", from: hasList ? "list" : "town", before: undefined, hasList };
}

export function nextView(state: ViewState, event: ViewEvent): ViewState {
  switch (event.type) {
    case "show": {
      if (event.view === state.view) return state;
      if (event.view === "list" && !state.hasList) return state;
      if (event.view === "evidence" && !event.evidence) return state;
      // Going to the evidence by the switch comes back to where the reviewer was.
      return { ...state, view: event.view, from: event.view === "evidence" ? state.view : state.from };
    }
    case "opened":
      // Another pick while the evidence is up keeps where "Back" goes.
      return { ...state, view: "evidence", from: state.view === "evidence" ? state.from : state.view };
    case "closed":
      return state.view === "evidence" ? { ...state, view: state.from } : state;
    case "tour-started":
      return { ...state, view: "town", before: state.before ?? (state.view === "evidence" ? state.from : state.view) };
    case "tour-ended":
      // Only a reviewer still looking at the town is sent back; one who moved on stays where they went.
      return { ...state, view: event.resume && state.view === "town" && state.before !== undefined ? state.before : state.view, before: undefined };
  }
}

/** The text of "Back", naming where it goes: the tests when that row is open in the list. */
export function backLabel(from: View, openRow: string | undefined): string {
  if (from === "town") return "Back to town";
  return openRow === "tests" ? "Back to tests" : "Back to list";
}
