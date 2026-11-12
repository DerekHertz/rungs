# Coding standards

Judgement-call rules for reviewers. Mechanical rules live in `eslint.config.js`.

## Unknown is never zero

A count, cost, rate or answer that could not be read stays unknown (`null`, "not measured", "not judged") all the way to the page. It never becomes `0`, `$0`, an empty list or a pass. A rate over no cases is not measured, and an unmeasured rate never meets a bar. This is SPEC rule 5, "Never guess", applied to numbers.

Seen in review: a missing token count read as $0 and passed a cost bar, and an empty case file met every rate.

## Outside keys go in a Map

When a dictionary's keys come from outside the code (ids, names, paths, test titles, case ids), use a `Map` or `Object.create(null)`. A plain object loses a key named `__proto__` and finds inherited ones.

Seen in review: a case named `__proto__` dropped out of the bench's decisions and slipped past the steering check.
