#!/bin/bash
# Codex review of one pull request: scripts/codex-review.sh <pr> <branch> <round> "<contract>"
# Reviews a fresh detached worktree of origin/<branch> against origin/main and writes the
# findings to $REVIEW_DIR/<pr>-r<round>.md (default: ${TMPDIR:-/tmp}/streets-reviews).
set -euo pipefail
pr=$1 branch=$2 round=$3 contract=$4
repo=$(git rev-parse --show-toplevel)
out=${REVIEW_DIR:-${TMPDIR:-/tmp}/streets-reviews}
mkdir -p "$out"
git -C "$repo" fetch -q origin "$branch" main
tree=$(mktemp -d)
# Cleanup is set before the worktree exists, and no hook from the reviewed branch runs.
trap 'git -C "$repo" -c core.hooksPath=/dev/null worktree remove --force "$tree" 2>/dev/null; rm -rf "$tree"; git -C "$repo" worktree prune' EXIT
git -C "$repo" -c core.hooksPath=/dev/null worktree add -q --detach "$tree" "origin/$branch"
standards=$(cat "$repo/CODING_STANDARDS.md" 2>/dev/null || true)
(cd "$tree" && codex exec --sandbox read-only -m gpt-6-astra -c model_reasoning_effort=high -o "$out/$pr-r$round.md" \
  "Review the diff between origin/main and HEAD in this repo (git diff origin/main...HEAD). Read SPEC.md and AGENTS.md for the product's rules. Contract: $contract

Coding standards for this repo:
$standards

Report only real defects as P1 (wrong output or crash on a reachable path, or the review panel/picture claiming something false) or P2 (edge case), each with file:line and a concrete input that triggers it. Say PASS if none." \
  < /dev/null > "$out/$pr-r$round.log" 2>&1)
cat "$out/$pr-r$round.md"
