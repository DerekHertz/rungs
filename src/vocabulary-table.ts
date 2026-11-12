/**
 * The written rules the vocabulary collector follows, as fixed tables. They are the same for every
 * repository and name no repository. Change a list, a limit, or the way words are split or merged
 * (see vocabulary.ts: `wordsOf`, `stem`) and raise VOCABULARY_TABLE_VERSION, so a stored
 * vocabulary says which rules built it.
 */
export const VOCABULARY_TABLE_VERSION = 3;

/** A phrase of more words than this is a sentence, not a term: it is skipped and counted. */
export const MAX_PHRASE_WORDS = 5;
/** A word longer than this is not a word (a hash, an encoded blob): its phrase is skipped and counted. */
export const MAX_WORD_CHARS = 40;
/** A term whose key is shorter than this is dropped as too short to mean anything ("a", "id", "x"). */
export const MIN_KEY_CHARS = 3;

/**
 * Words that most of a repository would match, so a term made only of them says nothing about
 * what a module is for. Each is in the singular form `singular` gives: a test checks this.
 */
export const GENERIC_WORDS: readonly string[] = [
  // Where code sits
  "util", "utility", "helper", "common", "core", "lib", "src", "source", "main", "index", "misc", "miscellaneous", "shared", "base",
  "internal", "public", "private", "default", "app", "application", "module", "package", "folder", "project", "repo", "repository",
  // Build output and scaffolding
  "dist", "build", "out", "bin", "script", "tmp", "temp", "test", "spec", "fixture", "mock", "stub", "example", "sample",
  // What every piece of code is made of
  "code", "type", "thing", "stuff", "function", "class", "method", "constant",
  // Sections nearly every README or doc has
  "readme", "license", "licence", "install", "installation", "usage", "overview", "introduction", "intro", "contributing", "contribution",
  "changelog", "faq", "todo", "note", "summary", "background", "doc", "documentation",
];

/**
 * Extensions of files that hold no code a name could be taken from: media, fonts, archives and
 * data. A binary file with any other name might have been code, so it is listed as unread; a text
 * file with no language adapter and any other name is counted as not analysed.
 */
export const NON_CODE_EXTENSIONS: readonly string[] = [
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".ico", ".svg", ".pdf", ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".zip", ".gz", ".tgz", ".tar", ".7z", ".mp3", ".mp4", ".mov", ".wav", ".ogg", ".webm", ".wasm", ".map",
  ".json", ".txt", ".snap", ".csv", ".lock", ".log", ".yml", ".yaml", ".toml", ".ini",
];

/** File names (lower case) that are plain repository files, not code in a language no adapter reads: they are not counted as not analysed. */
export const NON_CODE_NAMES: readonly string[] = [".gitignore", ".gitattributes", ".npmrc", ".nvmrc", ".editorconfig", "license", "licence", "notice", "codeowners"];

/** Whole phrases (as a term key) that are boilerplate though their words are not generic alone. */
export const GENERIC_PHRASES: readonly string[] = ["getting started", "table of content", "quick start"];

/**
 * Words that end a chunk when prose (a package description) is cut into terms, and that are not
 * part of a name when they begin or end it ("the sandbox", "folderOf").
 */
export const STOP_WORDS: readonly string[] = [
  "a", "an", "the", "and", "or", "but", "of", "to", "in", "on", "at", "by", "for", "with", "from", "into", "onto", "over", "under", "as",
  "is", "are", "was", "were", "be", "been", "being", "it", "its", "this", "that", "these", "those", "your", "our", "their", "you", "we", "they",
  "i", "so", "than", "then", "too", "very", "can", "could", "will", "would", "should", "may", "might", "must", "has", "have", "had",
  "do", "does", "did", "via", "per", "up", "down", "off", "about", "between", "through", "while", "when", "where", "which", "who", "what", "how",
  "why", "all", "any", "each", "every", "some", "such", "also", "just", "only", "more", "most", "other", "if", "else", "yet", "now", "here", "there",
];

