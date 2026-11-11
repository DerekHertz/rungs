import { CanvasTexture, Color, MeshLambertMaterial, NearestFilter, RepeatWrapping } from "three";

const GHOST_OPACITY = { rest: 0.12, hover: 0.3, selected: 0.3, faded: 0.05 };
const GLOW = { hover: 0.3, selected: 0.18 };
/** What a building in front of the hovered one keeps of its opacity. */
export const FADED = 0.25;

export interface Looks {
  readonly rest: MeshLambertMaterial;
  readonly hover: MeshLambertMaterial;
  readonly selected: MeshLambertMaterial;
  readonly faded: MeshLambertMaterial;
}

// Diagonal stripes mark a file no language adapter read: texture, so hue keeps meaning role.
let stripes: CanvasTexture | undefined;
function notAnalysedStripes(): CanvasTexture {
  if (stripes !== undefined) return stripes;
  const tile = document.createElement("canvas");
  tile.width = tile.height = 8;
  const pen = tile.getContext("2d")!;
  pen.fillStyle = "#ffffff";
  pen.fillRect(0, 0, 8, 8);
  pen.fillStyle = "rgba(0, 0, 0, 0.45)";
  for (let i = 0; i < 8; i++) pen.fillRect(i, 7 - i, 2, 1);
  stripes = new CanvasTexture(tile);
  stripes.wrapS = stripes.wrapT = RepeatWrapping;
  stripes.repeat.set(6, 6);
  stripes.magFilter = stripes.minFilter = NearestFilter;
  return stripes;
}

export function flat(hex: string, glow: number, striped = false): MeshLambertMaterial {
  const color = new Color(hex);
  return new MeshLambertMaterial({
    color,
    ...(striped ? { map: notAnalysedStripes() } : {}),
    emissive: color.clone().multiplyScalar(glow),
    // Keeps the outline from fighting the faces it sits on.
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
}

export function ghostLooksOf(hex: string): Looks {
  const see = (opacity: number): MeshLambertMaterial => {
    const material = flat(hex, 0);
    material.transparent = true;
    material.opacity = opacity;
    material.depthWrite = false;
    return material;
  };
  return {
    rest: see(GHOST_OPACITY.rest),
    hover: see(GHOST_OPACITY.hover),
    selected: see(GHOST_OPACITY.selected),
    faded: see(GHOST_OPACITY.faded),
  };
}

export function looksOf(hex: string, striped: boolean): Looks {
  const faded = flat(hex, 0, striped);
  faded.transparent = true;
  faded.opacity = FADED;
  faded.depthWrite = false;
  return {
    rest: flat(hex, 0, striped),
    hover: flat(hex, GLOW.hover, striped),
    selected: flat(hex, GLOW.selected, striped),
    faded,
  };
}

