#!/bin/bash
# Merge a pull request once CI has passed on one exact commit: scripts/merge-when-green.sh <pr> <sha>
# `gh pr checks --watch` right after a push can report the previous commit's runs, and a run list
# can be partial while GitHub is still registering runs. So this waits until the PR's head is <sha>,
# every check on it has finished and passed, and that set of checks has stayed the same for a
# minute; then it merges, and the merge refuses if the branch has moved past <sha>.
set -euo pipefail
pr=$1 sha=$2
previous="" steady=0
for _ in $(seq 1 120); do
  head=$(gh pr view "$pr" --json headRefOid -q .headRefOid)
  if [ "$head" != "$sha" ]; then echo "PR #$pr is at $head, not $sha"; exit 1; fi
  checks=$(gh pr checks "$pr" --json name,workflow,event,bucket -q '.[] | "\(.workflow)/\(.name)/\(.event) \(.bucket)"' 2>/dev/null | sort || true)
  if [ -n "$checks" ] && ! grep -q ' pending$' <<<"$checks"; then
    if grep -qvE ' (pass|skipping)$' <<<"$checks"; then echo "CI did not pass on $sha:"; echo "$checks"; exit 1; fi
    if [ "$checks" = "$previous" ]; then steady=$((steady + 1)); else steady=0; fi
    previous=$checks
    if [ "$steady" -ge 6 ]; then
      gh pr merge "$pr" --merge --match-head-commit "$sha"
      exit 0
    fi
  else
    previous="" steady=0
  fi
  sleep 10
done
echo "CI on $sha did not finish within 20 minutes"; exit 1
