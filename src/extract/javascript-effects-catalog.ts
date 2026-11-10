import type { ResourceKind } from "../graph.ts";

/**
 * One runtime built-in that reaches a resource. Hand-maintained data, reviewed as text: a change
 * to this file is a change to the extractor's output, so it needs an EXTRACTOR_VERSION bump and
 * a new line in test/effect-catalog-versions.json.
 */
export interface EffectEntry {
  /** Without "node:". Null for a global such as fetch. */
  readonly module: string | null;
  readonly name: string;
  readonly resource: ResourceKind;
  /** Zero-based argument that names what the call reaches; null when the API has nothing to name. */
  readonly target: number | null;
  /** Reached only through `new`. */
  readonly construct?: true;
}

export const effectKey = (entry: Pick<EffectEntry, "module" | "name">): string =>
  entry.module === null ? entry.name : `${entry.module} ${entry.name}`;

const entries = (module: string, resource: ResourceKind, target: number | null, names: string): EffectEntry[] =>
  names.split(" ").map((name) => ({ module, name, resource, target }));

const withSync = (names: string): string =>
  names
    .split(" ")
    .flatMap((name) => [name, `${name}Sync`])
    .join(" ");

const FILE_FIRST = "readFile writeFile appendFile mkdir mkdtemp rm rmdir unlink readdir stat lstat access open opendir truncate chmod realpath";
const FILE_SECOND = "rename copyFile cp link symlink";

const fileSystem = (module: "fs" | "fs/promises"): EffectEntry[] => {
  const sync = module === "fs";
  const both = (names: string): string => (sync ? withSync(names) : names);
  return [
    ...entries(module, "file system", 0, both(FILE_FIRST)),
    ...entries(module, "file system", 1, both(FILE_SECOND)),
    ...entries(module, "file system", 0, "watch"),
    ...(sync ? entries(module, "file system", 0, "existsSync createReadStream createWriteStream") : []),
  ];
};

const timers = (module: string | null): EffectEntry[] =>
  ["setTimeout", "setInterval", "setImmediate"].map((name) => ({ module, name, resource: "timer", target: null }));

export const EFFECT_ENTRIES: readonly EffectEntry[] = [
  ...entries("child_process", "process", 0, "exec execSync execFile execFileSync spawn spawnSync fork"),
  { module: "worker_threads", name: "Worker", resource: "process", target: 0, construct: true },
  ...entries("process", "process", 0, "kill"),
  ...entries("process", "process", null, "exit"),
  ...fileSystem("fs"),
  ...fileSystem("fs/promises"),
  ...entries("http", "network", null, "createServer"),
  ...entries("http", "network", 0, "request get"),
  ...entries("https", "network", null, "createServer"),
  ...entries("https", "network", 0, "request get"),
  ...entries("net", "network", null, "createServer connect createConnection"),
  ...entries("tls", "network", null, "createServer connect createConnection"),
  ...entries("http2", "network", 0, "connect"),
  ...entries("dgram", "network", null, "createSocket"),
  ...entries("dns", "network", 0, "lookup"),
  { module: null, name: "fetch", resource: "network", target: 0 },
  { module: null, name: "WebSocket", resource: "network", target: 0, construct: true },
  { module: null, name: "EventSource", resource: "network", target: 0, construct: true },
  { module: null, name: "XMLHttpRequest", resource: "network", target: null, construct: true },
  ...entries("navigator", "network", 0, "sendBeacon"),
  ...timers(null),
  ...timers("timers"),
  ...timers("timers/promises"),
];

/** A function that returns its argument's behavior unchanged, so calling the result is calling the argument. */
export const TRANSPARENT_WRAPPERS: readonly { readonly module: string; readonly name: string; readonly target: number }[] = [
  { module: "util", name: "promisify", target: 0 },
];

/** Globals that stand for a module's members: `process.kill` is the "process" module's `kill`. */
export const GLOBAL_NAMESPACES: readonly string[] = ["process", "navigator"];

/** Globals whose members are globals: `globalThis.fetch` is `fetch`. */
export const GLOBAL_OBJECTS: readonly string[] = ["globalThis", "window", "self"];

/** Members that are themselves modules: `fs.promises` is "fs/promises". */
export const SUBMODULES: readonly (readonly [string, string, string])[] = [["fs", "promises", "fs/promises"]];

const BY_KEY: ReadonlyMap<string, EffectEntry> = new Map(EFFECT_ENTRIES.map((entry) => [effectKey(entry), entry]));

export function lookupEffect(module: string | null, name: string): EffectEntry | undefined {
  return BY_KEY.get(effectKey({ module, name }));
}

export function serializeCatalog(): string {
  return JSON.stringify({ entries: EFFECT_ENTRIES, wrappers: TRANSPARENT_WRAPPERS, namespaces: GLOBAL_NAMESPACES, objects: GLOBAL_OBJECTS, submodules: SUBMODULES });
}
