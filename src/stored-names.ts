import { createHash } from "node:crypto";
import { looksSecret } from "./prompt-safe.ts";

/*
 * Names as the setup store keeps them. Text shaped like a secret is never stored: a stable stand-in
 * is kept instead, so the same text is the same key on every run and nothing secret is on disk.
 */

/** `withheld:` and twelve hex digits of the text's hash. */
export const standIn = (text: string): string => `withheld:${createHash("sha256").update(text).digest("hex").slice(0, 12)}`;

/**
 * A path as it is stored: itself, or a stable stand-in when a part of it is shaped like a secret.
 * A stand-in starts with "/", which no path in a git tree can, so it is never the same key as a
 * file that is really named "withheld:...".
 */
export function storedPath(path: string): string {
  return path.split("/").some(looksSecret) ? `/${standIn(path)}` : path;
}

/** Text from the store as it is shown or printed: itself, or "withheld" when it is shaped like a secret (the file was edited, or a person typed one). */
export const shown = (text: string): string => (looksSecret(text) ? "withheld" : text);
