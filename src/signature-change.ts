/**
 * What changed in a function or method signature, read from the extractor's text
 * (`({ a, b = 1 }): void`, `async run(a, b = [])`), as one line per edit: parameters added or
 * removed, a default or a type changed, optional and required flipped, a parameter renamed in
 * place, the return type. Text this cannot read exactly (overloads, template literals, unbalanced
 * brackets, a rest parameter that is not last, a reshaped destructuring) gives null, and the caller
 * shows only the raw before and after: never a guess.
 */

const PAIRS: Readonly<Record<string, string>> = { ")": "(", "]": "[", "}": "{", ">": "<" };

/**
 * Walks `text` calling `visit(char, index, depth)` outside quotes. False when the text cannot be split
 * exactly: unbalanced or mismatched brackets, a template literal, a regex literal or division (`/`),
 * or a `<` or `>` that is not a type bracket or an arrow.
 */
function walk(text: string, visit: (char: string, index: number, depth: number) => boolean | void): boolean {
  const stack: string[] = [];
  let quote = "";
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (quote !== "") {
      if (c === "\\") i += 1;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === "`" || c === "/") return false;
    if (c === '"' || c === "'") quote = c;
    else if (c === ">" && text[i - 1] === "=") continue;
    else if ("([{".includes(c) || c === "<") {
      if (c === "<" && !/[\w$>\]]/.test(text[i - 1] ?? "")) return false;
      if (visit(c, i, stack.length) === true) return true;
      stack.push(c);
    } else if (c in PAIRS) {
      if (stack.pop() !== PAIRS[c]) return false;
      if (visit(c, i, stack.length) === true) return true;
    } else if (visit(c, i, stack.length) === true) return true;
  }
  return stack.length === 0 && quote === "";
}

/** Splits at top-level `separator`; undefined when the text does not balance. */
function splitTop(text: string, separator: string): string[] | undefined {
  const cuts: number[] = [];
  const ok = walk(text, (c, i, depth) => {
    if (c === separator && depth === 0) cuts.push(i);
  });
  if (!ok) return undefined;
  const parts: string[] = [];
  let start = 0;
  for (const cut of cuts) {
    parts.push(text.slice(start, cut).trim());
    start = cut + 1;
  }
  parts.push(text.slice(start).trim());
  return parts;
}

/** The index of the first top-level `char` (an `=` that is not part of `=>` or `==`), or -1. */
function firstTop(text: string, char: string): number {
  let found = -1;
  walk(text, (c, i, depth) => {
    if (c !== char || depth !== 0 || (char === "=" && (text[i + 1] === ">" || text[i + 1] === "="))) return;
    found = i;
    return true;
  });
  return found;
}

/** The index of the bracket closing the one at `open`, or -1. */
function closing(text: string, open: number): number {
  let found = -1;
  const base = text.slice(open);
  walk(base, (c, i, depth) => {
    if (c in PAIRS && depth === 0) {
      found = open + i;
      return true;
    }
  });
  return found;
}

interface Param {
  readonly raw: string;
  readonly name: string;
  readonly rest: boolean;
  readonly optional: boolean;
  readonly type: string;
  readonly def: string | undefined;
}

/** True for an untyped rest or a plain array type (`T[]`, `readonly T[]`, `Array<T>`): the only rests that may be left out. */
function plainArray(type: string): boolean {
  if (type === "") return true;
  if (/^(keyof|typeof|unique|infer|asserts)\b/.test(type) || firstTop(type, "=") !== -1) return false;
  if (splitTop(type, "|")?.length !== 1 || splitTop(type, "&")?.length !== 1) return false;
  return /\[\]$/.test(type) || /^(Readonly)?Array<.*>$/.test(type);
}

function param(raw: string): Param | undefined {
  const rest = raw.startsWith("...");
  let text = rest ? raw.slice(3).trim() : raw;
  let def: string | undefined;
  const eq = firstTop(text, "=");
  if (eq !== -1) {
    def = text.slice(eq + 1).trim();
    text = text.slice(0, eq).trim();
    if (def === "") return undefined;
  }
  let type = "";
  const isPattern = text.startsWith("{") || text.startsWith("[");
  const patternEnd = isPattern ? closing(text, 0) + 1 : 0;
  if (isPattern && patternEnd === 0) return undefined;
  const colon = firstTop(text.slice(patternEnd), ":");
  if (colon !== -1) {
    type = text.slice(patternEnd + colon + 1).trim();
    text = text.slice(0, patternEnd + colon).trim();
  }
  if (rest && !plainArray(type)) return undefined;
  const marked = text.endsWith("?");
  const name = marked ? text.slice(0, -1).trim() : text;
  if (name === "" || (/\s/.test(name) && !name.startsWith("{") && !name.startsWith("["))) return undefined;
  return { raw, name, rest, optional: marked || rest || def !== undefined, type, def };
}

interface Shape {
  readonly prefix: string;
  readonly params: readonly string[];
  readonly returns: string;
}

function shape(text: string): Shape | undefined {
  if (!walk(text, () => {})) return undefined;
  const whole = splitTop(text, ";");
  if (whole === undefined || whole.filter((part) => part !== "").length !== 1) return undefined;
  const source = whole.find((part) => part !== "")!;
  let open = -1;
  walk(source, (c, i, depth) => {
    if (c !== "(" || depth !== 0) return;
    open = i;
    return true;
  });
  if (open === -1) return undefined;
  const prefix = source.slice(0, open).trim();
  const end = closing(source, open);
  if (end === -1) return undefined;
  const inside = source.slice(open + 1, end).trim();
  const params = inside === "" ? [] : splitTop(inside, ",");
  if (params === undefined) return undefined;
  if (params.length > 0 && params[params.length - 1] === "") params.pop();
  const tail = source.slice(end + 1).trim();
  if (tail !== "" && !tail.startsWith(":")) return undefined;
  return { prefix, params, returns: tail.slice(1).trim() };
}

const plural = (n: number, word: string): string => (n === 1 ? word : `${word}s`);

function parseAll(raws: readonly string[]): Param[] | undefined {
  const params: Param[] = [];
  for (const raw of raws) {
    const read = raw === "" ? undefined : param(raw);
    if (read === undefined) return undefined;
    params.push(read);
  }
  const rests = params.filter((p) => p.rest).length;
  if (rests > 1 || (rests === 1 && !params[params.length - 1]!.rest)) return undefined;
  return params;
}

/** The inside of a sole `{ ... }` parameter, with whatever follows its closing brace (`: Type`, ` = {}`). */
function pattern(raws: readonly string[]): { inner: string; after: string } | undefined {
  const only = raws[0];
  if (raws.length !== 1 || only === undefined || !only.startsWith("{")) return undefined;
  const end = closing(only, 0);
  if (end === -1) return undefined;
  return { inner: only.slice(1, end).trim(), after: only.slice(end + 1).trim() };
}

const shown = (text: string): string => (text === "" ? "(none)" : text);

/** Parameter edits as lines: `inPattern` is true for the members of a destructured parameter. */
function paramLines(was: readonly Param[], now: readonly Param[], inPattern: boolean): string[] | undefined {
  const names = (list: readonly Param[]): string[] => list.map((p) => p.name);
  if (new Set(names(was)).size !== was.length || new Set(names(now)).size !== now.length) return undefined;
  const wasBy = new Map(was.map((p) => [p.name, p]));
  const nowBy = new Map(now.map((p) => [p.name, p]));
  const keptWas = was.filter((p) => nowBy.has(p.name));
  const keptNow = now.filter((p) => wasBy.has(p.name));
  if (names(keptWas).join("\0") !== names(keptNow).join("\0")) return undefined;
  // A pattern member with a local name (`a: b`) has a rename in its type slot; a change there is not read.
  if (inPattern && keptNow.some((p) => p.type !== wasBy.get(p.name)!.type)) return undefined;
  if (keptNow.some((p) => p.rest !== wasBy.get(p.name)!.rest)) return undefined;
  let gone = was.map((p, i) => ({ p, i })).filter(({ p }) => !nowBy.has(p.name));
  let fresh = now.map((p, i) => ({ p, i })).filter(({ p }) => !wasBy.has(p.name));
  // Only plain identifiers are read as added, removed or renamed; any other pattern change is not modelled.
  if ([...gone, ...fresh].some(({ p }) => !/^[A-Za-z_$][\w$]*$/.test(p.name))) return undefined;
  const renamed: string[] = [];
  if (!inPattern) {
    for (const old of gone) {
      const twin = fresh.find((c) => c.i === old.i && c.p.type === old.p.type && c.p.def === old.p.def && c.p.optional === old.p.optional && c.p.rest === old.p.rest);
      if (twin === undefined) continue;
      renamed.push(`${old.p.name} → ${twin.p.name}`);
      gone = gone.filter((x) => x !== old);
      fresh = fresh.filter((x) => x !== twin);
    }
  }
  const lines: string[] = [];
  const optional = fresh.map((x) => x.p).filter((p) => p.optional);
  const required = fresh.map((x) => x.p).filter((p) => !p.optional);
  if (optional.length > 0) lines.push(`Added optional ${plural(optional.length, "parameter")}: ${optional.map((p) => p.raw).join(", ")}`);
  if (required.length > 0) lines.push(`Added required ${plural(required.length, "parameter")}: ${required.map((p) => p.raw).join(", ")}`);
  if (gone.length > 0) lines.push(`Removed ${plural(gone.length, "parameter")}: ${gone.map((x) => x.p.raw).join(", ")}`);
  if (renamed.length > 0) lines.push(`Renamed ${plural(renamed.length, "parameter")}: ${renamed.join(", ")}`);
  for (const p of keptNow) {
    const q = wasBy.get(p.name)!;
    if (p.def !== q.def) {
      const line = q.def === undefined ? `Default added: ${p.name} = ${p.def}` : p.def === undefined ? `Default removed: ${p.name} (was ${q.def})` : `Default changed: ${p.name} = ${q.def} → ${p.def}`;
      lines.push(line + (q.optional && !p.optional ? ", now required" : ""));
    } else if (p.optional !== q.optional) lines.push(`${p.name} is now ${p.optional ? "optional" : "required"}`);
    if (p.type !== q.type) lines.push(`Type of ${p.name}: ${shown(q.type)} → ${shown(p.type)}`);
  }
  return lines;
}

/**
 * One line per edit between two function signatures, or null when there is none to report or the
 * text cannot be read exactly: any doubt gives null.
 */
export function signatureSummary(before: string, after: string): string[] | null {
  const from = shape(before.trim());
  const to = shape(after.trim());
  if (from === undefined || to === undefined || from.prefix !== to.prefix) return null;
  const lines: string[] = [];
  const wasPattern = pattern(from.params);
  const nowPattern = pattern(to.params);
  if (wasPattern !== undefined || nowPattern !== undefined) {
    if (wasPattern === undefined || nowPattern === undefined || wasPattern.after !== nowPattern.after) return null;
    const inner = (text: string): Param[] | undefined => {
      const items = text === "" ? [] : splitTop(text, ",");
      if (items === undefined) return undefined;
      if (items.length > 0 && items[items.length - 1] === "") items.pop();
      return parseAll(items);
    };
    const was = inner(wasPattern.inner);
    const now = inner(nowPattern.inner);
    if (was === undefined || now === undefined) return null;
    const found = paramLines(was, now, true);
    if (found === undefined) return null;
    lines.push(...found);
  } else {
    const was = parseAll(from.params);
    const now = parseAll(to.params);
    if (was === undefined || now === undefined) return null;
    const found = paramLines(was, now, false);
    if (found === undefined) return null;
    lines.push(...found);
  }
  if (from.returns !== to.returns) lines.push(`Return type changed: ${from.returns === "" ? "(inferred)" : from.returns} → ${to.returns === "" ? "(inferred)" : to.returns}`);
  return lines.length === 0 ? null : lines;
}
