/** The file search that gives the keyboard a route to any file, with or without a risk. */

export interface Found<T> {
  /** The best matches first, at most `limit`. */
  readonly shown: readonly T[];
  /** How many files match in all. */
  readonly total: number;
}

const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/**
 * The files whose path holds every word of `query` (case ignored), the ones whose file name starts
 * with the first word first, then those whose name holds it, then the rest by shorter path.
 * An empty query matches nothing: the list stays closed until the reviewer types.
 */
export function filterFiles<T extends { readonly path: string }>(files: readonly T[], query: string, limit = 50): Found<T> {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word !== "");
  if (words.length === 0) return { shown: [], total: 0 };
  const first = words[0]!;
  const ranked = files
    .map((file) => ({ file, path: file.path.toLowerCase() }))
    .filter(({ path }) => words.every((word) => path.includes(word)))
    .map(({ file, path }) => {
      const name = basename(path);
      return { file, rank: name.startsWith(first) ? 0 : name.includes(first) ? 1 : 2 };
    })
    .sort((a, b) => a.rank - b.rank || a.file.path.length - b.file.path.length || (a.file.path < b.file.path ? -1 : a.file.path > b.file.path ? 1 : 0));
  return { shown: ranked.slice(0, limit).map(({ file }) => file), total: ranked.length };
}

/** Where the highlighted result moves on an arrow key, wrapping at both ends; -1 is none yet. */
export function moveActive(current: number, key: "ArrowDown" | "ArrowUp" | "Home" | "End", count: number): number {
  if (count === 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowDown") return current < 0 || current >= count - 1 ? 0 : current + 1;
  return current <= 0 ? count - 1 : current - 1;
}

/** True where a key is text for the field, not a shortcut: single-letter keys and arrows must not fire there. */
export function isTyping(target: { readonly tagName?: string; readonly isContentEditable?: boolean } | null): boolean {
  if (target === null) return false;
  const tag = target.tagName?.toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable === true;
}
