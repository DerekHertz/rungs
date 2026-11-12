# Check set

Six small, merged, public pull requests that a person can understand without Systems to Streets. Each has its expected picture written down before Streets was run on it. A builder's browser check and the end-of-tier review run Streets on them and grade the picture against what is written here.

If Streets does not explain a small PR correctly, it will not explain a large one. No one repository is the reference, and no check reuses cached answers.

## Running a check

1. Clone the PR's repository into your scratch folder: `gh repo clone <owner>/<repo> <scratch>/check/<repo> -- --filter=blob:none`.
2. From that clone, start the server with an empty cache of your own, so nothing is reused: `XDG_CACHE_HOME=<scratch>/check/cache-<pass> node <your worktree>/src/cli.ts compare --pr <N> --port <your port> --no-open`. Add `--link --walkthrough` for claims and the tour. For judged checks use a second empty cache: run `streets setup --judge` in it, then `compare --pr <N> --judge --link --walkthrough`, so the judged pass does not reuse the plain pass's claims or tour.
3. Drive the page with `playwright-core`, a dev dependency of this repo.
4. Grade each line of the PR's expected picture as **matches**, **unknown where unknown is expected**, or **wrong**. An overclaim is wrong: a call, risk, contract or claim the picture states that the PR does not have, or "none" where the expected picture says unknown. Report every wrong line with its screenshot.

Lines marked *(inferred)* came from reading the diff, not the whole file. When one turns out wrong, fix it here in the same PR and say so; never change an expected line to match what Streets shows without reading the code.

## Runs

- Run 1, 2026-11-12, tier 3 before its end-of-tier fixes: 27 lines match, 4 unknown as expected, 10 wrong, 2 gaps (43 lines). Five expected lines below were corrected after that run read the full files; none was changed to match what Streets showed.

## The set

| # | PR | What a person sees | What it tests |
|---|---|---|---|
| 1 | [expressjs/express#7459](https://github.com/expressjs/express/pull/7459) | one-function fix, +21/-4, 2 files | a clean control: a simple fix reads as simple |
| 2 | [sindresorhus/ky#579](https://github.com/sindresorhus/ky/pull/579) | new option threaded through 5 files | a claim wider than the code |
| 3 | [axios/axios#11062](https://github.com/axios/axios/pull/11062) | function pulled into a shared module | a description wrong about where the code went |
| 4 | [firebase/functions-samples#1317](https://github.com/firebase/functions-samples/pull/1317) | `exec` becomes `execFile`, +2/-2 | a process call's target goes from unknown to known |
| 5 | [koajs/koa#1861](https://github.com/koajs/koa/pull/1861) | a behaviour removed with its 3 tests | removed tests read as removed with their subject |
| 6 | [spf13/cobra#2181](https://github.com/spf13/cobra/pull/2181) | Go: deprecated `ioutil` replaced | a language Streets does not analyse reads as not analysed |

### 1. express#7459: ETag kept when Transfer-Encoding is set

`res.send()` skipped computing the body length when a `Transfer-Encoding` header was set, which also switched off ETags. The length is now always computed; only the `Content-Length` header stays conditional.

- Files: `lib/response.js` altered (source); `test/res.send.js` altered (tests; one test added, none removed or weakened).
- Calls out: none appear or disappear. `res.send` also calls `this.end`, at two sites; whether that is an effect is Streets' call, but it is unchanged either way.
- Contracts moved: none. The behaviour change is not a signature change.
- Worry: nothing. A headline that invents risk is wrong.
- Claims: "preserve ETag generation with a pre-existing Transfer-Encoding" is shown by the code and the new test. "Commit 18e5985b caused it" is history: not linked to code.
- Unknown: whether the new test passes, when tests are not run.

### 2. ky#579: a `stringifyJson` option

Callers can pass `stringifyJson(data)` to control how the `json` request body is serialised; the default is `JSON.stringify`.

- Files: `source/core/Ky.ts`, `source/core/constants.ts`, `source/types/options.ts` altered (source); `readme.md` altered (docs); `test/main.ts` altered (tests; one test added).
- Calls out: none appear or disappear. The existing `fetch` is untouched.
- Contracts moved: the exported type `KyOptions` gains an optional member. Additive.
- Worry: a custom function returning `undefined` silently falls back to the default. *(inferred)* The `constants.ts` entry marks the key as a Ky-only option.
- Claims: the description says it controls how "the request data" is serialised; the code applies it to the `json` option only, not `body`. The description's own example never passes `json`. The claim is wider than the code, and the picture must not show it as fully backed.
- Unknown: whether the test passes, when tests are not run.

### 3. axios#11062: `setFormDataHeaders` extracted into a shared module

Two private copies of `setFormDataHeaders` become one module imported by both callers. The HTTP adapter also now tolerates FormData whose `getHeaders()` returns nothing.

- Files: `lib/core/setFormDataHeaders.js` added (source, one default export); `lib/adapters/http.js` and `lib/helpers/resolveConfig.js` altered (source); `tests/unit/adapters/http.test.js` altered (tests; one test added); `PRE_RELEASE_CHANGELOG.md` altered (docs).
- Calls out: none appear or disappear. The adapter's existing network calls are untouched and must not read as new.
- Contracts moved: a new default export (additive). The removed copies were private, so nothing moved on that side. Two new imports of the new module.
- Worry: a behaviour change filed as a refactor. The adapter's copy lacked `|| {}`, so it is not a pure move.
- Claims: the human summary says the function moves to `lib/helpers/setFormDataHeaders.js`; it went to `lib/core/`. The bot summary in the same description names `lib/core/`, so the two paths in the description disagree. The picture must not present `lib/helpers/` as part of the change. "No other behavior change" is contradicted by the next sentence. "946 passed" and "lint clean" are run claims, not linked to code.
- Grade on the compare view; the whole-repo map of a 532-file repo is not the test.

### 4. functions-samples#1317: `execFile` instead of `exec`

ImageMagick's `convert` is now run with an argument array (`execFile`) instead of a shell string built from the file name (`exec`).

- Files: `Node-1st-gen/moderate-images/functions/index.js` altered (source). No tests changed.
- Calls out: a process call exists before and after in `blurImage`. Its target goes from an interpolated string (unknown) to the literal `convert`. If Streets sees through `promisify(require('child_process').exec)`, the call reads as altered with a now-known target. If it does not, it must read as a process call of unknown target on both sides, never as altered or as removed and added.
- Contracts moved: none.
- Worry: none. The change removes a shell-injection route; the description states the mechanism, not the risk.
- Claims: both claims (`exec` replaced by `execFile`, called with an argument array) are shown by the code.
- Grade on the compare view; the repo is 778 files of separate samples.

### 5. koa#1861: ENOENT support removed

`ctx.onerror` no longer turns an `ENOENT` error into a 404, so streaming a missing file now gives a 500. The three tests for the old behaviour are deleted.

- Files: `lib/context.js` altered (source; `onerror` loses an `if`); `__tests__/application/respond.test.js` and `__tests__/context/onerror.test.js` altered (tests).
- Tests: 3 removed, and they tested the removed behaviour. The picture shows them removed; it must not call the change test weakening without saying they go with their subject.
- Calls out: none in source. The deleted tests held 4 `fs.createReadStream` calls, so file-system calls disappear from test code.
- Contracts moved: none by signature. The behaviour change for one input is not derived and must not be claimed as known.
- Worry: a breaking change with no docs or changelog in the diff.
- Claims: "removes special ENOENT handling" is the PR's title, and Streets reads only the description, so it is not expected as a claim. "Breaks fs.createReadStream support" is a consequence, not shown. The replacement middleware lives only in the PR body. "Closes #1420" is external.

### 6. cobra#2181: deprecated `ioutil` replaced (Go)

`ioutil.TempDir`, `ioutil.TempFile` and `ioutil.Discard` become `os.MkdirTemp`, `os.CreateTemp` and `io.Discard` in four Go test files and three docs pages.

- Files: four `.go` files are "not analysed": no functions, imports, contracts or calls are claimed for them. Their role is none: the role table has no Go rule. The three `.md` files are analysed as docs, with changed sections.
- Calls out: unknown for the Go files. "No calls" or "0 effects" is wrong. The radius of the change is qualified by the unread files or absent.
- Claims: the only claim is the lint rule (SA1019), which nothing in the tree links: unlinked. All seven files are unmentioned by the description.
- Unknown: everything about the Go files beyond changed lines.
