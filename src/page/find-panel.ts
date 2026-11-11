import { filterFiles, moveActive } from "../find-files.ts";
import type { Found } from "../find-files.ts";
import type { NodeId } from "../graph.ts";

/** A file the search can reach. */
export interface FileHit {
  readonly id: NodeId;
  readonly path: string;
  /** What the comparison did to it, or "" without one. */
  readonly change: string;
}

export interface FindInput {
  readonly box: HTMLInputElement;
  readonly results: HTMLElement;
  /** A polite live region that says how many files match. */
  readonly status: HTMLElement;
  readonly files: readonly FileHit[];
  /** The reviewer chose a file, by Enter or a click. */
  readonly choose: (hit: FileHit) => void;
}

/**
 * The file search as a combobox: typing filters the paths, the arrow keys move through the matches,
 * Enter or a click chooses one. Escape closes the list first. Everything shown goes in as text.
 */
export function wireFind({ box, results, status, files, choose }: FindInput): void {
  let hits: Found<FileHit> = { shown: [], total: 0 };
  let lit = -1;

  function paint(): void {
    const open = hits.shown.length > 0;
    results.hidden = !open;
    box.setAttribute("aria-expanded", String(open));
    results.replaceChildren(
      ...hits.shown.map((hit, index) => {
        const option = document.createElement("li");
        option.id = `find-option-${index}`;
        option.setAttribute("role", "option");
        option.setAttribute("aria-selected", String(index === lit));
        const path = document.createElement("span");
        path.className = "find-path";
        path.textContent = hit.path;
        option.append(path);
        if (hit.change !== "") {
          const kind = document.createElement("span");
          kind.className = "find-kind";
          kind.textContent = hit.change;
          option.append(kind);
        }
        option.addEventListener("click", () => pick(hit));
        return option;
      }),
    );
    if (hits.total > hits.shown.length) {
      const more = document.createElement("li");
      more.className = "find-more";
      more.setAttribute("role", "presentation");
      more.textContent = `${hits.total - hits.shown.length} more match; type more to narrow them`;
      results.append(more);
    }
    if (lit >= 0) box.setAttribute("aria-activedescendant", `find-option-${lit}`);
    else box.removeAttribute("aria-activedescendant");
    results.children[lit]?.scrollIntoView({ block: "nearest" });
    status.textContent = box.value.trim() === "" ? "" : hits.total === 0 ? "No file matches" : `${hits.total} ${hits.total === 1 ? "file matches" : "files match"}`;
  }

  function close(): void {
    hits = { shown: [], total: 0 };
    lit = -1;
    paint();
  }

  function pick(hit: FileHit): void {
    close();
    status.textContent = `Opened ${hit.path}`;
    choose(hit);
  }

  box.addEventListener("input", () => {
    hits = filterFiles(files, box.value);
    lit = hits.shown.length > 0 ? 0 : -1;
    paint();
  });
  box.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (hits.shown.length === 0) {
        hits = filterFiles(files, box.value);
        lit = hits.shown.length > 0 ? (event.key === "ArrowDown" ? 0 : hits.shown.length - 1) : -1;
      } else lit = moveActive(lit, event.key, hits.shown.length);
      paint();
    } else if (event.key === "Enter") {
      const hit = hits.shown[lit];
      if (hit === undefined) return;
      event.preventDefault();
      pick(hit);
    } else if (event.key === "Escape" && hits.shown.length > 0) {
      // The first Escape closes the list; the next one is the page's.
      event.stopPropagation();
      close();
    }
  });
  box.addEventListener("blur", () => setTimeout(close, 150));
  // Choosing a result with the pointer must not blur the field first.
  results.addEventListener("mousedown", (event) => event.preventDefault());
}
