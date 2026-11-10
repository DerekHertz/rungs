import { PLATE_HEIGHT } from "./city.ts";
import type { City, District } from "./city.ts";
import type { NodeId } from "./graph.ts";
import { trail } from "./zoom.ts";
import type { Tree } from "./zoom.ts";

/** Names float over the districts this many levels below the focus. */
export const NAME_LEVELS = 2;

export interface NamedDistrict {
  readonly district: District;
  /** 1 for a district directly inside the focus, 2 for one inside that. */
  readonly below: number;
}

/** The districts to name while `focus` fills the window. */
export function namedDistricts(districts: readonly District[], focus: NodeId): NamedDistrict[] {
  const byId = new Map<NodeId, District>(districts.map((district) => [district.id, district]));
  const named: NamedDistrict[] = [];
  for (const district of districts) {
    let below = 0;
    for (let at: District | undefined = district; at !== undefined && below <= NAME_LEVELS; at = at.parent === null ? undefined : byId.get(at.parent)) {
      if (at.id === focus && below > 0) {
        named.push({ district, below });
        break;
      }
      below++;
    }
  }
  return named;
}

/**
 * Where a double-click on the district `hit` flies while `focus` fills the window: the hit
 * district, or its ancestor that lies `NAME_LEVELS` below the focus if the hit is deeper, so the
 * camera lands on a district that is named. A hit outside the focus is counted from the top of
 * the repository.
 */
export function flyTarget(tree: Tree, focus: NodeId, hit: NodeId): NodeId {
  const chain = trail(tree, hit);
  const from = Math.max(0, chain.findIndex((node) => node.id === focus));
  return chain[Math.min(chain.length - 1, from + NAME_LEVELS)]!.id;
}

const EPSILON = 1e-6;

/** The height of the highest roof or plate within `district`, which a camera framing it must clear. */
export function regionTop(city: City, district: District): number {
  const inside = (thing: { x: number; y: number; w: number; d: number }): boolean =>
    thing.x >= district.x - EPSILON &&
    thing.y >= district.y - EPSILON &&
    thing.x + thing.w <= district.x + district.w + EPSILON &&
    thing.y + thing.d <= district.y + district.d + EPSILON;
  let top = district.base + PLATE_HEIGHT;
  for (const nested of city.districts) if (inside(nested)) top = Math.max(top, nested.base + PLATE_HEIGHT);
  for (const building of city.buildings) if (inside(building)) top = Math.max(top, building.base + building.height);
  return top;
}
