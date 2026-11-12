# Building a pull request

Steps for an agent building one PR from issues, then the review and merge that follow.

## Build

1. Start a branch from the latest `origin/main`. Read `AGENTS.md` and `SPEC.md`, then each issue with `gh issue view N`.
2. Write a red test for each case first, then the fix.
3. Run `npm test`, `npm run typecheck` and `npm run lint`, each once and cleanly, with no other vitest running. The check: `ps -eo pid=,args= | awk '$2=="node" && /vitest/'` prints nothing. Done when all three pass and you have their counts.
4. For a page-visible change, run a browser check on a real pull request. From a checkout of docviz (`/home/dhertzell/docviz` on Derek's machine), start the server with `node <your worktree>/src/cli.ts compare --pr 14 --port <your port> --no-open`. Add `--link --walkthrough` for claims or the tour; both are cached. Drive the page with playwright-core, loaded with `createRequire("/home/dhertzell/docviz/package.json")`. Look at every screenshot you cite. Done when each changed view is on a screenshot you have looked at.
5. Stop your servers with `scripts/stop-server.sh <port>`.
6. Open one PR with "Closes #N" for each issue, the north star, and a before/after. Leave the merge to whoever reviews it.
7. Report the PR URL, head sha, what changed, test counts, browser-check results with screenshot paths, and your doubts. Put proposed SPEC wording in the report; SPEC.md changes only when Derek adopts them.

## Gotchas

- `npm test`, `npm run lint` and `npm run typecheck` first run `scripts/ensure-deps.mjs`, which runs `npm ci` when `node_modules` doesn't match `package-lock.json`. A new worktree gets its dependencies on the first check.
- `src/page/` is typechecked with browser types (`tsc -p src/page`). A page file that a test imports is also checked by the root `tsconfig.json`, which has Node types only, so keep DOM code in page modules no test imports.
- `src/page/main.ts` is held under the 1000-line lint limit. Put new page code in its own module.

## Review

Every PR gets a Codex review: `scripts/codex-review.sh <pr> <branch> <round> "<contract>"`. The contract is what must hold, in a few sentences drawn from the issues and SPEC. The script adds `CODING_STANDARDS.md` to the prompt.

- A PR that decides answers (extractor, review rows, judged gates) gets two rounds. A page-only PR gets one.
- After the last round, fix only findings that make the picture or a review answer wrong, and review that fix by reading its diff. Every other finding becomes an issue.

## Merge

`scripts/merge-when-green.sh <pr> <sha>` waits for CI on that exact commit, then merges it with `--match-head-commit`.
