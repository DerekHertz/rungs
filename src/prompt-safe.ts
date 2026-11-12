import { RESOURCE_ORDER, isCodeNode } from "./graph.ts";
import type { ModuleNode, NodeId, ResourceKind } from "./graph.ts";

// Page-safe: the walkthrough and source panels bundle modules that import this one, so nothing here may import node:*.
//
// The rule for every agent prompt: the agent sees names, never source text. What reaches a prompt
// from the code is a name, a path or an effect; this module is where each is made prompt-safe.
// The page itself keeps showing the full targets to the local user; only prompts change.

/** What a withheld target is shown as. */
export const WITHHELD = "withheld";

/** The longest id (kind, path and name) a prompt shows; a longer one is cut in the middle. */
export const MAX_ID_CHARS = 120;
/** The longest effect target a prompt shows (a host, a command name or a file name). */
export const MAX_TARGET_CHARS = 60;

/** `text` cut to `max` characters, keeping its start and its end (a path's file name, a name's last segment), with "…" where it was cut. */
export function cap(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.ceil((max - 1) / 3);
  return `${text.slice(0, head)}…${text.slice(text.length - (max - 1 - head))}`;
}

/** Prefixes of well-known secret formats. A tail of at least 8 more characters makes it a match, so "sk-learn" is not one. */
const KNOWN_PREFIX = /(?:sk-|sk_live_|sk_test_|pk_live_|rk_live_|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-|xox[abprs]-|xapp-|npm_|ya29\.|AIza|SG\.|eyJ)[A-Za-z0-9_.\-=]{8,}/;
const AWS_KEY = /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{12,}/;

/** Shannon entropy of `text`, in bits per character. */
function entropy(text: string): number {
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / text.length) * Math.log2(n / text.length);
  return bits;
}

/**
 * Whether `text` has the shape of a secret: a known key prefix (sk-, ghp_, AKIA, xox...), a
 * long hex run, or a long mixed-class token of high entropy. A heuristic: it errs toward withholding.
 */
export function looksSecret(text: string): boolean {
  if (KNOWN_PREFIX.test(text) || AWS_KEY.test(text)) return true;
  for (const token of text.split(/[^A-Za-z0-9+/_=-]+/)) {
    if (token.length >= 32 && /^[0-9a-fA-F]+$/.test(token)) return true;
    if (token.length >= 20 && /[a-z]/.test(token) && /[A-Z0-9]/.test(token) && /[0-9]/.test(token) && entropy(token) >= 3.5) return true;
  }
  return false;
}

/** Characters a shown target may have: words, dots, colons, slashes, "@", "+", "-". No spaces, quotes or other prose. */
const PLAIN = /^[\w.@:+/-]+$/;

/** The last part of a path, whatever the separator. */
const lastPart = (text: string): string => text.slice(Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\")) + 1);

/** A URL's scheme and host (with its port), dropping user info, path, query and fragment; undefined when `literal` is no URL. */
function hostOf(literal: string): string | undefined {
  const text = literal.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : /^[\w-]+(?:\.[\w-]+)+(?::\d+)?(?:[/?#]|$)/.test(text) ? `https://${text}` : undefined;
  if (withScheme === undefined) return /^[a-z][a-z0-9+.-]*:/i.test(text) ? `${text.slice(0, text.indexOf(":"))}:` : undefined;
  try {
    const url = new URL(withScheme);
    return url.host === "" ? url.protocol : `${url.protocol}//${url.host}`;
  } catch {
    return undefined;
  }
}

/**
 * What an agent is shown of an effect's literal target. Never the literal itself:
 * - network: the scheme and host (`https://api.example`); path, query, fragment and user info are dropped. A relative URL is "a relative path".
 * - process: the command's name only (`git` for "/usr/bin/git rev-parse --short HEAD"); its arguments are dropped.
 * - file system: the bare file name; "a path" when there is none.
 * - any other resource: the host when it is a URL, else the literal if it is a plain name.
 * A target that has a secret's shape anywhere in it, or does not come out as a plain, short name, is WITHHELD.
 */
export function promptTarget(resource: ResourceKind | undefined, literal: string): string {
  if (looksSecret(literal)) return WITHHELD;
  let shown: string | undefined;
  if (resource === "network") {
    shown = literal.trim().startsWith("/") || literal.trim().startsWith("./") ? "a relative path" : hostOf(literal);
  } else if (resource === "process") {
    shown = lastPart(literal.trim().split(/\s+/)[0] ?? "");
  } else if (resource === "file system") {
    shown = lastPart(literal.trim().replace(/[/\\]+$/, "")) || "a path";
  } else {
    shown = hostOf(literal) ?? literal.trim();
  }
  if (shown === undefined) return WITHHELD;
  if (shown === "a path" || shown === "a relative path") return shown;
  if (shown === "" || !PLAIN.test(shown) || looksSecret(shown)) return WITHHELD;
  return cap(shown, MAX_TARGET_CHARS);
}

/**
 * An effect label (see effectLabel) as a prompt shows it: its literal target replaced by
 * `promptTarget`, unquoted. A label with no literal is unchanged.
 */
export function promptEffect(label: string): string {
  const resource = RESOURCE_ORDER.find((kind) => label.startsWith(`${kind} `));
  const at = label.search(/ "/);
  if (at === -1 || !label.endsWith('"')) return label;
  return `${label.slice(0, at)} ${promptTarget(resource, label.slice(at + 2, -1))}`;
}

/**
 * A qualified name (see qualifiedName in graph.ts) with each computed member name replaced by
 * "[…]": `C.["SECRET"]` is written in the name as the JSON string `"[\"SECRET\"]"`. A segment is
 * an identifier or a JSON string, then "@" and an ordinal when above 1; "." separates segments.
 * The ordinal is kept. Names that need no alias come back unchanged.
 */
export function promptName(qualified: string): string {
  const out: string[] = [];
  let at = 0;
  while (at < qualified.length) {
    let end = at;
    let head: string;
    if (qualified[at] === '"') {
      end = at + 1;
      while (end < qualified.length && qualified[end] !== '"') end += qualified[end] === "\\" ? 2 : 1;
      end = Math.min(end + 1, qualified.length);
      const raw = qualified.slice(at, end);
      let text: string;
      try {
        text = JSON.parse(raw) as string;
      } catch {
        text = raw;
      }
      const bracket = text.indexOf("[");
      head = bracket === -1 ? raw : `${text.slice(0, bracket)}[…]`;
    } else {
      while (end < qualified.length && qualified[end] !== "." && qualified[end] !== "@") end++;
      head = qualified.slice(at, end);
    }
    let after = end;
    if (qualified[after] === "@") {
      after++;
      while (after < qualified.length && qualified[after]! >= "0" && qualified[after]! <= "9") after++;
    }
    out.push(head + qualified.slice(end, after));
    at = qualified[after] === "." ? after + 1 : after;
  }
  return out.join(".");
}

/** A node as far as its prompt id goes: its id, and for code its qualified name (the id ends with it). */
export interface Nameable {
  readonly id: NodeId;
  readonly qualifiedName?: string;
}

/** A graph node as a Nameable: code nodes carry their qualified name. */
export const nameable = (node: ModuleNode): Nameable => (isCodeNode(node) ? { id: node.id, qualifiedName: node.qualifiedName } : { id: node.id });

/** The id a prompt shows for `node` before two of them are told apart: computed member names replaced, long ids cut. */
export function promptBase(node: Nameable): string {
  const name = node.qualifiedName;
  const prefix = name === undefined || name === "" || !node.id.endsWith(name) ? undefined : node.id.slice(0, node.id.length - name.length);
  return cap(prefix === undefined ? node.id : prefix + promptName(name!), MAX_ID_CHARS);
}

/**
 * The ids a prompt shows and the way back. `add` gives a node its prompt id: its alias, and where
 * two nodes would show the same one, "#2", "#3" in the order added (`C.[…]`, `C.[…]#2`). An alias
 * has no other node's id: a name that is not an identifier is JSON-quoted in a real id, an alias
 * is not. `back` takes an id from an agent's answer to the real id, or undefined when the prompt
 * never showed it; the real id of a computed member is not accepted, so it cannot be guessed.
 */
export class PromptIds {
  readonly #byAlias = new Map<string, NodeId>();
  readonly #byId = new Map<NodeId, string>();

  add(node: Nameable): string {
    const known = this.#byId.get(node.id);
    if (known !== undefined) return known;
    const base = promptBase(node);
    let alias = base;
    for (let n = 2; this.#byAlias.has(alias); n++) alias = `${base}#${n}`;
    this.#byAlias.set(alias, node.id);
    this.#byId.set(node.id, alias);
    return alias;
  }

  /** The prompt id of a node already added, else of its id alone. */
  of(id: NodeId): string {
    return this.#byId.get(id) ?? promptBase({ id });
  }

  back(promptId: string): NodeId | undefined {
    return this.#byAlias.get(promptId);
  }
}
