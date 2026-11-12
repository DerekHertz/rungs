import type { Town } from "../town.ts";

/*
 * The legend's lines about what is absent, as text. A known negative is only said when no file
 * that could not be read could change it (SPEC rule 5): otherwise it is of the readable files.
 */

const unreadIn = (town: Town): number => town.lots.filter((lot) => lot.unread).length;
const files = (count: number): string => `${count} ${count === 1 ? "file" : "files"}`;

export function harbourText(town: Town): string {
  if (town.piers.length === 0 && town.unpictured.length === 0) {
    const unread = unreadIn(town);
    return unread === 0 ? "harbour: no outside resource is reached" : `harbour: no outside resource is reached in the files that could be read; ${files(unread)} could not be read`;
  }
  return `harbour: ${town.piers.map((pier) => pier.kind).join(", ")}${town.unpictured.length > 0 ? ` (no sprite yet for ${town.unpictured.join(", ")})` : ""}`;
}

export function plinthText(town: Town): string {
  const unread = unreadIn(town);
  const said = unread === 0 ? "" : ` · ${files(unread)} could not be read, so their imports are unknown`;
  return (
    (town.importance.most === 0
      ? "plinth: the stone a building stands on is as tall as the files resting on it through imports; no file has any here"
      : `plinth: the taller the stone, the more files rest on it through imports, square-root scale (${town.importance.fewest} to ${town.importance.most}); none where nothing rests on it · point at a building for the list`) + said
  );
}

export function waysText(town: Town): string {
  const none = `a code file has one when a way in reaches it through imports${town.unreached === 0 && town.reachUnknown > 0 ? "" : `, and ${town.unreached} code files have none: nothing reaches them`}`;
  const maybe = town.reachUnknown === 0 ? "" : `; ${town.reachUnknown} code ${town.reachUnknown === 1 ? "file" : "files"} could be reached through a file that could not be read: reach unknown`;
  return `gate: a way in the repo declares in package.json (main, bin, exports, scripts); test files are ways in too, with no gate · footpath: every file but code has one; ${none}${maybe}`;
}
