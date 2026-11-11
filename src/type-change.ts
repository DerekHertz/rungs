/**
 * What changed in an exported interface or type alias, read from the extractor's normalised
 * signature text (`{ a: string; b(x: 1): void }`, `extends A { ... }`, `<T> { ... }`, `= | "a" | "b"`),
 * as one line per added, removed or changed part. Text this cannot read apart gives null, and the
 * caller shows the whole before and after instead: never a guess.
 */

const OPEN = "([{";
const CLOSE = ")]}";

/** Walks `text` calling `visit(char, index)` at depth 0 only (an opening bracket counts), outside brackets, angle brackets and strings. Returns false when brackets do not balance. */
function atTop(text: string, visit: (char: string, index: number) => void): boolean {
  let depth = 0;
  let quote = "";
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (quote !== "") {
      if (c === "\\") i += 1;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (OPEN.includes(c) || c === "<") {
      if (depth === 0) visit(c, i);
      depth += 1;
    } else if (CLOSE.includes(c) || (c === ">" && text[i - 1] !== "=")) {
      depth -= 1;
      if (depth < 0) return false;
    } else if (depth === 0) visit(c, i);
  }
  return depth === 0 && quote === "";
}

/** Splits at `separator` outside brackets; undefined when the text does not balance. */
function split(text: string, separator: string): string[] | undefined {
  const cuts: number[] = [];
  const ok = atTop(text, (c, i) => {
    if (c !== separator) return;
    if ((separator === "|" || separator === "&") && (text[i - 1] === separator || text[i + 1] === separator)) return;
    cuts.push(i);
  });
  if (!ok) return undefined;
  const parts: string[] = [];
  let start = 0;
  for (const cut of cuts) {
    parts.push(text.slice(start, cut));
    start = cut + 1;
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}

/** The index of the first top-level `char`, or -1. */
function firstTop(text: string, char: string): number {
  let found = -1;
  atTop(text, (c, i) => {
    if (c === char && found === -1) found = i;
  });
  return found;
}

/** The index just after the bracket that closes the one at `open`, or -1. */
function after(text: string, open: number): number {
  let depth = 0;
  let quote = "";
  for (let i = open; i < text.length; i += 1) {
    const c = text[i]!;
    if (quote !== "") {
      if (c === "\\") i += 1;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (OPEN.includes(c) || c === "<") depth += 1;
    else if (CLOSE.includes(c) || (c === ">" && text[i - 1] !== "=")) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** The members of text that is exactly one `{ ... }`, or undefined. */
function objectMembers(text: string): string[] | undefined {
  if (!text.startsWith("{") || after(text, 0) !== text.length) return undefined;
  return split(text.slice(1, -1), ";");
}

interface Member {
  readonly key: string;
  readonly text: string;
  readonly head: string;
  readonly kind: "property" | "method" | "other";
  readonly type: string;
}

const KEY = /^(readonly\s+)?(\[[^\]]*\]|"[^"]*"|'[^']*'|[^\s:?(<]+)(\?)?(?=\s*[:(<]|$)/;

function member(text: string): Member {
  const found = KEY.exec(text);
  if (found === null) return { key: text, text, head: text, kind: "other", type: "" };
  const rest = text.slice(found[0].length).trim();
  const head = text.slice(0, found[0].length);
  if (rest.startsWith(":")) return { key: found[2]!, text, head, kind: "property", type: rest.slice(1).trim() };
  if (rest.startsWith("(")) return { key: found[2]!, text, head, kind: "method", type: rest };
  return { key: found[2]!, text, head, kind: "other", type: rest };
}

function keyed(texts: readonly string[]): Map<string, Member> | undefined {
  const by = new Map<string, Member>();
  for (const text of texts) {
    const read = member(text);
    if (by.has(read.key)) return undefined;
    by.set(read.key, read);
  }
  return by;
}

/** A parameter list and return type of `(a: 1, b?: 2): R`. */
function callParts(type: string): { params: string[]; returns: string } | undefined {
  const end = after(type, 0);
  if (end === -1) return undefined;
  const params = split(type.slice(1, end - 1), ",");
  if (params === undefined) return undefined;
  const returns = type.slice(end).replace(/^\s*:\s*/, "").trim();
  return { params, returns };
}

const paramParts = (param: string): { name: string; type: string } | undefined => {
  const colon = firstTop(param, ":");
  if (colon <= 0 || /^[{[]/.test(param)) return undefined;
  return { name: param.slice(0, colon).trim(), type: param.slice(colon + 1).trim() };
};
const paramKey = (name: string): string => name.replace(/^\.\.\./, "").replace(/\?$/, "");

/** Lines for a method of the same name on both sides, or undefined when the parameters cannot be paired. */
function methodLines(name: string, before: string, now: string): string[] | undefined {
  const was = callParts(before);
  const is = callParts(now);
  if (was === undefined || is === undefined) return undefined;
  const read = (params: readonly string[]): Map<string, { name: string; type: string; text: string }> | undefined => {
    const by = new Map<string, { name: string; type: string; text: string }>();
    for (const text of params) {
      const parsed = paramParts(text);
      if (parsed === undefined || by.has(paramKey(parsed.name))) return undefined;
      by.set(paramKey(parsed.name), { ...parsed, text });
    }
    return by;
  };
  const from = read(was.params);
  const to = read(is.params);
  if (from === undefined || to === undefined) return undefined;
  const common = (a: ReadonlyMap<string, unknown>, b: ReadonlyMap<string, unknown>): string => [...a.keys()].filter((key) => b.has(key)).join("\0");
  if (common(from, to) !== common(to, from)) return undefined;
  const lines: string[] = [];
  for (const [key, param] of to) {
    const old = from.get(key);
    if (old === undefined || old.text === param.text) continue;
    if (old.name !== param.name) lines.push(`~ ${name}: ${old.text} → ${param.text}`);
    else lines.push(`~ ${name}(${param.name}): ${old.type} → ${param.type}`);
  }
  for (const [key, param] of to) if (!from.has(key)) lines.push(`+ ${name}(${param.text})`);
  for (const [key, param] of from) if (!to.has(key)) lines.push(`− ${name}(${param.text})`);
  if (was.returns !== is.returns) lines.push(`~ ${name} returns: ${was.returns || "(none)"} → ${is.returns || "(none)"}`);
  return lines;
}

/** The change between two member lists, as lines under `path`, or undefined when a name repeats. */
function memberLines(before: readonly string[], now: readonly string[], path: string): string[] | undefined {
  const was = keyed(before);
  const is = keyed(now);
  if (was === undefined || is === undefined) return undefined;
  const lines: string[] = [];
  for (const [key, read] of is) {
    const old = was.get(key);
    if (old === undefined || old.text === read.text) continue;
    const name = path + key;
    if (old.kind === "property" && read.kind === "property" && old.head === read.head) {
      const inner = objectMembers(old.type);
      const innerNow = objectMembers(read.type);
      if (inner !== undefined && innerNow !== undefined) {
        const nested = memberLines(inner, innerNow, `${name}.`);
        if (nested !== undefined) {
          lines.push(...nested);
          continue;
        }
      }
      lines.push(`~ ${name}: ${old.type} → ${read.type}`);
    } else if (old.kind === "method" && read.kind === "method" && old.head === read.head) {
      lines.push(...(methodLines(name, old.type, read.type) ?? [`~ ${path}${old.text} → ${read.text}`]));
    } else lines.push(`~ ${path}${old.text} → ${read.text}`);
  }
  for (const [key, read] of is) if (!was.has(key)) lines.push(`+ ${path}${read.text}`);
  for (const [key, read] of was) if (!is.has(key)) lines.push(`− ${path}${read.text}`);
  return lines;
}

interface Shape {
  readonly generics: string;
  /** "interface": `heritage` and `members`. "alias": the `body`. */
  readonly kind: "interface" | "alias";
  readonly heritage: readonly string[];
  readonly body: string;
}

function shapeOf(text: string): Shape | undefined {
  let rest = text.trim();
  let generics = "";
  if (rest.startsWith("<")) {
    const end = after(rest, 0);
    if (end === -1) return undefined;
    generics = rest.slice(0, end);
    rest = rest.slice(end).trim();
  }
  if (rest.startsWith("=")) return { generics, kind: "alias", heritage: [], body: rest.slice(1).trim() };
  const open = firstTop(rest, "{");
  if (open === -1) return undefined;
  const clauses = rest.slice(0, open).trim();
  if (clauses !== "" && !clauses.startsWith("extends ")) return undefined;
  const heritage: string[] = [];
  for (const clause of clauses === "" ? [] : clauses.split(/(?:^|\s)extends\s+/).filter((part) => part.trim() !== "")) {
    const items = split(clause, ",");
    if (items === undefined) return undefined;
    heritage.push(...items);
  }
  return { generics, kind: "interface", heritage, body: rest.slice(open).trim() };
}

const withoutLead = (body: string): string => body.replace(/^[|&]\s*/, "");

function listChange(before: readonly string[], now: readonly string[], mark: string): string[] {
  return [...now.filter((item) => !before.includes(item)).map((item) => `+ ${mark}${item}`), ...before.filter((item) => !now.includes(item)).map((item) => `− ${mark}${item}`)];
}

/**
 * One line per change between two exported type signatures: "+ member", "− member",
 * "~ name: old → new" (nested object literals as `a.b`), "+ extends X", "~ generics: ...", and
 * for a type alias "+ arm" or "− arm" per union arm. Null when the text cannot be read apart.
 */
export function typeChange(before: string, after: string): string[] | null {
  const from = shapeOf(before);
  const to = shapeOf(after);
  if (from === undefined || to === undefined || from.kind !== to.kind) return null;
  const lines: string[] = [];
  if (from.generics !== to.generics) lines.push(`~ generics: ${from.generics || "(none)"} → ${to.generics || "(none)"}`);
  lines.push(...listChange(from.heritage, to.heritage, "extends "));
  if (from.kind === "interface") {
    const was = objectMembers(from.body);
    const is = objectMembers(to.body);
    if (was === undefined || is === undefined) return null;
    const found = memberLines(was, is, "");
    return found === undefined ? null : [...lines, ...found];
  }
  const was = withoutLead(from.body);
  const is = withoutLead(to.body);
  const wasObject = objectMembers(was);
  const isObject = objectMembers(is);
  if (wasObject !== undefined && isObject !== undefined) {
    const found = memberLines(wasObject, isObject, "");
    return found === undefined ? null : [...lines, ...found];
  }
  const wasArms = split(was, "|");
  const isArms = split(is, "|");
  if (wasArms === undefined || isArms === undefined || wasArms.length === 0 || isArms.length === 0) return null;
  // A lone object literal turning into something else is a new shape, unless it stays one of the arms.
  if ((wasObject !== undefined && !isArms.includes(was)) || (isObject !== undefined && !wasArms.includes(is))) return null;
  if (wasArms.length === 1 && isArms.length === 1) {
    const wasParts = split(wasArms[0]!, "&");
    const isParts = split(isArms[0]!, "&");
    if (wasParts === undefined || isParts === undefined || wasParts.length < 2 || isParts.length < 2) return null;
    return [...lines, ...listChange(wasParts, isParts, "& ")];
  }
  return [...lines, ...listChange(wasArms, isArms, "")];
}

/** A row shows this many member lines; the rest wait behind "+N more". */
export const MEMBER_CAP = 4;

/** The lines as a short tally for a row's one-line summary: "+1 −1 ~2". */
export function memberTally(lines: readonly string[]): string {
  const count = (mark: string): number => lines.filter((line) => line.startsWith(mark)).length;
  return [["+", count("+ ")], ["−", count("− ")], ["~", count("~ ")]].filter(([, n]) => n !== 0).map(([mark, n]) => `${mark}${n}`).join(" ");
}
