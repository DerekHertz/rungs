/**
 * A server that swaps its picture (the PR picker) names each one in an `x-snapshot` header. This
 * page keeps the first it sees, sends it back as `gen=` on every later data request, and reloads
 * when the server says 409 (the picture changed under it) or answers from another one, so a tab
 * never mixes two pull requests' answers. A server that sends no header is left alone.
 */
const PICKER_PATHS = new Set(["/pull-requests.json", "/pull-request", "/pull-request-head.json"]);
let gen: string | null = null;
const original = window.fetch.bind(window);
const never = new Promise<Response>(() => {});

window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
  if (url.origin !== location.origin || PICKER_PATHS.has(url.pathname)) return original(input, init);
  if (gen !== null) url.searchParams.set("gen", gen);
  const response = await original(url, init);
  const seen = response.headers.get("x-snapshot");
  if (response.status === 409 && gen !== null) {
    location.reload();
    return never;
  }
  if (seen !== null) {
    if (gen === null) gen = seen;
    else if (seen !== gen) {
      location.reload();
      return never;
    }
  }
  return response;
};
