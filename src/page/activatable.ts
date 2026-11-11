/** Makes a clickable row reachable by Tab and activated by Enter or Space, as a button is. Returns the row. */
export function activatable<E extends HTMLElement>(row: E, label?: string): E {
  row.tabIndex = 0;
  row.setAttribute("role", "button");
  if (label !== undefined) row.setAttribute("aria-label", label);
  row.addEventListener("keydown", (event) => {
    // A button inside the row (its own "open") keeps its own keys.
    if (event.target !== row || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    row.click();
  });
  return row;
}
