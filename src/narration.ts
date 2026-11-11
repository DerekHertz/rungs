// Page-safe: the source panel reads these types, so nothing here may import node:*. The page takes only the types, so the signature sanitizer's use of the TypeScript parser stays out of its bundle.

import type { CodeNode, LineRange } from "./graph.ts";
import type { PseudoLine } from "./pseudo-line.ts";
import { promptSignature } from "./signature.ts";

/** Bumped whenever the prompt or the schema changes, so older cached narrations are not reused. */
export const NARRATION_PROMPT_VERSION = "narration-v1";

const lines = (range: LineRange): string => (range.start === range.end ? `L${range.start}` : `L${range.start}-${range.end}`);

/**
 * The one thing the agent is shown of a function: its name, signature and lines, then its outline
 * as numbered structure. A pseudocode line's text is source text (its conditions and returned
 * expressions are as written), so only its kind, depth and lines reach the agent, plus what the
 * graph already says of it: the effect label of a call, the id of a nested function. No source text.
 */
export function narrationPrompt(node: CodeNode, outline: readonly PseudoLine[]): { system: string; user: string } {
  const rows = outline.map((line, index) => {
    const note = line.effect !== undefined ? ` ${line.effect}` : line.node === undefined ? "" : ` ${line.node}`;
    return `${index} ${"  ".repeat(line.depth)}${line.kind} ${lines(line.range)}${note}`;
  });
  const user = [`FUNCTION ${node.id} ${lines(node.range)}${node.exported ? " exported" : ""} ${promptSignature(node.signature)}`, "", "OUTLINE", ...rows].join("\n");
  return { system: SYSTEM, user };
}

export const NARRATION_SCHEMA = {
  type: "object",
  properties: {
    narration: {
      type: "array",
      items: {
        type: "object",
        properties: { text: { type: "string" }, from: { type: "integer" }, to: { type: "integer" } },
        required: ["text", "from", "to"],
        additionalProperties: false,
      },
    },
  },
  required: ["narration"],
  additionalProperties: false,
} as const;

const SYSTEM = `You narrate one function in plain English for a reviewer who reads its outline. Prompt version ${NARRATION_PROMPT_VERSION}.

You get the function's id, its lines and its signature, then its outline: numbered rows, each "<number> <indent><kind> L<lines>", indented by nesting depth, with the effect ("<resource> <API> <target>") on a row that calls outside the program and the id of a nested function on a row that holds one. You see no source code.

Return 2 to 8 sentences in the order of the outline. Each has "from" and "to": the numbers of the first and last outline rows it describes, "from" no greater than "to", both from the list.
- Say what the code at those rows is for, going only by the names, the signature, the kinds of row and the effects. Do not state what you cannot see: no conditions, values, algorithms or error handling you were not shown.
- Name every effect by its target or API name, on the row that shows it.
Answer with the JSON the schema asks for and nothing else.`;

/** One sentence of narration, a claimed fact about the outline rows `from` to `to`, whose source lines are `range`. */
export interface NarratedSentence {
  readonly text: string;
  readonly from: number;
  readonly to: number;
  readonly range: LineRange;
}

/** The agent's narration of one function after checking, and the digest of the function it was written for. */
export interface Narration {
  readonly digest: string;
  readonly sentences: readonly NarratedSentence[];
  readonly dropped: { readonly sentences: number };
}

const flat = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * Throws unless `output` has the schema's shape. Drops and counts the sentences that are empty or
 * not anchored to outline rows of this function, `from` to `to`, both inside the outline.
 */
export function validateNarration(output: unknown, digest: string, outline: readonly PseudoLine[]): Narration {
  const given = (output as { narration?: unknown } | null)?.narration;
  if (!Array.isArray(given)) throw new Error("the agent's answer has no narration list");
  const isInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);
  const sentences: NarratedSentence[] = [];
  let dropped = 0;
  for (const item of given as unknown[]) {
    const { text, from, to } = (item ?? {}) as { text?: unknown; from?: unknown; to?: unknown };
    if (typeof text !== "string" || !isInt(from) || !isInt(to)) throw new Error("the agent's answer has a malformed sentence");
    const first = outline[from];
    const last = outline[to];
    if (flat(text) === "" || first === undefined || last === undefined || from > to) dropped++;
    else sentences.push({ text: flat(text), from, to, range: { start: Math.min(...outline.slice(from, to + 1).map((line) => line.range.start)), end: Math.max(...outline.slice(from, to + 1).map((line) => line.range.end)) } });
  }
  return { digest, sentences, dropped: { sentences: dropped } };
}

/** A narration is stale when the function's digest is no longer the one narrated. */
export const isStale = (narration: Pick<Narration, "digest">, current: CodeNode): boolean => narration.digest !== current.digest;

/** What `POST /narration` answers: a claimed fact, with the digest it was written for and whether the function has changed since. */
export type NarratedDoc =
  | ({ readonly tier: "claimed"; readonly id: string; readonly status: "ok"; readonly narrated: string; readonly stale: boolean } & Omit<Narration, "digest"> & { readonly model: string; readonly promptVersion: string; readonly cached: boolean })
  | { readonly tier: "claimed"; readonly id: string; readonly status: "failed"; readonly message: string };
