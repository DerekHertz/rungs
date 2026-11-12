import { mayCheck, POLL_MS } from "../picker-timing.ts";

interface Listed {
  readonly number: number;
  readonly title: string;
  readonly author: string | null;
  readonly draft: boolean;
}
type Listing =
  | { readonly status: "ok"; readonly prs: readonly Listed[]; readonly truncated: boolean; readonly current: { readonly number: number; readonly head: string } | null }
  | { readonly status: "unavailable"; readonly why: string };
interface HeadAnswer {
  readonly moved: boolean | null;
  readonly why?: string;
}

const STYLE = `
#pr-picker { flex: none; display: flex; align-items: center; gap: 6px; padding: 0 6px; color: #8a9bb0; max-width: 60vw; }
#pr-picker[hidden] { display: none; }
#pr-picker select, #pr-picker button { box-sizing: border-box; height: 24px; font: inherit; color: #e8edf2; background: #0b0f14; border: 1px solid #3b4d66; border-radius: 2px; }
#pr-picker select { max-width: 260px; min-width: 0; }
#pr-picker button { padding: 0 8px; cursor: pointer; }
#pr-picker .pr-badge { border-color: #d9a84f; color: #f0c26b; }
#pr-picker .pr-line { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 700px) { #pr-picker select { max-width: 34vw; } }
`;

const post = (query: string): Promise<Response> => fetch(`/pull-request?${query}`, { method: "POST" });

/** The picker at the top of the page: absent on a plain `compare`, which has no such route. */
export async function mountPicker(host: HTMLElement): Promise<void> {
  const response = await fetch("/pull-requests.json").catch(() => undefined);
  if (response === undefined || !response.ok) return;
  const listing = (await response.json()) as Listing;
  const style = document.createElement("style");
  style.textContent = STYLE;
  document.head.append(style);
  host.hidden = false;
  if (listing.status === "unavailable") {
    // One line, and the page below it still works.
    const line = document.createElement("span");
    line.className = "pr-line";
    line.textContent = listing.why;
    line.title = listing.why;
    host.append(line);
    return;
  }
  const select = document.createElement("select");
  select.setAttribute("aria-label", "Pull request");
  const none = document.createElement("option");
  none.value = "";
  none.textContent = listing.current === null ? `Pick a pull request (${listing.prs.length}${listing.truncated ? "+" : ""} open)` : "Pull request";
  select.append(none);
  const listed = new Set<number>();
  for (const pr of listing.prs) {
    listed.add(pr.number);
    const option = document.createElement("option");
    option.value = String(pr.number);
    option.textContent = `#${pr.number} ${pr.draft ? "[draft] " : ""}${pr.title}${pr.author === null ? "" : ` (${pr.author})`}`;
    select.append(option);
  }
  if (listing.current !== null && !listed.has(listing.current.number)) {
    const option = document.createElement("option");
    option.value = String(listing.current.number);
    option.textContent = `#${listing.current.number} (no longer open)`;
    select.append(option);
  }
  if (listing.current !== null) select.value = String(listing.current.number);
  const status = document.createElement("span");
  status.className = "pr-line";
  status.setAttribute("role", "status");
  host.append(select, status);

  const run = async (query: string, what: string): Promise<void> => {
    select.disabled = true;
    status.textContent = what;
    const answer = await post(query).catch(() => undefined);
    const body = answer === undefined ? undefined : ((await answer.json().catch(() => undefined)) as { ok?: boolean; why?: string } | undefined);
    if (body?.ok === true) {
      location.reload();
      return;
    }
    select.disabled = false;
    status.textContent = body?.why ?? "the server did not answer";
    select.value = listing.current === null ? "" : String(listing.current.number);
  };
  select.addEventListener("change", () => {
    if (select.value !== "") void run(`number=${select.value}`, "fetching the pull request...");
  });
  if (listing.current === null) return;

  const reload = document.createElement("button");
  reload.type = "button";
  reload.textContent = "Reload";
  reload.title = "Fetch the pull request again and redraw";
  reload.addEventListener("click", () => void run("reload=1", "fetching the pull request..."));
  const badge = document.createElement("button");
  badge.type = "button";
  badge.className = "pr-badge";
  badge.hidden = true;
  badge.textContent = "new commits: reload";
  badge.addEventListener("click", () => void run("reload=1", "fetching the pull request..."));
  host.append(reload, badge);

  // The badge asks on focus and every few minutes, never twice inside the minimum gap and never two at once.
  let lastStarted: number | null = null;
  let inFlight = false;
  const check = async (): Promise<void> => {
    if (document.visibilityState === "hidden" || !mayCheck(Date.now(), lastStarted, inFlight)) return;
    lastStarted = Date.now();
    inFlight = true;
    try {
      const asked = await fetch("/pull-request-head.json");
      const answer = (await asked.json()) as HeadAnswer;
      badge.hidden = answer.moved !== true;
      // Unknown is not "no new commits": say the check failed.
      status.textContent = answer.moved === null ? "could not check for new commits" : "";
      status.title = answer.moved === null ? (answer.why ?? "") : "";
    } catch {
      status.textContent = "could not check for new commits";
    } finally {
      inFlight = false;
    }
  };
  window.addEventListener("focus", () => void check());
  setInterval(() => void check(), POLL_MS);
}
