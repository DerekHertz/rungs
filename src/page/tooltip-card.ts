import { tooltipPosition } from "./tooltip.ts";

/** Shows the hover card `card` with `text` beside the pointer, inside the window. */
export function showTooltip(card: HTMLElement, text: string, at: { readonly x: number; readonly y: number }): void {
  card.textContent = text;
  card.style.display = "block";
  const place = tooltipPosition(at, { width: card.offsetWidth, height: card.offsetHeight }, { width: window.innerWidth, height: window.innerHeight });
  card.style.left = `${place.left}px`;
  card.style.top = `${place.top}px`;
}
