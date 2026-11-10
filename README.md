# Rungs

Rungs is a work-in-progress tool for reviewing large, agent-written changes without reading every line. Coding agents now open pull requests of thousands of lines, and a reviewer has to decide whether to merge them. Reading the diff does not scale, and a summary written by the same agent is a claim, not evidence. Rungs computes a picture of the code itself, a city you can turn and zoom into, where every building is a file and anything you doubt opens the exact source lines behind it.

![Rungs' own repository drawn as a code city: districts for src, test and docs, buildings coloured by role and sized by line count, with floating district names.](docs/media/city.png)

*Rungs drawing its own repository. Blue buildings are source, green are tests, yellow are docs, dark blue is config and orange is generated. Height is the number of classes and functions in a file. Striped buildings are files Rungs cannot analyse yet.*

**The goal.** Run one command on a real agent-written change of 10,000 lines or more, and decide to approve or reject it in 15 minutes without opening a diff. The test case is a 14,370-line pull request of plain JavaScript. Rungs does not reach that yet: it draws one version of a codebase today, and the comparison overlay and review panel that answer "what changed, what did nobody mention, and which contracts moved" are the next tickets ([#9](https://github.com/DerekHertz/rungs/issues/9), [#10](https://github.com/DerekHertz/rungs/issues/10)).

## How it works

1. **Read the checkout.** Rungs lists the files git tracks plus untracked ones not ignored, and reads them from the working tree, so uncommitted changes are included. A symlink reads as its target path, the way git stores it, so nothing outside the checkout leaks in.
2. **Extract a graph.** A pure, deterministic function turns the file tree into a graph of packages, folders, files, classes and functions, each with a line range and a role (source, tests, config, docs or generated). JavaScript and TypeScript go through the TypeScript compiler. No model is called.
3. **Lay out a ground plan.** A squarified treemap places every package, folder and file. The layout depends only on the graph, so the camera and the theme never move anything.
4. **Draw a city.** Districts are raised plates and files are buildings, rendered with three.js. Drag to pan, right-drag to turn, scroll to zoom, double-click a district to fly to it. Click a building to read its source, served from the same snapshot the graph came from.

## Engineering decisions

| Decision | Why |
| --- | --- |
| One writer: the extractor is a pure function with no model calls | Every fact on screen can be recomputed and checked. A golden graph and an append-only version ledger make the build fail if extractor output changes without a version bump. |
| Identity is (level, path, qualified name), never a line number | A function keeps its identity when code above it moves, which is what lets two versions of a repository be compared. The naming scheme is provably collision-free and is recorded in [ADR 0001](docs/adr/0001-code-node-identity.md). |
| Language adapters describe, the extractor names | Adapters return an outline of declarations with character offsets. Only the extractor assigns ids and line numbers, so a new language cannot break identity. |
| One definition of a line | The TypeScript compiler also breaks lines at U+2028 and U+2029, which would put a range one line off. Line counts, ranges and the source panel all come from one module, so "exactly its lines" holds by construction. |
| One meaning per visual channel | Colour shows role only, with five values from a colour-blind-safe palette. Height shows functions per file on a square-root scale, so one outlier cannot flatten the rest. Stripes mark files with no language adapter, because the spec says never to guess. These follow published work on what people read at a glance. |
| Orthographic camera on a fixed ground plan | Perspective makes equal sizes look unequal. Orthographic projection keeps them comparable from any angle, and the layout never changes when the camera does. |
| Two designs before code, a second model reviews every PR | Larger features start from two independent design sketches on different models. Every pull request is reviewed by a different model against a stated contract before it merges. |

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
- line counting with CRLF and Unicode line separators;
- layout proportions, the height scale, and the label and fading decisions;
- a server that returns exactly a function's lines.

The browser behaviour was checked during development with scripted headless Chromium runs, including source text compared byte for byte against the file. There is no automated browser suite yet.

The 15-minute review goal is untested, because the comparison and review features it depends on are not built. Rungs has only been run on small repositories so far, and only under software rendering.

- [Specification](SPEC.md): the product contract, with rules every change is held to
- [ADR 0001: code node identity](docs/adr/0001-code-node-identity.md)
- [Issues](https://github.com/DerekHertz/rungs/issues): the remaining work, in order
