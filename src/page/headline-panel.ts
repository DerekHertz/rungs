/** The one-line headline in its strip under the top bar. It stays on one line: the full text is its title, shown on hover. Text only. */
export function showHeadline(text: string, title: string = text): void {
  const strip = document.querySelector<HTMLElement>("#headline")!;
  strip.textContent = text;
  strip.title = title;
  strip.hidden = false;
}
