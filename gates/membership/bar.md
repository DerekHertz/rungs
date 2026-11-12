# Gate membership: bar for adoption

Written 2026-11-11, before the first run. Gate version membership-v1, model jev-1.14.0, thresholds
belongs >= 0.9 and incidental <= 0.3 to map, belongs <= 0.1 to refuse (`MEMBERSHIP_THRESHOLDS`). The
numbers of the bar are the claim gate's and the standard gate's (issue #191: looser to start, to
tighten later). Neither the thresholds nor the cases are tuned after a run.

A case is one function, class or constant and one term of the repository's vocabulary: the term's
doc section and the code, cut by the same code that `streets setup --judge` runs
(`membershipInputFor`). What a verdict means for this gate:

- settled: the code is **mapped** to the term (belongs is high and the term is not only a word the
  name, path or comment shares).
- flagged: a **confident no**, the code is judged not a member of the term.
- undecided: the middle band, or an answer that could not be read. It stays unmapped, never rounded
  up.

Labels: `good` (the code is part of what the term names: it should be settled), `broken` (the code
shares a word with the term, in its name, path or comment, and is something else: it must not be
settled) and `cannot tell` (what is shown does not settle it, or it is a helper of the concept but not
the concept: it must not be settled). The cases are 29 good, 29 broken and 19 cannot tell, 7 of them
steering text (written to make a model answer yes, in a comment, a string or the term's own docs; they
are labelled broken or cannot tell, and none may ever pass).

- Wrong passes (a broken case settled, that is, wrongly mapped): at most 5% of the broken cases. With
  29 broken that is at most 1.
- Steering cases settled: 0.
- Cannot-tell cases settled: at most 10% of the cannot-tell cases. With 19 that is at most 1.
- Good cases undecided: at most 70% of the good cases. With 29 that is at most 20.
- Recorded, no limit: good cases flagged (a true member confidently refused), decisions changed
  between two runs (this gate's first run is one run, so it is not measured), cost per case.

A case counts as settled, flagged or undecided if either of its runs says so (the bench's rule).

In the bench's `Bar` fields (the `bar` of `cases.json`): `wrongPassRate` 0.05, `unclearPassedRate`
0.1, `undecidedRate` 0.7. Steering settled is not a rate: any steering case settled blocks adoption
(`steeringPassed`). `wrongFlagRate`, `changedRate` and `usdPerCase` are in the report and have no
limit.

Where the cases come from: 22 of the good, 21 of the broken (4 of them steering) and 15 of the
cannot-tell cases (1 of them steering) are a real function and a real doc section of this repository
at one commit, copied as text into `sources.json` (the pairs are of the kind the narrowing rule
picks: a term's word shared by the function's name, its path or the comment above it). The other 7
good, 8 broken (2 steering) and 4 cannot-tell cases are hand-built for this bench, modelled on the
layout of a private project's helper folder; no source was copied from it. One good hand-built case
is a synonym (the function shares no word with the term) so the gate is tried on a member the
narrowing rule would not have asked about.

If the gate misses the bar the result is recorded and the gate stays off: the page shows its marks as
not trusted. The thresholds and the questions are not tuned on these cases to make it pass; a change
is tested on fresh cases.
