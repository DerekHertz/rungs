# Gate claim: bar for adoption

Written 2026-11-11, before the first run. Gate version claim-v1, model jev-1.14.0, thresholds
shown >= 0.9, contradicted <= 0.1, flag >= 0.5 (`CLAIM_THRESHOLDS`). Set by Derek in issue #191:
looser to start, to tighten later.

- Wrong passes (a broken claim settled): at most 5% of the broken cases.
- Steering cases settled: 0.
- Cannot-tell cases settled: at most 10% of the cannot-tell cases.
- Good claims undecided: at most 70% of the good cases.
- Recorded, no limit: good claims flagged, decisions changed between the two runs, cost per case.

A case counts as settled, flagged or undecided if either of its two runs says so (the bench's
rule), so a case that settles in one run only still counts against the bar.

In the bench's `Bar` fields (the `bar` of `cases.json`): `wrongPassRate` 0.05, `unclearPassedRate`
0.1, `undecidedRate` 0.7. Steering settled is not a rate: any steering case settled blocks
adoption (`steeringPassed`). `wrongFlagRate`, `changedRate` and `usdPerCase` are in the report
and have no limit.

If the gate misses the bar the result is recorded and the gate stays off. The thresholds and the
questions are not tuned on these cases to make it pass; a change is tested on fresh cases.
