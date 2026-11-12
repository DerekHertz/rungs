/**
 * "moves the contract of *sandbox*": the terms a risk or contract entry's code belongs to (judged,
 * see ../file-card.ts). The names come from the store, so they are set as text and never as markup.
 * Nothing when the entry names no term: a missing note never says "no term".
 */
export function termNote(prefix: string, names: readonly string[]): HTMLElement | undefined {
  if (names.length === 0) return undefined;
  const note = document.createElement("span");
  note.className = "contract-where term-note";
  note.title = "judged: the terms this code belongs to, by the classifier";
  note.append(`${prefix} `);
  names.forEach((name, at) => {
    if (at > 0) note.append(", ");
    const em = document.createElement("em");
    em.textContent = name;
    note.append(em);
  });
  return note;
}
