# Systems to Streets: founding spec

Settled 2026-11-09. Nothing is built yet. This page is the contract the first code is written to.

## What it is

Systems to Streets draws a codebase as a pixel-art picture you zoom into, from the whole system
down to source lines. Everything drawn is computed from the code. It exists so a person can
approve large, agent-written changes the way they would approve a design, without reading every line.

A reviewer needs three answers to say yes or no: what the change claims to do, what it touches
that nobody mentioned, and which contracts moved.

## North star for the MVP

You run one command on a real agent-written change and decide to approve or reject it in 15
minutes, without opening a diff, starting from what could break. Anything on screen that you
doubt, you can click through to the source lines that produced it.

The test case is pull request #14 of the previous project: 851 added lines in 8 files of plain
JavaScript, small enough to judge by hand, so the page can be checked against that judgement. A
change that a person cannot judge at this size will not be judged at 10,000 lines; pull request
#18 (14,370 lines) comes after.

Left for after the MVP: property nodes, lazily resolved edges, and links between effect sites.

## The levels

Each level is computed from the one below it. Only the graph is stored; the rest are views.

| Level | Computed from | What the reviewer sees |
|---|---|---|
| Source | A file tree: a commit, or a checkout with uncommitted changes | The lines |
| Graph | Source, by the extractor | Nothing directly. Every level above is a view of it |
| Pseudocode | One function's control structure, through a fixed template | An outline of the function, each line linked to its source lines, rendered when the function is opened |
| Logic | The graph | Each module's interface; each function's case form (`guard ⇒ outcome`); properties written in the repo |
| Picture | The graph, assembled as a town from a sprite sheet (see The picture) | The whole repo first, then folder, file, function |

## Rules

1. **One writer.** The extractor is the only module that writes graph facts. It is deterministic,
   makes no model calls, and is a pure function from a file tree to a graph.
2. **Four tiers, never mixed.** *Derived* facts come from the extractor. *Observed* facts are
   recorded from one run of one tree (test results first). *Claimed* facts come from people and
   agents (descriptions, narration). *Judged* facts are a classifier's answer to a typed question
   about two things already on the page, recorded with the question, what it was shown, its
   probability and the threshold used. Observed, claimed and judged facts attach to graph nodes
   and can never create or change one. The tiers are stored apart and drawn differently.
3. **Nothing is drawn that is not a fact.** A theme may style a fact but may not add an object.
4. **Lazy.** Pseudocode, narration and call edges are computed when a view needs them.
5. **Never guess.** An unresolved call, an effect with an unknown target and a file with no
   language adapter are each shown as exactly that.

## The graph

- **Nodes:** modules at five nested levels (package, folder, file, class, function), plus
  external resources (network, process, file system, queue, timer, and code loaded at run time).
  Code loaded at run time is a `require` or `import()` whose target is not a literal, or a
  `createRequire`.
- **Sections:** a Markdown file has one section per heading, nested by heading level and pinned to
  its lines. A section has a name and lines, and no edges.
- **Dependencies** are what `package.json` declares in `dependencies`, `devDependencies`,
  `peerDependencies` and `optionalDependencies`: each one's name, the range written and its list.
  They are read from `package.json` only, never from a lockfile.
- **Edges:** calls, imports, type references and effects, each pinned to file and line ranges.
  An import edge also records the export names it takes and, for `export ... from`, the names it passes on.
- **Effects** are found with a hand-maintained catalog of declarations, starting with the
  runtime's built-ins and versioned with the extractor.
- **An altered effect** is one whose call kept its owner, resource and target but whose own
  text changed: its arguments. A change around the call never alters it.
- **Links between effect sites** exist only when both ends resolve to the same symbol, literal
  or file.
- **Identity** is (level, path, qualified name). A moved module is paired only when its body is
  identical.
- **Properties** are invariants written in the repo that name a symbol: assertions, runtime
  schemas, specification files. Systems to Streets records and links them. It does not prove them.
- **Generated files** (lockfiles, to start) stay in the graph, marked generated with their true
  line count. The picture gives them a small fixed size so they never crowd out written code.
- **Role** of a file is one of source, tests, config and build, docs or generated, from a fixed,
  versioned table of path conventions. A file the table doesn't recognise has no role and is
  drawn neutral, never guessed.
- **Ways in** are only what the repo declares: the files `package.json` names in `main`, `bin`,
  `exports` and its scripts, and test files.
- **Importance** of a module is what stops working if it stops: everything that rests on it
  through import edges, directly or indirectly. The number is always shown with the list behind
  it. A code file (one a language adapter analyses) that no way in reaches is shown as "nothing reaches it", never called dead; other files are never shown that way.

## Vocabulary

A term is a word the repository uses for one of its concepts, taken from its headings, folders,
exported names and tests, and pinned to those lines. Where these cover too little of the code, a
model may propose terms, shown as claimed. Whether a module belongs to a term is judged. A module
may belong to several terms or none. The vocabulary is stored apart from the graph and is marked
drafted until a person certifies it.

## The picture

The picture is a town on an island, in isometric pixel art at dusk. The town is the repo, and the
sea is everything outside it. The camera looks from one fixed isometric angle; it pans and zooms,
and never changes the layout.

- **Blocks.** Each top-level folder is a block of lots with its name, and a folder inside it is a
  smaller block within that block. Every file has a lot of the same size, and a block's lots are
  a grid in path order. Blocks are packed in rows, largest first. A file's line count does not
  show in its lot.
- **Buildings.** Each file is a building on its lot. Its kind is the file's role: a workshop for
  source, a lab for tests, a library for docs, a shed for config and build, a warehouse for
  generated files, and a hut for a file with no role. Its size is its count of classes and
  functions, in a few steps on a square-root scale between the repository's smallest and largest.
- **Plinths.** A building stands on a stone plinth whose height is its file's importance, in a
  few steps on a square-root scale, from none for a file nothing rests on. Pointing at a plinth
  lists the files that rest on it.
- **Gates.** A file the repo declares as a way in has a gate at the front of its lot. Test files
  are ways in too, but the lab already says so, and they get no gate.
- **Paths.** A footpath runs from the road to each building's door. A code file no way in
  reaches through imports has no path, which shows "nothing reaches it" and never calls it dead;
  other files always have one.
- **Harbour.** Each kind of outside resource the code reaches is one structure in the harbour,
  and a kind nothing reaches has none.
- **Names by zoom.** From far away only blocks are named, in large type. Closer in, files are named;
  under a comparison, only altered files are. Names are never hidden by buildings.
- **Inside a file.** Double-clicking a building opens it with its walls down. Each function is a
  room, an exported function's room has a door to the outside, and each outside call is an object
  in its room, its kind shown by the object. Esc or the trail leaves it.

Anything shown can be clicked through to the source lines that produced it.

## Review

A comparison between two trees is an overlay on the picture, switched on by default for a pull
request.

**Comparison.** Under `streets compare <base>`, a changed file is one of four kinds: added,
altered, removed or moved. Moved means identical text under a new path, never a guess.

- An altered file is under scaffolding with a crane beside it, and is named.
- An added file stands on bare earth, with no crane and no name, so a large new area does not
  bury the altered files.
- A block where more than half the files are added, counting its nested folders, has a
  construction fence and a sign with its counts ("tools · 93 new").
- A removed file leaves rubble on its lot. A moved file leaves rubble with a sign naming its new
  path, and stands at its new place with no crane.
- A test file in which the change removed, weakened or newly skipped a test has a hazard banner on
  its lab; a base test file the change edited has a violet flag. Inside a file, the room of a
  weakened or newly skipped test has a hazard floor and sign. A block holding marked test files adds
  their count to its sign ("test · 2 new · 2 altered · ⚠ 2 tests changed"), counting its nested
  folders. Each mark comes from the same derived facts as the Tests row, and is shown with or
  without a test run.
- A dependency is added, removed or changed (its range or its list). The picture does not show
  dependencies; the panel does.
- Inside a file, a changed function's room has a different floor and cones, and an altered or
  new outside call has a ring and the name of its target. An outside call is named only in a file
  that already existed.

**Risks.** The panel opens on risks, ranked by what could break, all derived:

1. Contracts moved, each with its blast radius: the files that rest on that export through import
   edges, directly or indirectly, counted, with the list behind the number. An import edge records
   the names it takes (named, default, all for `* as ns`, none for a side-effect import), so a
   changed export counts the files that import that name, or all of the file, directly or through
   re-exports, and the files resting on those. A use the extractor cannot name counts as all.
2. New or changed effects that reach a process, the file system or the network, by target.
3. Tests weakened, removed or skipped, and base test files the change edited.
4. Dependency changes.

Within each kind, a larger blast radius comes first. A selected file says why it matters before
its lines: its contracts moved, how many files rest on it, its new effects and whether a test
reaches it. It lists its defining blocks first: the changed functions, methods and classes that
are exported, moved a contract, gained or changed an effect, or have the most dependents, then
other changed blocks. Imports, unchanged code and unnamed callbacks fold under their holder. In the
source, the lines of defining blocks are open and the rest collapsed. A block's callers and
callees, in the file or beyond it, start collapsed and open one step at a time. A summary written
by an agent may sit beside the risks, claimed, never in their place. A judged mark may sit beside
a risk, saying how sure a classifier is that it matters; it never reorders or removes one.

A panel answers the three questions, and each entry selects places on the picture. It shows one summary row per question, number first ("Claims: 10 of 13 linked", "Tests: 23 fail of 210"); one row is open at a time and takes the column's height. Each item is one line, with detail when selected. Explanations and run details sit under "About this run", except the tests' evidence caveat, which stays one hover or click from the Tests row:

- **Claims:** the change's description, shown as claimed.
- **Unmentioned:** changed modules, edges, dependencies and sections no claim covers, new effect
  edges first, then dependency changes. A change counts as mentioned when its path or name appears
  in the description; a dependency by its name, a section by its heading. A changed Markdown file
  lists its changed sections, each with its added and removed lines. A lockfile's change is listed
  under the dependency changes it follows, and on its own only when no dependency changed. A
  package.json whose parsed text differs from its base only inside the four dependency lists
  (formatting and key order aside), every such change mentioned, counts as covered like its
  lockfile; any other change, or text that does not parse, keeps it listed. A
  change only an agent links stays in the count, as "linked by the agent only", so the row never
  reads "nothing" on an agent's word. An agent's link to a folder covers none of its files.
- **Contracts moved:** every change to an exported signature, type, case, effect set or linked
  property.

**Observed.** `streets compare <base> --run-tests` runs tests once, never by default, because a
test has to run the change's code and that code is untrusted. The tests that count as evidence
are main's, not the change's: the base's test files run against the head's code, with the base's
`test` script deciding the runner, so a change cannot loosen, delete or skip a test to make it
pass. In the sandbox those files are mounted read-only. A base test file the change deleted still
runs, and is shown as deleted by this change. Test files the change wrote or edited run apart and
are shown as "written by this change", claimed, never as evidence. What the change did to the
tests is also read from the two trees, without running anything, and listed under Tests:
test files deleted, tests removed by name, `.skip`, `.todo` or `.only` added, fewer or looser
assertions. A removed test and an added test that are the only ones lost and gained in one describe
path, with known bodies that are the same or at the same place, are one renamed test, not a removal;
it is still weakened if it asserts less. Anything unclear stays removed.

Even main's tests import the head's code, which can fake an outcome from inside the test process.
Observed results are evidence against mistakes, not against a hostile author, and the page says so
beside them.

The run is in a sandbox (bubblewrap): a temporary copy of the tree, no network, none of the user's
files, a stripped environment, a wall-clock limit. The network and the tree's code are never
together. Dependencies are fetched first, with the network, by npm alone in a folder that holds
only two files Systems to Streets wrote: the dependencies asked for and the lockfile's entries. npm reads no
settings from the tree, the user or the environment, runs no script, and has no git. Every
lockfile entry must be a registry tarball with a sha512 hash; a git, file, link, folder or
other-server dependency refuses the run. An npm alias to a registry package is allowed. The
installed packages then move into the copy and the tests run with no network. What the run leaves
behind is read as plain files under their expected names, never followed as links.

`node --test` reports into an open file with no name, which in the sandbox only the runner's
process can reach, and a test script whose flags would load the tree's code into the runner is
unsupported. Whatever the results came through, they are checked against the runner's exit code
and the test files the run was given; a run that fails a check is shown as "results
unreliable" with why, and none of its results is shown.

Only `node --test` is run. Any other runner is named as unsupported, and a vitest project shows
"tests not run: vitest is chosen by the PR", because the change installs vitest at a version and
with a config it picks. Each result attaches to its test function by file and name; a result no
single test function matches is listed, never dropped. With no sandbox the run is refused, and the
page says so, unless `--run-tests-unsandboxed` is given; its results are then labelled "ran without
a sandbox: as trustworthy as the PR's author".

**Walkthrough.** On request, an agent tours the change as an ordered list of stops. A stop points
at changed modules of the comparison, names the claims it says it fulfils, and narrates in
sentences, each anchored to lines of one of its modules. Whatever points nowhere is dropped and
counted. The agent sees names, signatures, line ranges and effect labels, never source text. At
each stop the reviewer reads four things side by side: what the description expects (claimed),
what the agent says (claimed), the source lines with the contract moves and new effect edges there
(derived), and what a run recorded (observed, "not run" until one is). What the narration leaves
out of the derived facts is noted by code, never by the agent.

Narration in plain English sits beside the pseudocode as a claimed fact, anchored to the lines it
describes and marked stale when the function changes. It is written on request, and ahead of
time only for functions in "contracts moved".

**Judged.** A judged check compares two things that already exist and returns a probability. It
writes no text. A threshold, chosen by the change's complexity and stakes from the reviewer's
table, turns the probability into settled, flagged or undecided. A settled item folds to one line
and stays in its count; nothing judged ever removes a derived fact. Clicking a judged mark shows
the question, what the classifier was shown and its answer. A check ships only after a test on
known cases, and its rate of wrong passes is shown beside it. Without a classifier the page shows
"not judged". Judged checks send source text to a hosted model and are off unless the reviewer
turns them on.

## Seams

| Seam | Interface | First adapter | Next |
|---|---|---|---|
| Language | Files of one language in, nodes and edges out | JavaScript and TypeScript, using the TypeScript compiler | Undecided |
| Theme | "What does this fact look like at this zoom, in this state" | Town | Circuit board |

A theme is data: a table from graph concepts to sprites, plus a sprite sheet. Each sprite is
chosen by one fact, and nothing is drawn without one. The sheet is made once, offline, by a script
kept in the repo, and the sheet itself is kept in the repo too. A picture is assembled from graph
facts and sprites only, with no model and no 3D at that step. All themes share one layout, so
switching theme moves nothing.

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
graph. `streets setup` builds a repository's vocabulary and stakes once, and stores them with the
cache.

## Parked

Topology from declared config. Recorded traces. A "changed since I last reviewed" overlay.
Symbol-level cache dependencies. More language adapters. A pull request comment as a second
surface. Proving code against a specification.

## Working agreement

A change to this repo stays small enough to review comfortably. No code is carried over from the
previous project.
