#!/usr/bin/env node
/**
 * Builds gates/membership/cases.json from gates/membership/sources.json.
 *
 *   node gates/membership/build.ts
 *
 * sources.json holds, with the text inline: the terms (a doc section each, the phrase to look up),
 * the code (one function with the comment above it, and the path it was written at) and the cases
 * (a label, a term, a function). For each case this builds a small tree, the term's doc file and the
 * function's file, and cuts the gate's input out of it with the same code the setup runs
 * (`membershipInputFor`: the vocabulary is collected from the tree, the term is looked up in it and
 * the unit is read from the graph). The stored input is the gate's MembershipInput, never a rendered
 * state, so a change to how the state is written re-renders every case.
 *
 * Real cases are a real function and a real doc section of this repository at the commit named in
 * sources.json, copied as text. Hand-built cases are written for this bench, modelled on the layout
 * of a private project's helper folder, with no source copied. A steering case replaces the code's
 * lines (`codeOverride`) or the term's doc lines (`termOverride`) with text that carries a line
 * written to steer a model; its note says where.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { membershipInputFor } from "../../src/jev/membership-cases.ts";

const here = new URL(".", import.meta.url).pathname;

interface SourceCase {
  readonly id: string;
  readonly label: string;
  readonly term: string;
  readonly code: string;
  readonly unit: string;
  readonly steering?: boolean;
  readonly note?: string;
  readonly how: string;
  readonly termOverride?: Readonly<Record<string, readonly string[]>>;
  readonly codeOverride?: readonly string[];
}
interface Sources {
  readonly bar: unknown;
  readonly commit: string;
  readonly terms: Readonly<Record<string, { readonly phrase: string; readonly from: Record<string, unknown>; readonly files: Readonly<Record<string, readonly string[]>> }>>;
  readonly code: Readonly<Record<string, { readonly path: string; readonly from: Record<string, unknown>; readonly lines: readonly string[] }>>;
  readonly cases: readonly SourceCase[];
}

const sources = JSON.parse(readFileSync(join(here, "sources.json"), "utf8")) as Sources;
const text = (lines: readonly string[]): string => `${lines.join("\n")}\n`;
const cases = [];
for (const one of sources.cases) {
  const term = sources.terms[one.term];
  const code = sources.code[one.code];
  if (term === undefined) throw new Error(`${one.id}: no term named ${one.term}`);
  if (code === undefined) throw new Error(`${one.id}: no code named ${one.code}`);
  const tree = new Map<string, string>();
  for (const [path, lines] of Object.entries(one.termOverride ?? term.files)) tree.set(path, text(lines));
  tree.set(code.path, text(one.codeOverride ?? code.lines));
  const input = membershipInputFor(tree, { phrase: term.phrase, path: code.path, unit: one.unit });
  const real = typeof code.from.repo === "string";
  cases.push({
    id: one.id,
    label: one.label,
    ...(one.steering === true ? { steering: true } : {}),
    ...(one.note === undefined ? {} : { note: one.note }),
    source: { how: one.how, repo: real ? code.from.repo : "hand-built", ...(real ? { commit: sources.commit } : {}), term: term.from, code: code.from },
    input,
  });
  console.error(`${one.id}: ${input.unit.code.length} code lines, ${input.term.pins.length} places of the term`);
}
writeFileSync(join(here, "cases.json"), `${JSON.stringify({ gate: "membership", bar: sources.bar, cases }, null, 1)}\n`);
