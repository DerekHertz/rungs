import { tooltipPosition } from "./tooltip.ts";

/** Shows the hover card `card` with `text` beside the pointer, inside the window. */
export function showTooltip(card: HTMLElement, text: string, at: { readonly x: number; readonly y: number }): void {
  card.textContent = text;
  card.style.display = "block";
  // Measure at the window's corner, so the last card's place never narrows this one.
  card.style.left = "0px";
  card.style.top = "0px";
  const place = tooltipPosition(at, { width: card.offsetWidth, height: card.offsetHeight }, { width: window.innerWidth, height: window.innerHeight });
  card.style.left = `${place.left}px`;
  card.style.top = `${place.top}px`;
}
