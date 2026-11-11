/** What the page saved of the reviewer's own selection before the tour took it over. `value` may be undefined: nothing was selected. */
export type SavedSelection<S> = { readonly value: S } | undefined;

/** The tour came to a stop: keep the manual selection saved at the first stop, or take it now with `current`. */
export function enterStop<S>(saved: SavedSelection<S>, current: () => S): SavedSelection<S> {
  return saved ?? { value: current() };
}

/** The tour closed: what to restore, if anything, and the state to carry on with (nothing saved). */
export function leaveTour<S>(saved: SavedSelection<S>): { readonly state: SavedSelection<S>; readonly restore: SavedSelection<S> } {
  return { state: undefined, restore: saved };
}

/** A review row's identity: the nodes it selects and the file it is about. */
export interface RowKey {
  readonly ids: readonly string[];
  readonly path: string;
}

/** A node a stop holds: a file, or a block (class, function) inside one. */
export interface StopNode {
  readonly id: string;
  readonly path: string;
  readonly level: string;
}

/**
 * The row a stop selects: the first naming one of the stop's node ids, else, for a stop's file node
 * only, the first about that file. A block never falls back to its file: another block's risk in
 * the same file is not this stop's. Undefined when none matches, and the sidebar then shows nothing.
 */
export function stopRow(stop: readonly StopNode[], rows: readonly RowKey[]): number | undefined {
  const ids = new Set(stop.map((node) => node.id));
  const byId = rows.findIndex((row) => row.ids.some((id) => ids.has(id)));
  if (byId !== -1) return byId;
  const paths = new Set(stop.filter((node) => node.level === "file").map((node) => node.path));
  const byFile = rows.findIndex((row) => paths.has(row.path));
  return byFile === -1 ? undefined : byFile;
}
