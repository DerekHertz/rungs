import { askCached } from "./link.ts";
import type { AgentRunner, Asked } from "./link.ts";
import { NARRATION_PROMPT_VERSION, NARRATION_SCHEMA, narrationPrompt, validateNarration } from "./narration.ts";
import type { Narration } from "./narration.ts";
import type { CodeNode, EffectEdge } from "./graph.ts";
import type { PseudoLine } from "./pseudo-line.ts";

export interface NarrateRequest {
  readonly node: CodeNode;
  readonly outline: readonly PseudoLine[];
  /** The graph's effect edges from this function. */
  readonly effects: readonly EffectEdge[];
  readonly runner: AgentRunner;
  readonly cacheDir: string;
  /** Ask the agent again even when the cache holds a narration. */
  readonly renarrate: boolean;
  readonly timeoutMs: number;
}

/**
 * Asks an agent to narrate one function, cached by the prompt: its version, the id, signature and
 * the outline's structure. A function with no outline has nothing to narrate and is not asked
 * about. The cached narration keeps the digest it was written for, so the caller can mark it stale.
 */
export function narrate(request: NarrateRequest): Promise<Asked<Narration>> {
  const { node, outline, effects, runner, cacheDir, renarrate, timeoutMs } = request;
  if (outline.length === 0) {
    return Promise.resolve({ status: "ok", digest: node.digest, sentences: [], dropped: { sentences: 0 }, model: "none", promptVersion: NARRATION_PROMPT_VERSION, cached: false });
  }
  return askCached<Narration>({
    prompt: narrationPrompt(node, outline, effects),
    schema: NARRATION_SCHEMA,
    promptVersion: NARRATION_PROMPT_VERSION,
    check: (output) => validateNarration(output, node.digest, outline),
    usable: (saved) => Array.isArray(saved.sentences) && typeof saved.digest === "string",
    runner,
    cacheDir,
    fresh: renarrate,
    timeoutMs,
  });
}
