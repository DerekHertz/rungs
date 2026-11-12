import type { Comparison, ContractMove } from "../compare.ts";
import { isCodeNode } from "../graph.ts";
import type { Graph, LineRange, ModuleNode, NodeId } from "../graph.ts";
import { contractsReport, dependencyReview, effectsChangedRows, newEffects, unmentioned, unmentionedIds } from "../review.ts";
import type { BaseFunction, EffectRow, ReviewEntry } from "../review.ts";
import type { ObservedDocument } from "../observed-types.ts";
import type { observedReport } from "../observed-report.ts";
import type { RiskItem } from "../risks.ts";
import type { TestChanges } from "../test-changes-types.ts";
import { comparedLine, failingEntry, walkEntry } from "../arrival.ts";
import type { Entry, PullRequestName } from "../arrival.ts";
import { coverageLine, observedAt, stopFacts, tourCoverage, walkSummary } from "../stops.ts";
import type { WalkNote } from "../stops.ts";
import type { Stop } from "../tour.ts";
import { headline, headlineTitle } from "../headline.ts";
import { renderArrival } from "./arrival-panel.ts";
import { showHeadline } from "./headline-panel.ts";
import { loadRows } from "./code-rows.ts";
import { judgedInput } from "./judged-panel.ts";
import type { JudgedUpdate } from "./judged-panel.ts";
import { renderReview } from "./review-panel.ts";
import type { ClaimRow, LinkNote, ReviewHandle } from "./review-panel.ts";
import { renderWalkthrough } from "./walkthrough-panel.ts";
import type { Walk } from "./walkthrough-panel.ts";

/** What the review and the walkthrough read of the page: the picture's data. */
export interface ReviewData {
  readonly comparison: Comparison & { against: { ref: string; commit: string; pr?: PullRequestName } };
  readonly graph: Graph;
  readonly testChanges: TestChanges;
  readonly observed: ObservedDocument | null;
  readonly observedRun: ReturnType<typeof observedReport> | null;
  readonly nodes: ReadonlyMap<NodeId, ModuleNode>;
  readonly changed: ReadonlyMap<NodeId, ModuleNode>;
}

/** What the review and the walkthrough do to the page when the reviewer picks something. */
export interface ReviewActions {
  pickClaim(claim: ClaimRow): void;
  pickEntry(entry: ReviewEntry): void;
  pickNode(id: NodeId, marked?: LineRange): void;
  pickPlaces(ids: readonly string[]): void;
  showPick(): void;
  visitStop(stop: Stop | undefined): void;
  tourOpen(): boolean;
  endTour(): void;
  clearOutline(): void;
  /** The review element is unhidden: the page is now showing a review. */
  shown(): void;
  risksLoaded(risks: readonly RiskItem[]): void;
  reviewDrawn(handle: ReviewHandle): void;
  walkDrawn(walk: Walk): void;
}

/** What the page tells the review when the test run that was still going ends. */
export interface ReviewSink {
  observedEnded(document: ObservedDocument, run: ReturnType<typeof observedReport> | null): void;
}

/** The opening view's tests entry: the regressions of a run that had a control run, else the head run's failures labelled so; while a run is under way, which run. */
function testsEntry(document: ObservedDocument | null, run: ReturnType<typeof observedReport> | null): Entry {
  if (document === null) return failingEntry("absent", 0);
  if (document.status === "running") return failingEntry("running", 0, { stage: document.stage });
  const failing = run?.failing.length ?? 0;
  if (run === null) return failingEntry(document.status, failing);
  return run.control.status === "ran" ? failingEntry(document.status, failing, { others: run.others.length, uncompared: document.status === "ran" && document.control.status === "ran" ? document.control.notComparedFailures : 0 }) : failingEntry(document.status, failing, { noControl: "why" in run.control ? run.control.why : "" });
}

/** Loads the claims, contracts, walkthrough and risks, then draws the review sidebar, the walkthrough and the opening view. */
export async function setUpReview(data: ReviewData, on: ReviewActions): Promise<ReviewSink> {
  const { comparison, graph, testChanges, observedRun, nodes, changed } = data;
  // The run may still be going: the review and the walkthrough read the document as it is when they draw, and again when it ends.
  let observed = data.observed;
  const claims = (await (await fetch("/claims.json")).json()) as { description: string | null; claims: ClaimRow[]; sentences: { index: number; text: string }[]; context: { text: string }[]; link: LinkNote };
  const linked = new Set(claims.claims.flatMap((claim) => claim.ids as NodeId[]));
  const { moves } = (await (await fetch("/contracts.json")).json()) as { moves: ContractMove[] };
  const review = document.querySelector<HTMLElement>("#review")!;
  review.hidden = false;
  on.shown();
  // The base functions are fetched only when there is a description to check against them.
  const baseFunctions = claims.description === null ? [] : ((await (await fetch("/base-functions.json")).json()) as { functions: BaseFunction[] }).functions;
  const claimed = claims.description === null ? null : unmentioned(comparison, graph, claims.description, linked, testChanges, baseFunctions);
  const effects = newEffects(comparison, graph, claims.description ?? "", linked);
  const tour = (await (await fetch("/walkthrough.json")).json()) as { walkthrough: WalkNote; stops: Stop[] };
  const coverage = tourCoverage(tour.stops, comparison);
  const risks = ((await (await fetch("/risks.json")).json()) as { risks: RiskItem[] }).risks;
  on.risksLoaded(risks);
  // Judging may answer before the panel is drawn: the latest update waits for the handle.
  const drawn: { handle?: ReviewHandle; waiting?: JudgedUpdate } = {};
  const reviewHandle = renderReview(review, {
    ...(await judgedInput(claims.claims, claims.link.status === "ok", (update) => (drawn.handle === undefined ? (drawn.waiting = update) : drawn.handle.setJudged(update)))),
    walkAbout: tour.walkthrough.status === "ok" ? `${walkSummary(tour.walkthrough, tour.stops.length)} ${coverageLine(coverage)}` : walkSummary(tour.walkthrough, tour.stops.length),
    description: claims.description,
    claims: claims.claims,
    context: claims.context,
    link: claims.link,
    pickClaim: on.pickClaim,
    unmentioned: claimed,
    contracts: contractsReport(comparison, moves, claimed === null ? new Set() : unmentionedIds(claimed), graph, effectsChangedRows(comparison, graph, claims.description ?? "", linked)),
    effects,
    dependencies: dependencyReview(comparison, claims.description ?? ""),
    pick: on.pickEntry,
    pickEffect: (row: EffectRow) => on.pickNode(row.id, row.range),
    pickNode: on.pickNode,
    observed: observed === null ? null : { document: observed, report: observedRun },
    testChanges,
    unread: comparison.unread,
    risks,
    pickRisk: (risk: RiskItem) => {
      on.showPick();
      on.pickPlaces(risk.ids);
    },
  });
  drawn.handle = reviewHandle;
  if (drawn.waiting !== undefined) reviewHandle.setJudged(drawn.waiting);
  on.reviewDrawn(reviewHandle);

  const run =(await (await fetch("/run.json")).json()) as { repo: string | null };
  const host = document.querySelector<HTMLElement>("#walk")!;
  host.hidden = false;
  const unreadPaths = new Set(comparison.unread.map((file) => file.path));
  const walk = renderWalkthrough(host, {
    note: tour.walkthrough,
    stops: tour.stops,
    coverage,
    claims: claims.sentences,
    facts: (stop) => stopFacts(stop, comparison, graph, moves),
    observed: (stop) => observedAt(stop, graph, comparison, observed, testChanges),
    describe(id) {
      const node = nodes.get(id) ?? changed.get(id);
      if (node === undefined) return { label: id };
      return isCodeNode(node) ? { label: `${node.qualifiedName} in ${node.path}` } : { label: node.path };
    },
    rows(id) {
      const node = nodes.get(id) ?? changed.get(id);
      return loadRows(id, node !== undefined && isCodeNode(node) ? node.range.start : 1);
    },
    unread: (id) => unreadPaths.has((nodes.get(id) ?? changed.get(id))?.path ?? ""),
    visit: on.visitStop,
  });
  on.walkDrawn(walk);
  // The opening view: what is compared, and the failures and the tour one click away.
  const drawHeadline = (document: ObservedDocument | null): void => {
    const line = headline(comparison, testChanges, document);
    showHeadline(line, headlineTitle(line, document));
  };
  drawHeadline(observed);
  const arrival = renderArrival({
    compared: comparedLine(run.repo, comparison.against),
    tests: testsEntry(observed, observedRun),
    tour: walkEntry(tour.walkthrough, tour.stops.length, coverage),
    openTests: () => {
      // Going to the failing tests is a pick of the reviewer's own: it ends the tour and leaves its selection behind.
      if (on.tourOpen()) {
        on.endTour();
        reviewHandle.selectRisk(undefined);
        on.clearOutline();
      }
      void reviewHandle.openTests();
    },
    startTour: () => walk.step(1),
  });
  review.prepend(arrival.element);
  return {
    observedEnded(document, run) {
      observed = document;
      drawHeadline(document);
      reviewHandle.setObserved({ document, report: run });
      arrival.setTests(testsEntry(document, run));
      walk.refreshObserved();
    },
  };
}
