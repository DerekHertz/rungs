import { ROLE_ORDER } from "../city.ts";
import type { Role } from "../graph.ts";

export const BACKGROUND = "#10141a";

/** Reddish purple, the one Okabe-Ito hue no role uses: lines and posts that reach outside the code. */
export const EFFECT_COLOR = "#CC79A7";

// Okabe-Ito, so the picture stays readable with any colour vision. Colour means one thing here,
// a file's role.
const ROLE_COLORS: Readonly<Record<Role | "none", string>> = {
  source: "#56B4E9",
  tests: "#009E73",
  docs: "#F0E442",
  config: "#0072B2",
  generated: "#D55E00",
  none: "#c9ced6",
};

/** Every role the legend names, then "none" for a file the role table doesn't recognise. */
export const LEGEND_ROLES: readonly (Role | "none")[] = [...ROLE_ORDER, "none"];

export function roleColor(role: Role | null): string {
  return ROLE_COLORS[role ?? "none"];
}

/** `hex` with `amount` of it mixed into the background, as a hex colour. */
export function onBackground(hex: string, amount: number): string {
  const channels = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
  const back = [1, 3, 5].map((at) => Number.parseInt(BACKGROUND.slice(at, at + 2), 16));
  return `#${channels
    .map((channel, at) => Math.round(channel * amount + back[at]! * (1 - amount)).toString(16).padStart(2, "0"))
    .join("")}`;
}
