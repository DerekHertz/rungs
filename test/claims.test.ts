import { expect, test } from "vitest";
import { splitClaims } from "../src/claims.ts";

const texts = (description: string): string[] => splitClaims(description).map((claim) => claim.text);

test("every claim is the exact slice of the description its offsets name", () => {
  const description = "## Summary\n\nAdds the parser. It handles `a.b` names!\n\n- first *bullet*\n  wrapped on\n- second\n";
  const claims = splitClaims(description);
  expect(claims.length).toBeGreaterThan(0);
  for (const [index, claim] of claims.entries()) {
    expect(claim.index).toBe(index);
    expect(description.slice(claim.start, claim.end)).toBe(claim.text);
  }
});

test("bullets are one claim each, with their wrapped lines, and the marker is not part of it", () => {
  expect(texts("- Adds a parser. And a lexer.\n* second one\n  continues here\n1. numbered\n2) also numbered\n")).toEqual([
    "Adds a parser. And a lexer.",
    "second one\n  continues here",
    "numbered",
    "also numbered",
  ]);
});

test("prose is split into sentences, joined across wrapped lines, and not at abbreviations or paths", () => {
  expect(texts("Adds the lexer. Wraps\nthe parser! Works e.g. with src/a.ts and v1.2 too? Yes.")).toEqual([
    "Adds the lexer.",
    "Wraps\nthe parser!",
    "Works e.g. with src/a.ts and v1.2 too?",
    "Yes.",
  ]);
});

test("headings, fenced code, blank lines and marks with no words are not claims", () => {
  expect(texts("# Title\n\n```\ncode. More code.\n```\n\n---\n- \n- real claim\n")).toEqual(["real claim"]);
});

test("a task-list box stays in the claim's text and a bullet may follow a paragraph directly", () => {
  expect(texts("Intro sentence.\n- [x] done thing\n- [ ] open thing\n")).toEqual(["Intro sentence.", "[x] done thing", "[ ] open thing"]);
});

test("no description, no claims; CRLF line ends do not leak into claims", () => {
  expect(splitClaims("")).toEqual([]);
  expect(texts("- one\r\n- two\r\n\r\nThree. Four.\r\n")).toEqual(["one", "two", "Three.", "Four."]);
});

test("splitting is deterministic", () => {
  const description = "A. B.\n- c\n";
  expect(splitClaims(description)).toEqual(splitClaims(description));
});
