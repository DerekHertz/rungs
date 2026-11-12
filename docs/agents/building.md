# Building a pull request

Steps for an agent building one PR from issues, then how a tier's PRs are stacked, reviewed and merged.

## Build

1. Start a branch from the latest `origin/main`. Read `AGENTS.md` and `SPEC.md`, then each issue with `gh issue view N`.
2. Write a red test for each case first, then the fix.
3. Before opening the PR, sweep for the whole class of each case, not only the line the issue names. List every place your change turns missing, partial, old or failed data into an answer, and say in the report what each one reads as. Unknown is never none or zero. In tiers 1–3, round two of review mostly found the sibling of a round-one fix.
4. Run `npm test`, `npm run typecheck` and `npm run lint`, each once and cleanly, with no other vitest running. The check: `ps -eo pid=,args= | awk '$2=="node" && /vitest/'` prints nothing. Done when all three pass and you have their counts.
5. For a page-visible change, run a browser check on the PRs of [the check set](check-set.md) that your change touches, at least two, with an empty cache of your own as that file says. Grade the picture against each PR's expected picture, and report every line that is wrong. Look at every screenshot you cite. Done when each changed view is on a screenshot you have looked at and graded. A new feature may also be checked on small original fixture repositories you build; never on one cached repository alone.
6. Stop your servers with `scripts/stop-server.sh <port>`. Keep every scratch file (scripts, logs, screenshots, fixture repos) in one folder of your own, `<scratchpad>/issue-<N>/`, and when you report, delete everything in it except the screenshots you cite.
7. Open one PR, based on the branch below yours in the tier stack, with "Closes #N" for each issue, the north star, and a before/after. Leave the merge to whoever reviews it.
8. Report the PR URL, head sha, what changed, test counts, browser-check results with screenshot paths, and your doubts. Put proposed SPEC wording in the report; SPEC.md changes only when Derek adopts them.

## Gotchas

- `npm test`, `npm run lint` and `npm run typecheck` first run `scripts/ensure-deps.mjs`, which runs `npm ci` when `node_modules` doesn't match `package-lock.json`. A new worktree gets its dependencies on the first check.
- `src/page/` is typechecked with browser types (`tsc -p src/page`). A page file that a test imports is also checked by the root `tsconfig.json`, which has Node types only, so keep DOM code in page modules no test imports.
- `src/page/main.ts` is held under the 1000-line lint limit. Put new page code in its own module.
- Long shell commands with heredocs, pipes and `cd` are refused as "too complex to verify it stays in the worktree". Write the script to a file in your scratch folder and run it with one plain command instead. Builders lost about six turns each to this refusal in tiers 1–3.

## Tiers

A tier is built as a stack of PRs on a tier branch, with a review queue beside it. Nothing waits except at the end of the tier.

1. **Before the tier.** If its plan depends on an earlier result (a gate adopted, a bar met), check that result against what the plan assumed. If it came out differently, tell Derek before starting. Then cut `tier-<n>` from the latest `origin/main`.
2. **Stack.** The tier's tasks are built in order, each on its own branch on top of the one before: task 1 branches from `tier-<n>`, task 2 from task 1's branch, and so on. Each PR targets the branch below it.
3. **Queue, don't wait.** When a task's first build is done and the PR is open, it goes into the review queue, and the next task starts on top of it straight away.
4. **Review queue.** Each queued PR gets one Codex review in a fresh run, oldest first, in the background: `scripts/codex-review.sh <pr> <branch> 1 "<contract>" <base branch>`. The review covers that PR against the branch it sits on, so each review sees only its own task.
5. **Course-correct.** When a review comes back, sort its findings:
   - A finding that makes the picture or a review answer wrong goes to the builder. The builder fixes it on that task's branch, rebases the branches above it, and adjusts the task it is building now if the same mistake is there. Review the fix by reading its diff; it does not go back into the queue.
   - Every other finding is filed as an issue straight away, for a later tier. It is not built in this tier. Stay on the tier's own tasks.
6. **Merge into the tier.** Once a task's fixes are in, `scripts/merge-when-green.sh <pr> <sha>` merges it into the branch below. GitHub retargets the next PR in the stack.
7. **End of the tier, the one wait.** When every task is merged into `tier-<n>`, open a PR from `tier-<n>` to `main` and give it one Codex review against `main`, with the tier's goal as the contract. Run the whole check set on `tier-<n>`, fresh, and grade it. This review looks for what no single task review could see, such as the same mistake repeated across tasks. Fix only findings that make the picture or an answer wrong, file the rest, then merge it into `main`. The next tier starts from that `main`.

Each task gets a fresh builder, started once the task below it is in the queue. It begins on the top branch of the stack and gets that PR's body, which is the handoff: what was built, the decisions made and the doubts left open. Review fixes for a task lower in the stack go to whichever builder is working on top at the time. It fixes them on that task's branch and rebases the branches above. Don't keep one builder for the whole tier: its context fills with old tool output from tasks that are already finished.

## Merge

`scripts/merge-when-green.sh <pr> <sha>` waits for CI on that exact commit, then merges it with `--match-head-commit`.

## Clean up

After a tier merges into `main`, remove its builders' worktrees and branches (`git worktree remove --force`, `git branch -D`) and its `issue-<N>/` scratch folder. A builder's files belong to it until its tier merges: until then, its folder, worktree and servers stay, even when they look idle. Run about two builders at a time; the machine is small.
