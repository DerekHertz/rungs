#!/usr/bin/env node
/**
 * Builds gates/standard/cases.json from gates/standard/sources.json.
 *
 *   node gates/standard/build.ts
 *
 * sources.json lists named rules (a heading and its text) and, for each case, its label, the rule
 * it is judged against and the base and head text of the changed file (a line array; null for a
 * file the base lacks or the head removes). For each case this builds two trees, the base holding
 * an AGENTS.md with the rule (and the changed file's base text) and the head the same with the
 * file's head text, then cuts the hunk and the rule into the gate's input with the same code the
 * running page uses (`standardInputFor`). The stored input is the gate's StandardInput, never a
 * rendered state, so a change to how the state is written re-renders every case.
 *
 * A case may add `ruleExtra`: text appended to the rule's body, used for steering text in the
 * rule itself. The case's note says so.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { standardInputFor } from "../../src/jev/standard-cases.ts";

const here = new URL(".", import.meta.url).pathname;

interface Rule {
  readonly heading: string;
  readonly body: string;
}
interface SourceCase {
  readonly id: string;
  readonly label: string;
  readonly steering?: boolean;
  readonly note?: string;
  readonly rule: string;
  readonly ruleExtra?: string;
  readonly files: Readonly<Record<string, { readonly base: readonly string[] | null; readonly head: readonly string[] | null }>>;
}

const sources = JSON.parse(readFileSync(join(here, "sources.json"), "utf8")) as { readonly bar: unknown; readonly rules: Readonly<Record<string, Rule>>; readonly cases: readonly SourceCase[] };
const text = (lines: readonly string[]): string => `${lines.join("\n")}\n`;
const cases = [];
for (const one of sources.cases) {
  const rule = sources.rules[one.rule];
  if (rule === undefined) throw new Error(`${one.id}: no rule named ${one.rule}`);
  const ruleFile = `# Working rules\n\n## ${rule.heading}\n\n${rule.body}${one.ruleExtra === undefined ? "" : `\n\n${one.ruleExtra}`}\n`;
  const base = new Map([["AGENTS.md", ruleFile]]);
  const head = new Map([["AGENTS.md", ruleFile]]);
  for (const [path, file] of Object.entries(one.files)) {
    if (file.base !== null) base.set(path, text(file.base));
    if (file.head !== null) head.set(path, text(file.head));
  }
  const input = standardInputFor(base, head, { heading: rule.heading, ...(Object.keys(one.files).length === 1 ? { file: Object.keys(one.files)[0]! } : {}) });
  cases.push({
    id: one.id,
    label: one.label,
    ...(one.steering === true ? { steering: true } : {}),
    ...(one.note === undefined ? {} : { note: one.note }),
    source: { how: "hand-built: a rule from a rule file, and the base and head text of one changed file (see sources.json)", rule: one.rule },
    input,
  });
  console.error(`${one.id}: ${input.hunk.before.length} lines before, ${input.hunk.after.length} after`);
}
writeFileSync(join(here, "cases.json"), `${JSON.stringify({ gate: "standard", bar: sources.bar, cases }, null, 1)}\n`);
