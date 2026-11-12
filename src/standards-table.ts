/**
 * Where a repository writes its rules, as a fixed table. It is the same for every repository and
 * names no repository: a path pattern, and for a file that mixes rules with other prose (a README)
 * the headings that hold them. Change an entry or add one and raise STANDARDS_TABLE_VERSION, so a
 * stored answer says which table found its rules.
 */
export const STANDARDS_TABLE_VERSION = 1;

export type RuleKind = "agent instructions" | "contributing" | "style guide" | "readme";

export interface StandardsEntry {
  readonly kind: RuleKind;
  /** Matched against a file's path in the base, from the repository root, with "/" separators. */
  readonly path: RegExp;
  /**
   * Without it every section of a matching file is a rule. With it, only a section whose own
   * heading, or an enclosing heading, matches: the rest of the file is not about rules.
   */
  readonly headings?: RegExp;
}

/** Where the common conventions put a file: the root, `.github/` or `docs/`. */
const HOME = String.raw`^(?:(?:\.github|docs)/)?`;

export const STANDARDS_TABLE: readonly StandardsEntry[] = [
  // An agent's instructions apply to the folder they sit in, so a nested one is a rule file too.
  { kind: "agent instructions", path: /(?:^|\/)(?:agents|claude)\.md$/i },
  { kind: "agent instructions", path: /^\.claude\/rules\/.+\.md$/i },
  { kind: "agent instructions", path: /^\.github\/(?:copilot-instructions\.md|instructions\/.+\.md)$/i },
  { kind: "contributing", path: new RegExp(`${HOME}contributing\\.md$`, "i") },
  { kind: "style guide", path: new RegExp(`${HOME}(?:style[-_ ]?guide|code[-_ ]style|coding[-_ ](?:standards|style|guidelines|conventions)|conventions)\\.md$`, "i") },
  { kind: "style guide", path: /^docs\/(?:style|styles|standards)\/.+\.md$/i },
  { kind: "readme", path: new RegExp(`${HOME}readme\\.md$`, "i"), headings: /^(?:contribut\w*|code style|coding (?:standards|style|guidelines|conventions)|conventions|style guide)$/i },
];
