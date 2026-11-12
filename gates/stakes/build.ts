#!/usr/bin/env node
/**
 * Builds gates/stakes/cases.json from gates/stakes/sources.json.
 *
 *   node gates/stakes/build.ts
 *
 * sources.json holds, with the text inline: the terms (a doc section each, the phrase to look up),
 * the code (one function with the comment above it, the path it was written at and its name) and
 * the cases (a label, a kind of harm, a term and its members). For each case this builds a small
 * tree, the term's doc file and the members' files, and cuts the gate's input out of it with the
 * same code the setup runs (`stakesInputFor`: the vocabulary is collected from the tree, the term
 * is looked up in it and the members are read from the graph). The stored input is the gate's
 * StakesInput, never a rendered state, so a change to how the state is written re-renders every case.
 *
 * Real cases are real functions and a real doc section of this repository at the commit named in
 * sources.json, copied as text. Hand-built cases are original code and docs written for this bench,
 * modelled on the layout of a private project's helper folder, with no source copied. A steering case
 * adds a line written to steer a model: in a comment of the first member (`codeOverride`) or in the
 * term's own docs (`termAppend`); its note says where.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stakesInputFor } from "../../src/jev/stakes-cases.ts";

const here = new URL(".", import.meta.url).pathname;

interface SourceCase {
  readonly id: string;
  readonly label: string;
  readonly kind: string;
  readonly term: string;
  readonly members: readonly string[];
  readonly steering?: boolean;
  readonly note?: string;
  readonly how: string;
  readonly termAppend?: Readonly<Record<string, readonly string[]>>;
  readonly codeOverride?: Readonly<Record<string, readonly string[]>>;
}
interface Sources {
  readonly bar: unknown;
  readonly commit: string;
  readonly terms: Readonly<Record<string, { readonly phrase: string; readonly from: Record<string, unknown>; readonly files: Readonly<Record<string, readonly string[]>> }>>;
  readonly code: Readonly<Record<string, { readonly path: string; readonly unit: string; readonly from: Record<string, unknown>; readonly lines: readonly string[] }>>;
  readonly cases: readonly SourceCase[];
}

const sources = JSON.parse(readFileSync(join(here, "sources.json"), "utf8")) as Sources;
const cases = [];
for (const one of sources.cases) {
  const term = sources.terms[one.term];
  if (term === undefined) throw new Error(`${one.id}: no term named ${one.term}`);
  const tree = new Map<string, string>();
  for (const [path, lines] of Object.entries(term.files)) tree.set(path, `${[...lines, ...(one.termAppend?.[path] ?? [])].join("\n")}\n`);
  // Members written in one file share it, in the order given, one blank line apart.
  const byPath = new Map<string, string[]>();
  const picks = one.members.map((id) => {
    const code = sources.code[id];
    if (code === undefined) throw new Error(`${one.id}: no code named ${id}`);
    byPath.set(code.path, [...(byPath.get(code.path) ?? []), ...(one.codeOverride?.[id] ?? code.lines), ""]);
    return { path: code.path, unit: code.unit };
  });
  for (const [path, lines] of byPath) tree.set(path, `${lines.join("\n")}\n`);
  const input = stakesInputFor(tree, { phrase: term.phrase, kind: one.kind, members: picks });
  const froms = one.members.map((id) => sources.code[id]!.from);
  const real = typeof froms[0]?.repo === "string";
  cases.push({
    id: one.id,
    label: one.label,
    ...(one.steering === true ? { steering: true } : {}),
    ...(one.note === undefined ? {} : { note: one.note }),
    source: { how: one.how, repo: real ? froms[0]!.repo : "hand-built", ...(real ? { commit: sources.commit } : {}), term: term.from, code: froms },
    input,
  });
  console.error(`${one.id}: ${input.members.length} members, ${input.term.pins.length} places of the term`);
}
writeFileSync(join(here, "cases.json"), `${JSON.stringify({ gate: "stakes", bar: sources.bar, cases }, null, 1)}\n`);
