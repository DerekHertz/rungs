import type { LineRange } from "./graph.ts";
import type { ObservedTest } from "./observed-types.ts";

/**
 * What the page says of one failed test, from what the run produced and nothing else. A line is
 * marked only when the runner's stack named it and it lies inside the test function; the failing
 * assertion is never worked out from the source around it.
 */
export type FailureView =
  | {
      readonly kind: "detailed";
      readonly message?: string;
      readonly operator?: string;
      readonly expected?: string;
      readonly actual?: string;
      /** The line of the test function the stack named. */
      readonly mark?: number;
      /** A line of the test's file the stack named, outside the test function. */
      readonly outside?: number;
    }
  | { readonly kind: "message-only"; readonly text: string };

export function failureView(test: ObservedTest, range: LineRange): FailureView {
  const { detail, message } = test;
  if (detail === undefined) return { kind: "message-only", text: message === undefined ? "the runner reported no message" : `the runner reported only: ${message}` };
  const inside = detail.line !== undefined && detail.line >= range.start && detail.line <= range.end;
  return {
    kind: "detailed",
    ...(message === undefined ? {} : { message }),
    ...(detail.operator === undefined ? {} : { operator: detail.operator }),
    ...(detail.expected === undefined ? {} : { expected: detail.expected }),
    ...(detail.actual === undefined ? {} : { actual: detail.actual }),
    ...(detail.line !== undefined && inside ? { mark: detail.line } : {}),
    ...(detail.line !== undefined && !inside ? { outside: detail.line } : {}),
  };
}
