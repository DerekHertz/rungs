import { callsOut } from "../town-calls.ts";
import type { Comparison } from "../compare.ts";
import type { reachMap } from "../reach.ts";
import type { Town } from "../town.ts";
import type { TestMark } from "../test-marks.ts";

/** The comparison as the page loads it, with the ref and commit it was made against. */
export type PageComparison = Comparison & { against: { ref: string; commit: string } };

/** What the legend reads from the page besides the town: the comparison, whether tests ran, the flagged test files and what reaches the outside. */
export interface LegendFacts {
  readonly comparison: PageComparison | null;
  readonly observedRan: boolean;
  readonly flagged: ReadonlyMap<string, TestMark>;
  readonly reaches: ReturnType<typeof reachMap>;
}

import { harbourText, plinthText, waysText } from "./legend-text.ts";

/** What the town's sprites stand for. Nothing is listed that the picture does not draw. */
export function showTownLegend(legend: HTMLElement, town: Town, shown: LegendFacts): void {
  const { comparison, observedRan, flagged, reaches } = shown;
  const kinds = document.createElement("div");
  kinds.textContent = "building: workshop source \u00b7 lab tests \u00b7 library docs \u00b7 shed config and build \u00b7 warehouse generated \u00b7 hut no role";
  const size = document.createElement("div");
  size.textContent = `size: classes and functions per file, square-root scale (${town.counts.fewest} to ${town.counts.most}); every file has a lot of the same size`;
  const harbour = document.createElement("div");
  harbour.textContent = harbourText(town);
  const stone = document.createElement("div");
  stone.textContent = plinthText(town);
  const ways = document.createElement("div");
  ways.textContent = waysText(town);
  const against = document.createElement("div");
  const flag = document.createElement("div");
  if (observedRan) flag.textContent = "red pennant: a test in the file failed when main's tests ran against this change (observed, one run; evidence against mistakes, not against a hostile author)";
  if (comparison !== null) {
    against.textContent = `against ${comparison.against.ref} (merge base ${comparison.against.commit.slice(0, 7)}): scaffolding and crane, named: altered \u00b7 bare earth: added \u00b7 rubble: removed \u00b7 rubble with a sign: moved to the path on it \u00b7 fence and sign: a block mostly new`;
  }
  const testMarked = document.createElement("div");
  const weakenedFiles = [...flagged.values()].filter((mark) => mark === "weakened").length;
  testMarked.textContent = [
    weakenedFiles > 0 ? "yellow checked banner: a test file whose tests the change removed, weakened or newly skipped (inside, that test's room has a yellow floor and a hazard sign)" : "",
    flagged.size > weakenedFiles ? "violet flag: a base test file the change edited" : "",
  ]
    .filter((text) => text !== "")
    .join(" \u00b7 ");
  const outside = document.createElement("div");
  const marked = callsOut(town.lots, reaches).size;
  outside.textContent = [
    marked > 0 ? "pink mast: a changed file whose new code calls out to the outside world (named only inside the file)" : "",
    town.piers.length > 0 ? "line: a selected building to the harbour structures it reaches, bright for a new call, dim for an old one" : "",
  ]
    .filter((text) => text !== "")
    .join(" \u00b7 ");
  const lines = document.createElement("section");
  lines.append(kinds, size, stone, ways, harbour, ...(outside.textContent === "" ? [] : [outside]), ...(comparison === null ? [] : [against]), ...(observedRan ? [flag] : []), ...(testMarked.textContent === "" ? [] : [testMarked]));
  const toggle = document.createElement("button");
  toggle.type = "button";
  const show = (open: boolean): void => {
    lines.hidden = !open;
    toggle.textContent = open ? "Legend \u25be" : "Legend \u25b8";
    toggle.setAttribute("aria-expanded", String(open));
  };
  // Collapsed to its one line so it never covers the picture, open only if the viewer left it open.
  show(legendState() === "open");
  toggle.addEventListener("click", () => {
    const open = lines.hidden === true;
    show(open);
    rememberLegend(open ? "open" : "closed");
  });
  legend.replaceChildren(toggle, lines);
}

const LEGEND_KEY = "streets.legend";

function legendState(): "open" | "closed" | undefined {
  try {
    const value = localStorage.getItem(LEGEND_KEY);
    return value === "open" || value === "closed" ? value : undefined;
  } catch {
    return undefined;
  }
}

function rememberLegend(state: "open" | "closed"): void {
  try {
    localStorage.setItem(LEGEND_KEY, state);
  } catch {
    // Without storage the legend simply opens each visit.
  }
}

