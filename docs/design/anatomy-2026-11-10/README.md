# What is the anatomy of code? Session of 2026-11-10

This is a write-up of a design session, not a spec. Nothing here is built into Rungs, and nothing
in `SPEC.md` has changed. The SPEC wording is Derek's to write; section 7 lists the sentences it
needs.

## 1. Where it ended up

The question was how to fill the gap between the city (the whole repo) and the source lines.

The answer the session reached: the picture is a **pixel-art game world built from sprites**.

- The whole repo is a town on an island.
- A file is a building, and going inside it shows rooms and objects.
- The art is made once, as a sprite sheet. Every picture is then assembled from the code's facts,
  with no model and no 3D at that step.

Both test changes pass in the town view:

| Change | Picture | What it shows |
|---|---|---|
| docviz#9 (+48/-15, 4 files) | [detail](pictures/docviz9-detail.png), [whole town](pictures/docviz9-town.png) | Four cranes, one per changed file, each named |
| docviz#18 (+14,370, 144 files) | [far view](pictures/docviz18-far.png), [altered files](pictures/docviz18-altered.png), [fence and sign](pictures/docviz18-fence-and-sign.png) | Folders named with counts; 21 cranes on altered files; new folders fenced |

The inside of a file exists only as an earlier 3D sketch: [walls-down house](pictures/house-walls-down-3d.png).

## 2. What each thing means

| Repo | In the world | Chosen by this fact |
|---|---|---|
| Whole repo | A town on an island | The graph |
| Outside world | The sea | Nothing in the repo |
| Kinds of outside resource | Harbour structures: crane (process), mast (network), silos (file system), clock tower (timer) | Effect edges |
| Top-level folder | A named block of lots | Folder nodes |
| File | A building on a lot | File nodes |
| File's role | The kind of building: workshop (source), lab (tests), library (docs), shed (config), warehouse (generated), hut (unrecognised) | The role table |
| File's size | Storeys | Count of classes and functions |
| Function | A room | Function nodes |
| Exported function | A room with a door to the outside | The exported flag |
| What a function does | Objects in the room: terminal (process), cabinet (file system), hatch (loads code) | Effect edges |
| Source lines | What you read when you click | Source |

## 3. How a change shows

| Fact | Mark |
|---|---|
| A file that already existed was altered | Scaffolding over the building, a crane beside it, and its name |
| A file is new | Bare earth under the building; no crane and no name |
| A folder is mostly new | A construction fence around the block and a sign |
| Far zoom | Only folders are named, in large type, with counts ("tools · 93 new") |
| Near zoom | Altered files are named |
| A function changed (inside view) | Its room has a different floor and cones |
| An outside call changed (inside view) | Its object has a pink ring and the target's name |

## 4. Decisions Derek made, in order

| Question | His answer |
|---|---|
| What is an organ? | "most likely folder" |
| What makes something important? | What stops working if it stops |
| How is importance drawn? | The ground slab under a district |
| What counts as a way in? | Only what the repo declares |
| What does a mark for an outside call stand for? | The kind, with the target's name if changed |
| When is an outside call "altered"? | Only when the call itself changed |
| Is loading code its own kind of outside resource? | Yes |
| Are new files marked like altered ones? | No: marks and names are for files that already existed |
| How are layers shown? | Side by side (later set aside for the map, then the game world) |
| Is a function a room or a ride? | A room |
| Day or dusk? | Dusk |
| Does a model paint every picture, or the sprites once? | Sprites once |
| Outlines on sprites? | With outlines |
| How is a mostly-new folder marked far away? | Fence and sign |

The first four were decided before the picture became a town. How importance, the heart, the
brain and the appendix show in a town is open (section 6).

## 5. What was tried and set aside

| Idea | Why it was dropped |
|---|---|
| Roof fixtures on the existing 3D city | "not really showing the same kind of layered abstraction as an anatomical model" |
| Six flat layers side by side on the treemap | "the block/square representation is not informative enough. its easy to get lost" |
| A relief map with coasts | "its close but the visual component is not right" |
| 3D scenes from simple shapes | Too plain; Derek asked for higher definition, then shared Isometric SF |
| A model repainting every picture | It can add or drop objects, and two paintings of the same code may differ |

The facts behind the dropped pictures carried over: kinds of outside resource, "altered means the
call changed", quiet new files, and the sea as the outside world.

## 6. Open questions

1. **Importance in the town.** The slab was chosen for the old city. In a town it could be raised
   ground, a plinth, or the town square. Not decided.
2. **The brain and the appendix.** A declared way in, and a file nothing reaches, have no sprite
   or mark yet.
3. **"Mostly new".** The mockup fences a folder when more than half its files are new. That also
   fences a folder with one new file. The threshold is a placeholder.
4. **Nested folders.** Only top-level folders are blocks, so `tools` is one block of about 100
   buildings.
5. **The inside view in sprites.** Rooms, walls and objects are not on the sheet yet.
6. **Doors between rooms.** They need call edges, which the graph does not have.
7. **Tests.** Whether a test file's outside calls are ever marked or named.
8. **Identical buildings.** Source files of one size share a sprite. More variety needs more facts
   to choose by, or more sprites per kind.
9. **The existing city.** Whether it stays as a second theme or is replaced.
10. **The first SPEC rule.** "No model calls" holds at run time. Whether a model may ever paint
    sprites offline was discussed but not needed: Blender made them.

## 7. Sentences the SPEC needs, for Derek to write

Each line names what the sentence has to pin down. None is drafted.

- **The picture.** What the picture is now, and what happened to "the picture is a city".
- **The ladder.** What each zoom shows, from island to source lines.
- **Sprites.** That art is a sprite sheet made once and kept in the repo, and that a picture is
  assembled from facts and sprites only.
- **One sprite, one fact.** Which fact picks each sprite, and that nothing is drawn without one.
- **Change marks.** Altered, new, mostly-new folder; and what is named at each zoom.
- **Outside world.** The kinds, including "loads code", and when a call counts as altered.
- **Importance.** What it means, its unit (files, functions or folders), and that the number
  always comes with the list behind it.
- **Way in.** What is declared, and that an unreached file is never called dead.

SPEC sections this would touch: The picture, Review (Comparison), The graph (resource kinds),
Seams (Theme), and the "left for after the MVP" line that lists the house and map themes.

## 8. Draft issues, not filed

Each names the north-star question it moves.

| # | Issue | Moves |
|---|---|---|
| 1 | Record an altered outside call: same owner, resource and target, different arguments | Unmentioned |
| 2 | Add "loads code chosen at run time" as a kind of outside resource | Unmentioned |
| 3 | Keep the sprite sheet and its origin table in the repo; add the Blender script that makes it | Base map |
| 4 | Assemble the town from the graph and the sheet, replacing or beside the city | Base map |
| 5 | Mark altered files with scaffolding, a crane and a name; keep new files quiet | Unmentioned |
| 6 | Fence and sign a mostly-new folder | Unmentioned |
| 7 | Name folders at far zoom and files at near zoom | Base map |
| 8 | Draw a file's inside: rooms for functions, objects for outside calls | Contracts moved |
| 9 | Draw nested folders as blocks inside blocks | Base map |
| 10 | Read declared ways in from `package.json` | Base map |
| 11 | Compute "what stops if this stops" from import edges (needs existing issue #10) | Base map |

## 9. Side findings in today's Rungs

- **A new exported constant is not a contract move.** docviz#9 added `UNTRUSTED_GIT`; Rungs
  records only exported functions and classes.
- **Browser APIs fit no kind.** docviz#18 calls `chrome.*`, which the effect catalog does not know.
- **An argument change is invisible.** `diffEffects` compares owner, resource, operation and
  target, so docviz#9's `git` change shows nothing.

## 10. What is in this folder

| Path | What |
|---|---|
| `sprites/` | 24 sprites and `sprites.json`, which records each sprite's size and ground origin |
| `scripts/make_sprites.py` | Builds every model and renders the sheet in Blender |
| `scripts/town.mjs`, `scripts/town-page.js` | Assemble a town from a running Rungs server and the sheet |
| `scripts/crop.mjs` | Cuts or shrinks a picture |
| `pictures/` | The pictures linked above, and two pages to scroll the towns at full size |

To render the sheet again, from WSL:

```bash
"/mnt/c/Program Files/Blender Foundation/Blender 5.2/blender.exe" -b --factory-startup --python "$(wslpath -w scripts/make_sprites.py)" -- "$(wslpath -w sprites)"
```

The scripts are mockups. They were written to test the idea and have no tests. `town.mjs` expects
the sheet in a `town/` folder beside it, reads a Rungs server on a local port, and uses the
Playwright installed in the docviz checkout.

## 11. What the mockups do not prove

- The altered calls and the "loads code" kind in the inside view were added by hand.
- Layout is a simple packing of blocks. Whether it stays put between commits is untested.
- The full docviz#18 picture is 8393×4386 pixels. A real viewer needs pan and zoom; the mockups
  are still images.
- Only docviz was drawn.
