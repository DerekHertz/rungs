import { expect, test } from "vitest";
import { backLabel, firstView, nextView } from "../src/narrow-view.ts";
import type { ViewEvent, ViewState } from "../src/narrow-view.ts";

const run = (start: ViewState, ...events: ViewEvent[]): ViewState => events.reduce(nextView, start);

test("a review opens on the list, and a picture with no review opens on the town", () => {
  expect(firstView(true).view).toBe("list");
  expect(firstView(false).view).toBe("town");
});

test("opening a failure from the list shows the evidence, and closing it returns to the list", () => {
  const opened = run(firstView(true), { type: "opened" });
  expect(opened).toMatchObject({ view: "evidence", from: "list" });
  expect(run(opened, { type: "closed" }).view).toBe("list");
});

test("a pick on the town returns to the town", () => {
  const state = run(firstView(true), { type: "show", view: "town", evidence: false }, { type: "opened" });
  expect(state).toMatchObject({ view: "evidence", from: "town" });
  expect(run(state, { type: "closed" }).view).toBe("town");
});

test("another pick while the evidence is up keeps where Back goes", () => {
  const state = run(firstView(true), { type: "opened" }, { type: "opened" });
  expect(state).toMatchObject({ view: "evidence", from: "list" });
});

test("the switch reaches the evidence only when something is open, and comes back from where it left", () => {
  const start = firstView(true);
  expect(run(start, { type: "show", view: "evidence", evidence: false })).toBe(start);
  const away = run(start, { type: "opened" }, { type: "show", view: "town", evidence: true }, { type: "show", view: "evidence", evidence: true });
  expect(away).toMatchObject({ view: "evidence", from: "town" });
});

test("closing when the evidence is not the view changes nothing", () => {
  const onTown = run(firstView(true), { type: "opened" }, { type: "show", view: "town", evidence: true });
  expect(run(onTown, { type: "closed" })).toBe(onTown);
});

test("without a list the switch never goes to it", () => {
  const start = firstView(false);
  expect(run(start, { type: "show", view: "list", evidence: false })).toBe(start);
});

test("a tour takes the town and closing it returns to where the reviewer was", () => {
  const touring = run(firstView(true), { type: "tour-started" }, { type: "tour-started" });
  expect(touring).toMatchObject({ view: "town", before: "list" });
  expect(run(touring, { type: "tour-ended", resume: true })).toMatchObject({ view: "list", before: undefined });
});

test("a tour started over the evidence remembers the view behind it", () => {
  const state = run(firstView(true), { type: "opened" }, { type: "tour-started" });
  expect(state).toMatchObject({ view: "town", before: "list" });
});

test("a reviewer who moved on during the tour stays there when it closes", () => {
  const state = run(firstView(true), { type: "tour-started" }, { type: "show", view: "list", evidence: false }, { type: "tour-ended", resume: true });
  expect(state.view).toBe("list");
  const picked = run(firstView(true), { type: "show", view: "town", evidence: false }, { type: "tour-started" }, { type: "opened" }, { type: "tour-ended", resume: true });
  expect(picked.view).toBe("evidence");
});

test("a pick that ends the tour keeps the town, so Back from its evidence returns to the town", () => {
  const ended = run(firstView(true), { type: "tour-started" }, { type: "tour-ended", resume: false });
  expect(ended).toMatchObject({ view: "town", before: undefined });
  expect(run(ended, { type: "opened" })).toMatchObject({ view: "evidence", from: "town" });
});

test("a pick that only outlines the town shows the town, and the list tab returns to the list", () => {
  const state = run(firstView(true), { type: "show", view: "town", evidence: false });
  expect(state.view).toBe("town");
  expect(run(state, { type: "show", view: "list", evidence: false }).view).toBe("list");
});

test("Back names where it goes, the tests when that row is open", () => {
  expect(backLabel("list", "tests")).toBe("Back to tests");
  expect(backLabel("list", "claims")).toBe("Back to list");
  expect(backLabel("list", undefined)).toBe("Back to list");
  expect(backLabel("town", "tests")).toBe("Back to town");
});
