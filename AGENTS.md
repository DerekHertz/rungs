# Rungs

Rungs draws a codebase as a pixel-art picture you zoom into, computed from the code. Decisions
live in [SPEC.md](SPEC.md); read it before changing behavior.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues (`DerekHertz/rungs`), through the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root, created when first needed. See `docs/agents/domain.md`.

## Working rules

**North star.** Every issue names the north-star question it moves: claims, unmentioned, contracts moved, or base map. Work that moves none waits behind work that does.

**Review rounds.** A finding that would make the picture or a review answer wrong blocks a merge. Edge cases found after the second review round become issues instead of more rounds.
