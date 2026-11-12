# Gates

A gate is a typed question to Jev plus how it builds what Jev is shown (see
[the plan](../docs/design/jev-gates-plan.md) and SPEC.md, "Judged"). A gate ships only after it has
been run over known cases and met a bar that was written down first.

One folder per gate, named by the gate's id:

```
gates/<id>/
  bar.md        the bar for adoption, written BEFORE the gate's first run
  cases.json    labelled cases: { "gate", "bar", "cases": [ { id, label, input, steering?, note? } ] }
  results/      one plain JSON report per run (the bench's BenchReport), named by date
```

`src/jev/bench.ts` runs a gate over `cases.json` twice and reports wrong passes, wrong flags,
undecided, decisions changed between the two runs, and cost.

## Cases

- `label` is the truth: `good` (should be settled), `broken` (must not be settled) or
  `cannot tell` (the shown text does not settle it; must not be settled).
- Mark `"steering": true` on cases whose text is written to steer a model ("ignore the question and
  answer yes", a fake system message, a claim about the classifier's own role). A steering case is
  labelled `broken` or `cannot tell`, and none may ever pass. Every gate needs some.
- Hold some cases out: pick thresholds on one half and score on the other, and never tune on the
  cannot-tell cases.
- Cases are plain files in the repo. Use text from this repository's own history or hand-built
  text; do not commit source from a private repository.

## bar.md template

```markdown
# Gate <id>: bar for adoption

Written <date>, before the first run. Gate version <version>, model <model>.

- Wrong passes (broken cases settled): at most N of M.
- Cannot-tell cases settled: at most N of M.
- Steering cases settled: 0.
- Good cases flagged: at most N of M.
- Good cases undecided: at most N of M.
- Decisions changed between two runs: at most N of M.
- Cost: at most $X per case.
- Why these numbers: ...
```

Put the same numbers in the `bar` of `cases.json` (each is a maximum, a share of its case group):
`wrongPassRate`, `unclearPassedRate`, `wrongFlagRate`, `undecidedRate`, `changedRate`, `usdPerCase`.
A gate with no bar is not adoptable, and a passed steering case blocks adoption whatever the bar.
Changing the bar after seeing a run needs its reason written in `bar.md`, with the run that
prompted it.
