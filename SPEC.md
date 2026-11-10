# Rungs: founding spec

Settled 2026-11-09. Nothing is built yet. This page is the contract the first code is written to.

## What it is

Rungs draws a codebase as a pixel-art picture you zoom into, from the whole system down to source
lines. Everything drawn is computed from the code. It exists so a person can approve large,
agent-written changes the way they would approve a design, without reading every line.

A reviewer needs three answers to say yes or no: what the change claims to do, what it touches
that nobody mentioned, and which contracts moved.

## North star for the MVP

You run one command on a real agent-written change of 10,000 lines or more and decide to approve
or reject it in 15 minutes, without opening a diff. Anything on screen that you doubt, you can
click through to the source lines that produced it.

The test case is pull request #18 of the previous project: 14,370 added lines of plain
JavaScript.

Left for after the MVP: property nodes, the house and map themes, lazily resolved edges, and links between effect sites.

## The rungs

Each rung is computed from the one below it. Only the graph is stored; the rest are views.

| Rung | Computed from | What the reviewer sees |
|---|---|---|
| Source | A file tree: a commit, or a checkout with uncommitted changes | The lines |
| Graph | Source, by the extractor | Nothing directly. Every rung above is a view of it |
| Pseudocode | One function's control structure, through a fixed template | An outline of the function, each line linked to its source lines, rendered when the function is opened |
| Logic | The graph | Each module's interface; each function's case form (`guard ⇒ outcome`); properties written in the repo |
| Picture | The graph, drawn as a city (see The picture) and a theme | The whole system first, then package, folder, file, class, function |

## Rules

1. **One writer.** The extractor is the only module that writes graph facts. It is deterministic,
   makes no model calls, and is a pure function from a file tree to a graph.
2. **Three tiers, never mixed.** *Derived* facts come from the extractor. *Observed* facts are
   recorded from one run of one tree (test results first). *Claimed* facts come from people and
   agents (descriptions, narration). Observed and claimed facts attach to graph nodes and can
   never create or change one. The tiers are stored apart and drawn differently.
3. **Nothing is drawn that is not a fact.** A theme may style a fact but may not add an object.
4. **Lazy.** Pseudocode, narration and call edges are computed when a view needs them.
5. **Never guess.** An unresolved call, an effect with an unknown target and a file with no
   language adapter are each shown as exactly that.

## The graph

- **Nodes:** modules at five nested levels (package, folder, file, class, function), plus
  external resources (network, process, file system, queue, timer).
- **Edges:** calls, imports, type references and effects, each pinned to file and line ranges.
- **Effects** are found with a hand-maintained catalog of declarations, starting with the
  runtime's built-ins and versioned with the extractor.
- **Links between effect sites** exist only when both ends resolve to the same symbol, literal
  or file.
- **Identity** is (level, path, qualified name). A moved module is paired only when its body is
  identical.
- **Properties** are invariants written in the repo that name a symbol: assertions, runtime
  schemas, specification files. Rungs records and links them. It does not prove them.
- **Generated files** (lockfiles, to start) stay in the graph, marked generated with their true
  line count. The picture gives them a small fixed size so they never crowd out written code.
- **Role** of a file is one of source, tests, config and build, docs or generated, from a fixed,
  versioned table of path conventions. A file the table doesn't recognise has no role and is
  drawn neutral, never guessed.

## The picture

The picture is a city. Its ground plan is a squarified treemap of the graph: packages and folders
are districts, files are buildings on their lots. The camera is orthographic. It pans, zooms and
turns around the vertical axis, with its tilt held between a low and a steep angle, and it never
changes the layout. Colour means one thing, a file's role. Height means one fact, the number of
classes and functions in a file, on a square-root scale between the repository's smallest and
largest, with a visible minimum. Names float above the city and are never hidden by buildings,
and buildings in front of the one you point at fade.

- Double-clicking a building enters it: the file becomes its own city, with its classes and
  functions as buildings on a ground plan rooted at that file. Esc or the trail leaves it.

## Review

A comparison between two trees is an overlay on the picture, switched on by default for a pull
request.

**Comparison.** Under `rungs compare <base>`, brightness means changed: unchanged files are dimmed and changed files keep full colour, so colour still means role. A changed file is one of four kinds: added (white roof), altered, removed (a see-through ghost where it stood), or moved (grey roof). Moved means identical text under a new path, never a guess.

A panel answers the three questions, and each entry selects places on the picture:

- **Claims:** the change's description, shown as claimed.
- **Unmentioned:** changed modules and edges no claim covers, new effect edges first. A change
  counts as mentioned when its path or name appears in the description, or an agent links it.
- **Contracts moved:** every change to an exported signature, type, case, effect set or linked
  property.

**Observed.** `rungs compare <base> --run-tests` runs the head tree's tests once, never by
default, because they are the change's own untrusted code. They run in a sandbox (bubblewrap): a
temporary copy of the tree, no network, none of the user's files, a stripped environment, a
wall-clock limit. Dependencies install from the lockfile with the network and with install scripts
off; the tests then run with no network. The runner is read from the `test` script, `node --test`
or vitest; any other is named as unsupported. Each result attaches to its test function by file
and name; a result no single test function matches is listed, never dropped. With no sandbox the
run is refused, and the page says so, unless `--run-tests-unsandboxed` is given.

Narration in plain English sits beside the pseudocode as a claimed fact, anchored to the lines it
describes and marked stale when the function changes. It is written on request, and ahead of
time only for functions in "contracts moved".

## Seams

| Seam | Interface | First adapter | Next |
|---|---|---|---|
| Language | Files of one language in, nodes and edges out | JavaScript and TypeScript, using the TypeScript compiler | Undecided |
| Theme | "What does this fact look like at this zoom, in this state" | City | Circuit board, house, map |

A theme is data: a table from graph concepts to sprites, plus a sprite sheet. All themes share
one layout, so switching theme moves nothing. The pixel-art look is a render mode of the city,
not a separate theme.

## Cache

- Per-file records of three kinds: syntax, interface, resolved edges.
- Every record lists what it read, including lookups that found nothing, and is valid only while
  all of those are unchanged.
- Records depend on whole files. Syntax records are built for the whole repo up front; call and
  type edges are resolved for the region being viewed or compared.
- Guards: an incremental update must equal a build from nothing, byte for byte, over random
  edits; a verify mode rebuilds and compares on demand; extractor output cannot change without a
  version bump; a change to configuration or a global declaration rebuilds everything.
- The cache is plain files outside the repo and can be deleted at any time.

## Surface

A local command builds or updates the graph for the checkout it runs in. A second compares
against a base. Both open a local page. Agents call the same commands and cannot write to the
graph.

## Parked

Topology from declared config. Recorded traces. A "changed since I last reviewed" overlay.
Symbol-level cache dependencies. More language adapters. A pull request comment as a second
surface. Proving code against a specification.

## Working agreement

A change to this repo stays small enough to review comfortably. No code is carried over from the
previous project.
