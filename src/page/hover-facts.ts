import { tallyText } from "../compare.ts";
import type { Picture } from "../compare.ts";
import type { FileNode, ModuleNode, NodeId } from "../graph.ts";
import type { Lot } from "../town.ts";
import type { WayIn } from "../importance.ts";
import { restsOnIt } from "../defining.ts";
import type { observedReport } from "../observed-report.ts";
import type { TestMarks } from "../test-marks.ts";

/** What the hover card reads from the page. `lots` is a function because the town rebuilds its lots as the camera moves. */
export interface HoverFactsInput {
  readonly nodes: ReadonlyMap<NodeId, ModuleNode>;
  readonly ghostFiles: ReadonlyMap<NodeId, ModuleNode>;
  readonly lots: () => ReadonlyMap<NodeId, Lot>;
  readonly picture: Picture;
  readonly importance: ReadonlyMap<NodeId, readonly NodeId[]>;
  readonly waysIn: readonly WayIn[];
  readonly reachedByWays: ReadonlySet<NodeId>;
  readonly marks: TestMarks;
  readonly observedRun: ReturnType<typeof observedReport> | null;
}

/** The lines the hover card shows for a building: the path, what the change did, its role, importance, failures and size. */
export function hoverFacts({ nodes, ghostFiles, lots, picture, importance, waysIn, reachedByWays, marks, observedRun }: HoverFactsInput): (id: NodeId) => string[] | undefined {
  function describe(id: NodeId): string[] | undefined {
    const file = nodes.get(id) ?? ghostFiles.get(id);
    const lot = lots().get(id);
    if (file?.level !== "file" || lot === undefined) return undefined;
    return [
      file.path,
      ...changeFacts(file),
      `role: ${file.role ?? "none"}`,
      ...townFacts(file),
      ...failingFacts(file),
      ...testMarkFacts(file),
      file.lines === null ? "binary" : `lines: ${file.lines}`,
      file.analysis === "analysed"
        ? `functions: ${lot.functions}   classes: ${lot.classes}`
        : "not analysed",
    ];
  }

  const TOOLTIP_FILES = 10;

  /** What the change did to the file's tests, when it is a test file the town flags. */
  function testMarkFacts(file: FileNode): string[] {
    const mark = marks.files.get(file.path);
    if (mark === undefined) return [];
    return [mark === "weakened" ? "tests weakened, removed or skipped by this change (derived)" : "base test file edited by this change (derived)"];
  }

  /** The tests of the file that failed when main's tests ran against this change. */
  function failingFacts(file: FileNode): string[] {
    const failed = (observedRun?.failing ?? []).filter((test) => test.file === file.path);
    return failed.length === 0 ? [] : [`failing tests (observed): ${failed.length}`, ...failed.slice(0, 5).map((test) => `· ${test.name}`), ...(failed.length > 5 ? [`· and ${failed.length - 5} more`] : [])];
  }

  /** In the town: what rests on the file (the count with its list), how the repo declares it a way in, and whether anything reaches it. */
  function townFacts(file: FileNode): string[] {
    const above = (importance.get(file.id) ?? []).map((id) => nodes.get(id)?.path ?? id);
    const way = waysIn.find((entry) => entry.id === file.id);
    return [
      above.length === 0 ? "importance: nothing rests on it" : `importance: ${restsOnIt(above.length)}`,
      ...above.slice(0, TOOLTIP_FILES).map((path) => `  ${path}`),
      ...(above.length > TOOLTIP_FILES ? [`  and ${above.length - TOOLTIP_FILES} more: click the building for the full list`] : []),
      ...(way === undefined ? [] : [`way in: ${way.reasons.join(", ")}`]),
      ...(reachedByWays.has(file.id) ? [] : ["nothing reaches it"]),
    ];
  }

  function changeFacts(file: FileNode): string[] {
    if (!nodes.has(file.id) && lots().get(file.id)?.movedTo != null) return [`moved away to ${lots().get(file.id)?.movedTo?.path}`];
    const entry = picture.overlay?.entry(file.id);
    if (entry === undefined) return picture.overlay === null ? [] : ["change: unchanged"];
    const facts = [`change: ${entry.kind}`];
    if (entry.kind === "moved") facts.push(`moved from ${entry.from.path}`);
    if (entry.kind === "removed") facts.push(`removed (was ${file.lines === null ? "binary" : `${file.lines} lines`})`);
    const tally = picture.overlay?.tally(file.id) ?? null;
    const code = tally === null ? "" : tallyText(tally);
    if (code !== "") facts.push(`functions ${code}`);
    return facts;
  }

  return describe;
}
