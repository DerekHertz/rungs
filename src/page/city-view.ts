import {
  AmbientLight,
  BoxGeometry,
  Color,
  DirectionalLight,
  EdgesGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshLambertMaterial,
  OrthographicCamera,
  Raycaster,
  Scene,
  Vector2,
  WebGLRenderer,
} from "three";
import type { Object3D } from "three";
import { PLATE_HEIGHT } from "../city.ts";
import type { Building, City, District } from "../city.ts";
import type { NodeId } from "../graph.ts";
import { BACKGROUND, onBackground, roleColor } from "./palette.ts";

interface Point {
  readonly x: number;
  readonly y: number;
}

export interface CityHandlers {
  /** The building under the pointer, or undefined; fires as the pointer or the camera moves. */
  hover(id: NodeId | undefined, at: Point): void;
  /** `clicks` is 1 for a single click and counts up with a double-click. */
  click(id: NodeId | undefined, clicks: number): void;
  doubleClick(id: NodeId | undefined): void;
}

export interface CityView {
  show(city: City): void;
  /** Outlines this building as the selected one. */
  select(id: NodeId | undefined): void;
  /** Returns to the isometric view of the whole city. */
  reset(): void;
  /** Steps pixel mode through off, 1/2 and 1/3 resolution; returns the divisor now in force. */
  cyclePixel(): 1 | 2 | 3;
}

const DEG = Math.PI / 180;
const TILT_MIN = 25 * DEG;
const TILT_MAX = 70 * DEG;
const ISOMETRIC = { az: 45 * DEG, tilt: Math.atan(1 / Math.SQRT2) };
const PIXEL_DIVISORS = [1, 2, 3] as const;
const CAMERA_DISTANCE = 3000;
const ZOOM_RANGE = { min: 0.15, max: 40 };
const FRAME_FILL = 0.86;
const CLICK_SLOP = 4;
const EDGE = { rest: "#0a0d12", hover: "#ffffff", selected: "#ffd479" };
const GLOW = { hover: 0.3, selected: 0.18 };

/** Where the camera looks and how: turning, tilt, pixels per plan unit, and the ground point centred. */
interface Pose {
  az: number;
  tilt: number;
  ppu: number;
  tx: number;
  tz: number;
}

type Mode = "pan" | "turn";

interface Looks {
  readonly rest: MeshLambertMaterial;
  readonly hover: MeshLambertMaterial;
  readonly selected: MeshLambertMaterial;
}

interface Entry {
  readonly mesh: Mesh;
  readonly edges: LineSegments;
}

interface Building3D extends Entry {
  readonly looks: Looks;
}

function flat(hex: string, glow: number): MeshLambertMaterial {
  const color = new Color(hex);
  return new MeshLambertMaterial({
    color,
    emissive: color.clone().multiplyScalar(glow),
    // Keeps the outline from fighting the faces it sits on.
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
}

function looksOf(hex: string): Looks {
  return { rest: flat(hex, 0), hover: flat(hex, GLOW.hover), selected: flat(hex, GLOW.selected) };
}

/** The ground directions the screen's right and up point along, for a turn of `az`. */
function basis(az: number): { right: [number, number]; up: [number, number] } {
  return { right: [Math.cos(az), -Math.sin(az)], up: [-Math.sin(az), -Math.cos(az)] };
}

export function createCityView(host: HTMLElement, handlers: CityHandlers): CityView {
  const renderer = new WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  const canvas = renderer.domElement;
  canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none";
  canvas.setAttribute("aria-label", "City of the repository");
  host.prepend(canvas);

  const scene = new Scene();
  scene.background = new Color(BACKGROUND);
  const camera = new OrthographicCamera(-1, 1, 1, -1, 10, 8000);
  const ambient = new AmbientLight(0xffffff, 0.15 * Math.PI);
  const sun = new DirectionalLight(0xffffff, 0.79 * Math.PI);
  scene.add(ambient, sun, sun.target);

  const box = new BoxGeometry(1, 1, 1);
  const outline = new EdgesGeometry(box);
  const edgeMaterials = {
    rest: new LineBasicMaterial({ color: EDGE.rest }),
    hover: new LineBasicMaterial({ color: EDGE.hover }),
    selected: new LineBasicMaterial({ color: EDGE.selected }),
  };
  const plateMaterials = new Map<string, MeshLambertMaterial>();
  const plateMaterial = (hex: string): MeshLambertMaterial => {
    const known = plateMaterials.get(hex) ?? flat(hex, 0);
    plateMaterials.set(hex, known);
    return known;
  };
  const plateEdges = new Map<string, LineBasicMaterial>();
  const plateEdge = (hex: string): LineBasicMaterial => {
    const known = plateEdges.get(hex) ?? new LineBasicMaterial({ color: hex });
    plateEdges.set(hex, known);
    return known;
  };
  const looksByColor = new Map<string, Looks>();
  const looksFor = (hex: string): Looks => {
    const known = looksByColor.get(hex) ?? looksOf(hex);
    looksByColor.set(hex, known);
    return known;
  };

  let group = new Group();
  let city: City | undefined;
  const buildings = new Map<NodeId, Building3D>();
  const idOf = new Map<Object3D, NodeId>();
  let pickable: Mesh[] = [];

  let width = 1;
  let height = 1;
  let divisor = 0;
  let fit = 1;
  const shown: Pose = { az: ISOMETRIC.az, tilt: ISOMETRIC.tilt, ppu: 1, tx: 0, tz: 0 };
  const target: Pose = { ...shown };
  let dirty = true;

  let hovered: NodeId | undefined;
  let selected: NodeId | undefined;
  let pointer: Point | undefined;
  let pickPending = false;

  const worldX = (x: number): number => x - (city?.width ?? 0) / 2;
  const worldZ = (y: number): number => y - (city?.depth ?? 0) / 2;

  function place(x: number, y: number, w: number, d: number, base: number, thickness: number, material: MeshLambertMaterial, edge: LineBasicMaterial): Entry {
    const mesh = new Mesh(box, material);
    mesh.scale.set(w, thickness, d);
    mesh.position.set(worldX(x + w / 2), base + thickness / 2, worldZ(y + d / 2));
    mesh.updateMatrix();
    mesh.matrixAutoUpdate = false;
    const edges = new LineSegments(outline, edge);
    mesh.add(edges);
    group.add(mesh);
    pickable.push(mesh);
    return { mesh, edges };
  }

  function addDistrict(district: District): void {
    const color = roleColor(district.role);
    const entry = place(
      district.x,
      district.y,
      district.w,
      district.d,
      district.base,
      PLATE_HEIGHT,
      plateMaterial(onBackground(color, 0.3)),
      plateEdge(onBackground(color, 0.55)),
    );
    idOf.set(entry.mesh, district.id);
  }

  function addBuilding(building: Building): void {
    const looks = looksFor(roleColor(building.role));
    const entry = place(building.x, building.y, building.w, building.d, building.base, building.height, looks.rest, edgeMaterials.rest);
    idOf.set(entry.mesh, building.id);
    buildings.set(building.id, { ...entry, looks });
  }

  function paint(id: NodeId | undefined): void {
    const entry = id === undefined ? undefined : buildings.get(id);
    if (entry === undefined) return;
    const state = id === selected ? "selected" : id === hovered ? "hover" : "rest";
    entry.mesh.material = entry.looks[state];
    entry.edges.material = edgeMaterials[state];
    dirty = true;
  }

  function setHovered(id: NodeId | undefined): void {
    const before = hovered;
    hovered = id;
    paint(before);
    paint(id);
  }

  /** The pose that fits the whole city in the window, keeping the turn and tilt given. */
  function framing(from: Pose): Pose {
    if (city === undefined) return from;
    const { right, up } = basis(from.az);
    const sin = Math.sin(from.tilt);
    const cos = Math.cos(from.tilt);
    let left = Infinity;
    let rightmost = -Infinity;
    let low = Infinity;
    let high = -Infinity;
    for (const x of [worldX(0), worldX(city.width)]) {
      for (const z of [worldZ(0), worldZ(city.depth)]) {
        for (const y of [0, city.top]) {
          const across = x * right[0] + z * right[1];
          const rising = (x * up[0] + z * up[1]) * sin + y * cos;
          left = Math.min(left, across);
          rightmost = Math.max(rightmost, across);
          low = Math.min(low, rising);
          high = Math.max(high, rising);
        }
      }
    }
    const across = (left + rightmost) / 2;
    const rising = (low + high) / 2;
    return {
      ...from,
      tx: right[0] * across + up[0] * (rising / sin),
      tz: right[1] * across + up[1] * (rising / sin),
      ppu: FRAME_FILL * Math.min(width / (rightmost - left), height / (high - low)),
    };
  }

  function updateCamera(): void {
    const sinTurn = Math.sin(shown.az);
    const cosTurn = Math.cos(shown.az);
    const cosTilt = Math.cos(shown.tilt);
    camera.position.set(
      shown.tx + sinTurn * cosTilt * CAMERA_DISTANCE,
      Math.sin(shown.tilt) * CAMERA_DISTANCE,
      shown.tz + cosTurn * cosTilt * CAMERA_DISTANCE,
    );
    camera.lookAt(shown.tx, 0, shown.tz);
    camera.left = -width / 2 / shown.ppu;
    camera.right = width / 2 / shown.ppu;
    camera.top = height / 2 / shown.ppu;
    camera.bottom = -height / 2 / shown.ppu;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    // The light turns with the camera, so the three visible faces keep their shades.
    const { right, up } = basis(shown.az);
    sun.position.set(-0.233 * right[0] - 0.268 * up[0], 0.937, -0.233 * right[1] - 0.268 * up[1]).multiplyScalar(1000);
  }

  function applyResolution(): void {
    width = Math.max(1, host.clientWidth);
    height = Math.max(1, host.clientHeight);
    const step = PIXEL_DIVISORS[divisor]!;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2) / step);
    renderer.setSize(width, height, false);
    canvas.style.imageRendering = step > 1 ? "pixelated" : "auto";
    dirty = true;
  }

  function reset(): void {
    Object.assign(target, framing({ ...target, az: ISOMETRIC.az, tilt: ISOMETRIC.tilt }));
    fit = target.ppu;
    dirty = true;
  }

  function show(next: City): void {
    group.removeFromParent();
    group = new Group();
    buildings.clear();
    idOf.clear();
    pickable = [];
    hovered = selected = undefined;
    city = next;
    next.districts.forEach(addDistrict);
    next.buildings.forEach(addBuilding);
    group.updateMatrixWorld(true);
    scene.add(group);
    Object.assign(shown, framing({ ...shown, az: ISOMETRIC.az, tilt: ISOMETRIC.tilt }));
    Object.assign(target, shown);
    fit = shown.ppu;
    dirty = true;
  }

  const ray = new Raycaster();
  const ndc = new Vector2();
  function pickBuilding(): NodeId | undefined {
    if (pointer === undefined) return undefined;
    const bounds = canvas.getBoundingClientRect();
    ndc.set(((pointer.x - bounds.left) / bounds.width) * 2 - 1, -((pointer.y - bounds.top) / bounds.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(pickable, false)[0];
    const id = hit === undefined ? undefined : idOf.get(hit.object);
    return id !== undefined && buildings.has(id) ? id : undefined;
  }

  function pickAt(event: MouseEvent): NodeId | undefined {
    pointer = { x: event.clientX, y: event.clientY };
    return pickBuilding();
  }

  const pressed = new Map<number, Point>();
  let mode: Mode = "pan";
  let pressedAt: Point = { x: 0, y: 0 };
  let travelled = 0;
  let turning = false;

  function drag(dx: number, dy: number): void {
    if (mode === "turn") {
      target.az -= dx * 0.4 * DEG;
      target.tilt = Math.min(TILT_MAX, Math.max(TILT_MIN, target.tilt + dy * 0.3 * DEG));
    } else {
      const { right, up } = basis(target.az);
      const across = dx / target.ppu;
      const rising = dy / target.ppu / Math.sin(target.tilt);
      target.tx -= right[0] * across - up[0] * rising;
      target.tz -= right[1] * across - up[1] * rising;
    }
    dirty = true;
  }

  function groundUnder(pose: Pose, dx: number, dy: number): Point {
    const { right, up } = basis(pose.az);
    const across = dx / pose.ppu;
    const rising = dy / pose.ppu / Math.sin(pose.tilt);
    return { x: pose.tx + right[0] * across + up[0] * rising, y: pose.tz + right[1] * across + up[1] * rising };
  }

  function zoomAt(factor: number, clientX: number, clientY: number): void {
    const bounds = canvas.getBoundingClientRect();
    const dx = clientX - bounds.left - width / 2;
    const dy = -(clientY - bounds.top - height / 2);
    const before = groundUnder(target, dx, dy);
    target.ppu = Math.min(fit * ZOOM_RANGE.max, Math.max(fit * ZOOM_RANGE.min, target.ppu * factor));
    const after = groundUnder({ ...target, tx: 0, tz: 0 }, dx, dy);
    target.tx = before.x - after.x;
    target.tz = before.y - after.y;
    dirty = true;
  }

  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  canvas.addEventListener("pointerdown", (event) => {
    canvas.setPointerCapture(event.pointerId);
    pressed.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pressed.size > 1) return;
    pressedAt = { x: event.clientX, y: event.clientY };
    travelled = 0;
    turning = event.button === 2 || (event.button === 0 && event.shiftKey);
    mode = turning ? "turn" : "pan";
    canvas.style.cursor = turning ? "move" : "grabbing";
    pointer = undefined;
    pickPending = true;
  });
  canvas.addEventListener("pointermove", (event) => {
    const last = pressed.get(event.pointerId);
    if (last === undefined) {
      pointer = { x: event.clientX, y: event.clientY };
      pickPending = true;
      return;
    }
    const dx = event.clientX - last.x;
    const dy = event.clientY - last.y;
    pressed.set(event.pointerId, { x: event.clientX, y: event.clientY });
    travelled = Math.max(travelled, Math.hypot(event.clientX - pressedAt.x, event.clientY - pressedAt.y));
    if (pressed.size === 1) drag(dx, dy);
  });
  const release = (event: PointerEvent): void => {
    pressed.delete(event.pointerId);
    if (pressed.size > 0) return;
    canvas.style.cursor = "";
    pointer = { x: event.clientX, y: event.clientY };
    pickPending = true;
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
  canvas.addEventListener("pointerleave", () => {
    if (pressed.size > 0) return;
    pointer = undefined;
    pickPending = true;
  });
  canvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      zoomAt(Math.exp(-event.deltaY * (event.deltaMode === 0 ? 0.0015 : 0.05)), event.clientX, event.clientY);
    },
    { passive: false },
  );
  canvas.addEventListener("click", (event) => {
    if (travelled >= CLICK_SLOP || turning) return;
    handlers.click(pickAt(event), event.detail);
  });
  canvas.addEventListener("dblclick", (event) => {
    if (travelled >= CLICK_SLOP || turning) return;
    handlers.doubleClick(pickAt(event));
  });
  new ResizeObserver(applyResolution).observe(host);

  let last = performance.now();
  function frame(now: number): void {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const follow = 1 - Math.exp(-dt / 0.09);
    let moving = false;
    for (const key of ["az", "tilt", "ppu", "tx", "tz"] as const) {
      const gap = target[key] - shown[key];
      const small = key === "ppu" ? 1e-4 * target.ppu : key === "az" || key === "tilt" ? 1e-4 : 0.01 / shown.ppu;
      if (Math.abs(gap) > small) {
        shown[key] += gap * follow;
        moving = true;
      } else {
        shown[key] = target[key];
      }
    }
    if (moving && pointer !== undefined && pressed.size === 0) pickPending = true;
    if (pickPending) {
      pickPending = false;
      setHovered(pressed.size === 0 ? pickBuilding() : undefined);
      handlers.hover(hovered, pointer ?? { x: 0, y: 0 });
    }
    if (moving || dirty) {
      updateCamera();
      renderer.render(scene, camera);
      dirty = false;
    }
    requestAnimationFrame(frame);
  }
  applyResolution();
  requestAnimationFrame(frame);

  return {
    show,
    select(id) {
      const before = selected;
      selected = id;
      paint(before);
      paint(id);
    },
    reset,
    cyclePixel() {
      divisor = (divisor + 1) % PIXEL_DIVISORS.length;
      applyResolution();
      return PIXEL_DIVISORS[divisor]!;
    },
  };
}
