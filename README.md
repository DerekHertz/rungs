# Rungs

Coding agents now open pull requests of thousands of lines, and someone still has to decide whether to merge them. Reading the diff does not scale, and a summary written by the same agent is a claim, not evidence. Rungs computes a picture of the code itself, a city you can turn and zoom into, so a reviewer can approve a large change the way they would approve a design: by seeing what it touches, and opening the exact source lines behind anything they doubt.

![Rungs' own repository drawn as a code city: districts for src, test and docs, buildings coloured by role and sized by line count, with floating district names.](docs/media/city.png)

*Rungs drawing its own repository. Blue buildings are source, green are tests, yellow are docs, dark blue is config and orange is generated. Height is the number of classes and functions in a file. Striped buildings are files Rungs cannot analyse yet.*

**The target.** Run one command on a real agent-written change of 10,000 lines or more, and approve or reject it in 15 minutes without opening a diff. To decide, a reviewer needs three answers: what the change claims to do, what it touches that nobody mentioned, and which contracts moved. The test case is [a 14,370-line agent-written pull request](https://github.com/DerekHertz/docviz/pull/18).

The name comes from a ladder of abstraction. Each rung is computed from the one below it: source, then a graph, then pseudocode, then logic, then the picture.

## How it works

1. **Read the checkout.** Rungs lists the files git tracks plus untracked ones not ignored, and reads them from the working tree, so uncommitted changes are included. A symlink reads as its target path, the way git stores it, so nothing outside the checkout leaks in.
2. **Extract a graph.** A pure, deterministic function turns the file tree into a graph of packages, folders, files, classes and functions, each with a line range and a role (source, tests, config, docs or generated). JavaScript and TypeScript go through the TypeScript compiler. No model is called.
3. **Lay out a ground plan.** A squarified treemap places every package, folder and file. The layout depends only on the graph, so neither the camera nor the theme ever moves anything.
4. **Draw a city.** Districts are raised plates and files are buildings, rendered with three.js. Drag to pan, right-drag to turn, scroll to zoom, double-click a district to fly to it. Click a building to read its source, served from the same snapshot the graph came from.

## System design

The architecture borrows from operating systems and distributed systems: Ensemble-style composable layers, a single trusted writer, and consistency models for deciding what to compute and when.

| Decision | Why |
| --- | --- |
| **One stored rung.** Only the graph is stored. Pseudocode, logic and the picture are views computed from it. | There is one source of truth, and every view can be recomputed and traced back to source lines. Nothing drawn can drift from the code. |
| **A single trusted writer.** The extractor is the only module that writes graph facts. It is a pure function from a file tree to a graph, with no model calls. | Facts are reproducible and checkable. A golden graph plus an append-only version ledger make the build fail if extractor output changes without a version bump. |
| **Three tiers of facts, never mixed.** *Derived* facts come from the extractor, *observed* facts from running the code, *claimed* facts from people and agents. | It is a trust boundary. An agent's description of its own change is drawn as a claim, and can attach to the graph but never create or change a node. |
| **Composable layers behind narrow seams**, in the style of Ensemble. A language adapter turns files of one language into nodes and edges, and a theme turns facts into looks. | Each layer can be replaced and tested alone. Adapters only describe declarations, and the extractor alone assigns ids and line numbers, so a new language cannot break identity. Every theme shares one layout, so switching theme moves nothing. |
| **Identity is (level, path, qualified name), never a line number.** | A function keeps its identity when code above it moves, which is what makes a review a comparison of two graphs. The naming scheme is collision-free by construction and is recorded in [ADR 0001](docs/adr/0001-code-node-identity.md). |
| **Lazy release consistency for expensive views.** Pseudocode, narration and call edges are computed when a view first opens them, and ahead of time only for contracts that moved. | Opening a function is the acquire. Nobody pays for analysis of code they never look at, which matters on a change of thousands of lines. Part of the specification, not built yet. |
| **A cache with recorded reads.** Each record lists everything it read, including lookups that found nothing, and is valid only while all of those are unchanged. | An incremental update must equal a build from nothing, byte for byte, which is checked with random edits. Part of the specification, not built yet. |
| **One meaning per visual channel.** Colour shows role, from a colour-blind-safe palette. Height shows classes and functions per file, on a square-root scale. Stripes mark files with no language adapter. | People read only a few features at a glance, and each can carry one message ([research notes](docs/research/visual-understanding-for-review.md)). Stripes follow the rule that Rungs never guesses: what it cannot analyse is shown as exactly that. |

## Try it

From the repository root, with Node 22.18 or later and git:

```sh
npm ci
npm run rungs -- /path/to/a/git/checkout
```

This builds the graph, starts a local server on 127.0.0.1 and opens the city in your browser. Leave out the path to draw Rungs itself. `--port <n>` picks the port and `--no-open` skips the browser. Press R to reset the view and P to cycle the pixel-art render mode. Stop the server with Ctrl+C.

## Verification and design

Run `npm run lint`, `npm run typecheck` and `npm test`. CI runs the same three on every pull request. The tests cover:

- the extractor against a golden fixture, including the version ledger;
- qualified names over 2,070 adversarial inputs, checked to be unique and never empty;
- line counting with CRLF and Unicode line separators, from a single definition of a line;
- layout proportions, the height scale, and the label and fading decisions;
- a server that returns exactly a function's lines.

Larger features start from two independent design sketches on different models, and every pull request is reviewed by a second model against a stated contract before it merges. The browser behaviour is checked with scripted headless Chromium runs, including source text compared byte for byte against the file.

- [Specification](SPEC.md): the product contract and the rules every change is held to
- [ADR 0001: code node identity](docs/adr/0001-code-node-identity.md)
- [Research: how people read a picture at a glance](docs/research/visual-understanding-for-review.md)
- [Issues](https://github.com/DerekHertz/rungs/issues): the remaining work, in order
