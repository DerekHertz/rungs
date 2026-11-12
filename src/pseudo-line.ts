import type { LineRange, NodeId } from "./graph.ts";

export type LineKind =
  | "if" | "else if" | "else" | "switch" | "case" | "default"
  | "for" | "while" | "do" | "try" | "catch" | "finally"
  | "with" | "return" | "throw" | "break" | "continue" | "await" | "yield"
  | "effect" | "function" | "straight";

/**
 * One line of a function's outline. `range` is the source lines the line stands for: a header's
 * own lines for a branch or loop (never its body), the whole statement for a return, throw, jump
 * or effect. `node` is set on a nested function or class, which is shown as this one line.
 * `effect` is set on an effect line: the label of the very edge that call position was matched to,
 * as `effectLabel` writes it, so no reader has to match lines to edges again.
 */
export interface PseudoLine {
  readonly depth: number;
  readonly kind: LineKind;
  readonly text: string;
  readonly range: LineRange;
  readonly node?: NodeId;
  /** Set with `node` only where the prompt shows another id than the node's own (a computed member name, a very long id): see promptBase. */
  readonly promptNode?: string;
  readonly effect?: string;
}
