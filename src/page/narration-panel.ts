import type { NarratedDoc, NarratedSentence } from "../narration.ts";
import { element } from "./review-panel.ts";

/** What the narration pane shows: the agent still at work, a failure, or a narration. */
export type NarrationView = { readonly state: "loading" } | { readonly state: "failed"; readonly message: string } | { readonly state: "ok"; readonly doc: Extract<NarratedDoc, { status: "ok" }> };

export interface NarrationActions {
  /** A sentence was picked: band its outline rows and source lines. */
  pick(sentence: NarratedSentence, row: HTMLElement): void;
  /** Write the narration again, for a function that changed since. */
  again(): void;
}

/**
 * Draws a narration beside the function's pseudocode. It is always a claimed fact, so the tag is
 * there in every state; a stale one says so. Every word of the agent's reaches the page as text.
 */
export function renderNarration(host: HTMLElement, view: NarrationView, actions: NarrationActions): void {
  const head = element("div", "narration-head");
  head.append(element("span", "narration-title", "Narration"), element("span", "review-tag claimed", "claimed"));
  const body: HTMLElement[] = [];
  if (view.state === "loading") body.push(element("div", "narration-note", "Narrating…"));
  else if (view.state === "failed") body.push(element("div", "narration-note", `No narration: ${view.message}`));
  else {
    const { doc } = view;
    if (doc.stale) {
      head.append(element("span", "review-tag stale", "stale"));
      const again = element("button", "narration-again", "Narrate again");
      again.type = "button";
      again.addEventListener("click", actions.again);
      body.push(element("div", "narration-note", "The function has changed since this was written."), again);
    }
    for (const sentence of doc.sentences) {
      const row = element("div", "narration-sentence");
      row.append(element("span", "at", sentence.range.start === sentence.range.end ? `L${sentence.range.start}` : `L${sentence.range.start}-${sentence.range.end}`), element("span", "", sentence.text));
      row.addEventListener("click", () => actions.pick(sentence, row));
      body.push(row);
    }
    if (doc.sentences.length === 0) body.push(element("div", "narration-note", "Nothing to narrate."));
    const dropped = doc.dropped.sentences;
    body.push(element("div", "narration-note", `${doc.model === "none" ? "no agent asked" : doc.cached ? `${doc.model}, from the cache` : doc.model}${dropped > 0 ? `; ${dropped} unanchored ${dropped === 1 ? "sentence" : "sentences"} dropped` : ""}`));
  }
  host.replaceChildren(head, ...body);
  host.hidden = false;
}
