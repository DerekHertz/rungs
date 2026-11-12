import { element } from "./review-panel.ts";

/** The one-line headline above the review. It stays on one line: the full text is its title, shown on hover. Text only. */
export function renderHeadline(text: string): HTMLElement {
  const line = element("p", "rv-headline", text);
  line.title = text;
  return line;
}
