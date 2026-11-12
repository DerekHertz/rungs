/**
 * The Jev client: typed questions about a state go in, a probability per question and the call's
 * cost come out. Jev is TypeSafe's hosted classifier ("System One"); it judges and never writes.
 *
 * Two rules shape the types. A question is a constant of its gate, so no text from the repository
 * under review can reach an instruction: repository text only ever goes in `state`, as data. And
 * the client is an interface, so tests (and the gate bench) inject a fake and never touch the
 * network. The key is read by the caller and held in a closure; it appears in no error, log or URL.
 */

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-1.14.0";
/** Dollars per million input tokens. Output tokens are free. */
export const JEV_RATE_PER_MILLION = 0.042;
export const DEFAULT_TIMEOUT_MS = 60_000;

/** Dollars for a call that read `inputTokens` tokens. */
export function jevCost(inputTokens: number): number {
  return (inputTokens * JEV_RATE_PER_MILLION) / 1e6;
}

/** A yes/no question: the probability of "yes". Fixed text, written by the gate's author. */
export interface YesNoQuestion {
  readonly type: "yes-no";
  readonly instructions: string;
  readonly criteria: { readonly true: string; readonly false: string };
}

/** A choice among named options, each described by the gate's author. */
export interface ChoiceQuestion {
  readonly type: "choice";
  readonly instructions: string;
  readonly criteria: Readonly<Record<string, string>>;
}

export type JevQuestion = YesNoQuestion | ChoiceQuestion;

/** What Jev is shown. `state` is data (repository text goes here, named by key); `questions` is instructions. */
export interface JevRequest {
  readonly state: Readonly<Record<string, string>>;
  readonly questions: Readonly<Record<string, JevQuestion>>;
}

export type JevAnswer =
  | { readonly type: "yes-no"; readonly yes: number }
  /** The call succeeded but this answer is missing or malformed: kept with what came back, never read as a probability. */
  | { readonly type: "unreadable"; readonly why: string; readonly raw: string }
  | { readonly type: "choice"; readonly probabilities: Readonly<Record<string, number>>; readonly choice: string; readonly confidence: number | null };

export interface JevUsage {
  /** Null when the service's count is missing or not a non-negative integer: unknown, never zero. */
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  /** Dollars: input tokens at the published rate; null when `inputTokens` is unknown. */
  readonly usd: number | null;
}

export interface JevResponse {
  /** One answer per question key, every one checked to be a probability. */
  readonly answers: Readonly<Record<string, JevAnswer>>;
  readonly usage: JevUsage;
  /** The model version that answered. */
  readonly model: string;
}

export type JevFailure = "off" | "no-key" | "http" | "timeout" | "network" | "bad-response";

/** Why a call produced no answers. `message` is one line, safe to show; it never holds the key. */
export class JevError extends Error {
  readonly kind: JevFailure;
  readonly status: number | undefined;
  constructor(kind: JevFailure, message: string, status?: number) {
    super(message);
    this.name = "JevError";
    this.kind = kind;
    this.status = status;
  }
}

export interface JevClient {
  /** The model version this client asks; part of every cache key. */
  readonly model: string;
  /** Throws a `JevError` when there is no answer. */
  ask(request: JevRequest): Promise<JevResponse>;
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface ClientOptions {
  readonly key: string | undefined;
  readonly model?: string;
  readonly fetch?: Fetch;
  readonly timeoutMs?: number;
  readonly url?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isProbability = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
/** A token count, or null when it is not a non-negative integer. */
const count = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null);
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, 300);

const WIRE_TYPE = { "yes-no": "noul", choice: "choice" } as const;

function wireQuestions(questions: JevRequest["questions"]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(questions).map(([name, question]) => [name, { ...question, type: WIRE_TYPE[question.type] }]));
}

function unreadable(why: string, raw: unknown): JevAnswer {
  return { type: "unreadable", why, raw: oneLine(raw === undefined ? "(missing)" : JSON.stringify(raw) ?? "(missing)") };
}

function parseAnswers(raw: unknown, questions: JevRequest["questions"]): Record<string, JevAnswer> {
  const answers: Record<string, JevAnswer> = Object.create(null) as Record<string, JevAnswer>;
  for (const [name, question] of Object.entries(questions)) {
    const one = isRecord(raw) ? raw[name] : undefined;
    if (question.type === "yes-no") {
      if (!isRecord(one) || !isProbability(one.noul)) {
        answers[name] = unreadable(`Jev's answer to "${name}" is not a probability`, one);
        continue;
      }
      answers[name] = { type: "yes-no", yes: one.noul };
      continue;
    }
    const probabilities = isRecord(one) && isRecord(one.probabilities) ? one.probabilities : undefined;
    const choices = Object.keys(question.criteria);
    if (!isRecord(one) || probabilities === undefined || typeof one.choice !== "string" || !choices.every((choice) => isProbability(probabilities[choice]))) {
      answers[name] = unreadable(`Jev's answer to "${name}" is not a choice with probabilities`, one);
      continue;
    }
    answers[name] = {
      type: "choice",
      choice: one.choice,
      probabilities: Object.fromEntries(choices.map((choice) => [choice, probabilities[choice] as number])),
      confidence: isProbability(one.confidence) ? one.confidence : null,
    };
  }
  return answers;
}

/** The key, and anything that spells it (as is, URL-encoded or JSON-escaped), is never shown. */
function redact(text: string, key: string): string {
  let out = text;
  for (const form of new Set([key, encodeURIComponent(key), JSON.stringify(key).slice(1, -1)])) {
    if (form !== "") out = out.split(form).join("[redacted]");
  }
  return out;
}

function errorDetail(body: unknown): string {
  const detail = isRecord(body) ? body.detail : undefined;
  if (typeof detail === "string") return detail;
  if (isRecord(detail) && typeof detail.message === "string") return detail.message;
  return "request failed";
}

/** The real client. With no key every `ask` fails with kind "no-key" and nothing is sent. */
export function createJevClient(options: ClientOptions): JevClient {
  const { key, model = JEV_MODEL, timeoutMs = DEFAULT_TIMEOUT_MS, url = JEV_URL } = options;
  const send: Fetch = options.fetch ?? ((target, init) => fetch(target, init));
  return {
    model,
    async ask(request) {
      if (key === undefined || key === "") throw new JevError("no-key", "no TYPESAFE_API_KEY in the environment");
      let response;
      try {
        response = await send(url, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({ model, state: request.state, questions: wireQuestions(request.questions) }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const name = (error as Error).name;
        if (name === "TimeoutError" || name === "AbortError") throw new JevError("timeout", `Jev did not answer within ${Math.round(timeoutMs / 1000)}s`);
        throw new JevError("network", "Jev could not be reached");
      }
      const body: unknown = await response.json().catch(() => undefined);
      if (!response.ok) throw new JevError("http", oneLine(redact(`Jev ${response.status}: ${errorDetail(body)}`, key)), response.status);
      if (!isRecord(body)) throw new JevError("bad-response", "Jev's reply was not JSON");
      const usage = isRecord(body.usage) ? body.usage : {};
      const inputTokens = count(usage.input_tokens);
      const outputTokens = count(usage.output_tokens);
      return {
        answers: parseAnswers(body.answers, request.questions),
        usage: { inputTokens, outputTokens, usd: inputTokens === null ? null : jevCost(inputTokens) },
        model: typeof body.model === "string" ? body.model : model,
      };
    },
  };
}

/** A client that refuses every call, saying why. Judging is off unless the reviewer passes `--judge`. */
export function offClient(reason: string, model: string = JEV_MODEL): JevClient {
  return {
    model,
    ask() {
      return Promise.reject(new JevError("off", reason));
    },
  };
}

/** `--judge` and a key give the real client; anything else gives one that sends nothing. */
export function clientFor(judging: boolean, env: Readonly<Record<string, string | undefined>>, options: Omit<ClientOptions, "key"> = {}): JevClient {
  if (!judging) return offClient("judging is off: pass --judge to send source text to TypeSafe", options.model);
  return createJevClient({ ...options, key: env.TYPESAFE_API_KEY });
}

/** One check's outcome: answers and cost, or "not judged" with why. Never throws. */
export type Judged =
  | { readonly status: "judged"; readonly answers: Readonly<Record<string, JevAnswer>>; readonly usage: JevUsage; readonly model: string }
  | { readonly status: "not judged"; readonly reason: string; readonly kind: JevFailure };

export async function judge(client: JevClient, request: JevRequest): Promise<Judged> {
  try {
    const response = await client.ask(request);
    return { status: "judged", ...response };
  } catch (error) {
    if (error instanceof JevError) return { status: "not judged", reason: error.message, kind: error.kind };
    return { status: "not judged", reason: "the classifier failed", kind: "network" };
  }
}
