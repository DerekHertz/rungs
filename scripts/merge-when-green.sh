#!/bin/bash
# Merge a pull request once CI has passed on one exact commit: scripts/merge-when-green.sh <pr> <sha>
# `gh pr checks --watch` right after a push can report the previous commit's runs, so this waits
# for the runs of <sha> itself, and the merge refuses if the branch has moved past it.
set -euo pipefail
pr=$1 sha=$2
branch=$(gh pr view "$pr" --json headRefName -q .headRefName)
for _ in $(seq 1 120); do
  runs=$(gh run list --branch "$branch" --commit "$sha" --json status,conclusion -q '.[] | "\(.status) \(.conclusion)"')
  if [ -n "$runs" ] && ! grep -qv '^completed' <<<"$runs"; then
    if grep -qv '^completed success$' <<<"$runs"; then
      echo "CI did not pass on $sha:"; echo "$runs"; exit 1
    fi
    gh pr merge "$pr" --merge --match-head-commit "$sha"
    exit 0
  fi
  sleep 10
done
echo "CI on $sha did not finish within 20 minutes"; exit 1
