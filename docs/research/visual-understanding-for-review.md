# How people read a picture at a glance, and what that means for Rungs

Research note, 2026-11-10. Prompted by the feedback that the repository picture is "just blocks/squares" and that, at a glance, you cannot tell what is going on. The focus is the base map: one snapshot of a repository that a newcomer can read in seconds. Pull request findings come later, as requirements the base map must meet for #9 and #10.

Every claim links to the source that owns it. Each design implication is marked **strongly supported**, **suggested** or **speculative**. Sources I could not read are listed in [Sources not reached](#sources-not-reached), and claims that rest on them are labeled.

## Summary

1. The picture reads as blocks because a squarified treemap encodes two things, size and nesting, and nesting is its weak part. The treemap's own authors say so ([Bruls et al. 2000](https://www.win.tue.nl/~vanwijk/stm.pdf), [Shneiderman's treemap history](https://www.cs.umd.edu/hcil/treemap-history/)).
2. At a glance, people read only a few visual features in parallel: hue, size, orientation, motion and a handful more. Each feature carries one message. A target defined by a combination of features needs slow, serial search ([Treisman & Gelade 1980](https://doi.org/10.1016/0010-0285(80)90005-5), [Healey](https://www.csc2.ncsu.edu/faculty/healey/PP/)).
3. Maps are legible because the layout matches the reader's mental model, regions are named, a few landmarks stand out, and the layout stays put. Developers expect a software map to follow package structure and are confused when it does not ([Kuhn, Erni & Nierstrasz 2010](https://arxiv.org/abs/1007.4303)).
4. Show two or three levels at a time, as framed and labeled regions. Treemap novices did well with 20 to 50 nodes over 1 to 3 levels and struggled with thousands over 5 to 7 ([treemap history](https://www.cs.umd.edu/hcil/treemap-history/)).
5. Give each channel one job. Area stays size. Hue carries one category with five values or fewer ([Healey 1996](https://www.cs.ubc.ca/sites/default/files/tr/1996/TR-96-10_0.pdf)). Luminance can carry one secondary number without hurting area reading ([Kong, Heer & Agrawala 2010](https://homes.cs.washington.edu/~jheer/files/treemaps.pdf)). One distinct mark picks out landmarks.
6. The circuit-board theme must not spend hue on decoration. Random hue variation breaks shape grouping ([Healey](https://www.csc2.ncsu.edu/faculty/healey/PP/)).
7. Area is a weak way to read exact quantities, and squares are the worst case ([Heer & Bostock 2010](https://homes.cs.washington.edu/~jheer/files/2010-MTurk-CHI.pdf)). Use area for "where is the bulk" and put numbers on hover.
8. A treemap hides relations. In an exploratory study of a software map inside the IDE, the call-graph overlay and search-result dispersion were what people used ([Kuhn, Erni & Nierstrasz 2010](https://arxiv.org/abs/1007.4303)).
9. Review research says understanding is the main cost and that reviewers want related changes grouped, not shown in directory order ([Bacchelli & Bird 2013](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/ICSE202013-codereview.pdf), [Barnett et al. 2015](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/barnett2015hdh.pdf), [Baum et al. 2017](https://tobiasbaum.github.io/rp/optimalordering.pdf)). The base map needs a stable layout and must be able to highlight groups that cut across folders.
10. Most software visualizations were never evaluated (62% of SOFTVIS/VISSOFT approaches, [Merino et al. 2018](https://scg.unibe.ch/research/softvis-eval)). Rungs should test the base map with a timed "what can you tell in 10 seconds" check on real repositories.

## 1. How people understand a scene at a glance

### 1.1 Preattentive features and their limits

Feature integration theory holds that simple features are registered early and in parallel across the whole visual field. Attention must then visit items one at a time whenever a target is defined by a conjunction of features ([Treisman & Gelade 1980](https://doi.org/10.1016/0010-0285(80)90005-5), abstract). Focused attention is the "glue" that binds features into objects.

Healey's survey of preattentive processing lists the features that pop out: orientation, length, width, closure, size, curvature, density, hue, intensity, flicker, direction and velocity of motion, 3D depth cues and others ([Healey, Perception in Visualization](https://www.csc2.ncsu.edu/faculty/healey/PP/)). Tasks done in under 200 to 250 ms, about one look, count as preattentive. The same survey records three limits that matter for Rungs:

- **Conjunctions are slow.** A red circle among red squares and blue circles is not found preattentively.
- **Features interfere, asymmetrically.** Random hue variation disrupts grouping by shape. Random shape variation does not disrupt grouping by hue. The survey advises giving the most important data attribute the most salient feature.
- **Seeing is not remembering.** Viewers do not build up a rich picture as they look. Details survive only where attention went, and change blindness means large changes go unnoticed across a blink, a saccade or a blank screen. Designers should direct the eye to what matters.

The full review by [Healey & Enns 2012](https://doi.org/10.1109/TVCG.2011.127) covers the same ground; I could read only its abstract ([publication page](https://healey.csc.ncsu.edu/publications/15783-attention-and-visual-memory-in-visualization-and-computer-graphics)).

How many hues can work at once? In Healey's colour study, 38 observers found a target among five distinct colours in parallel, with error near 2.5%. At seven colours, some targets (green, green-yellow) switched to serial search, and at nine, error rose to 8.1% ([Healey 1996](https://www.cs.ubc.ca/sites/default/files/tr/1996/TR-96-10_0.pdf), section 3).

### 1.2 Gestalt grouping

The century review of Gestalt grouping lists the classic principles (proximity, similarity, common fate, good continuation, closure, symmetry) and newer ones with experimental support ([Wagemans et al. 2012](https://ruccs.sas.rutgers.edu/images/archive/personal-manish-singh/papers/Wagemans_etal_2012_I.pdf)). Two matter most for a treemap:

- **Common region:** elements inside the same bounded area are grouped together.
- **Element connectedness:** elements that share a border are grouped together.

In a dense treemap these two pull against each other. Every leaf touches neighbours that may belong to a different parent, so connectedness groups across the boundaries that common region is trying to draw. That conflict is one reason a flat field of rectangles looks like "just blocks" (my inference from the two principles, not a tested claim).

### 1.3 Visual variables and how accurately each one reads

Bertin's *Semiology of Graphics* set out the visual variables (position, size, value, texture, colour, orientation, shape). I could not read the book; this list is labeled unverified here.

Cleveland & McGill ranked encodings by how accurately people judge quantities from them, with position best and area, volume and colour saturation lower ([Cleveland & McGill 1984](https://doi.org/10.1080/01621459.1984.10478080)). I could not reach the paper. Heer & Bostock replicated it on Mechanical Turk and found the same rough ranking ([Heer & Bostock 2010](https://homes.cs.washington.edu/~jheer/files/2010-MTurk-CHI.pdf)). They also tested rectangular area, as in treemaps:

- Rectangle area is judged about as accurately as circle area, which is to say less accurately than position or length.
- Aspect ratio matters, and comparing two squares was the worst case.
- A rectangle inside a treemap was judged no worse than one standing alone.

Kong, Heer & Agrawala then studied treemaps directly ([Kong et al. 2010](https://homes.cs.washington.edu/~jheer/files/treemaps.pdf), design guidelines section):

- Avoid extreme aspect ratios, but do not force perfect squares.
- Below a few hundred items, bar charts beat treemaps for accuracy. At thousands of items, treemaps are as accurate and faster (the transition was at 4,096 leaves).
- Treemaps beat bar charts when comparing non-leaf nodes, such as two folders.
- Luminance did not affect area judgments, so luminance can encode a second variable.

### 1.4 Overview first, zoom and filter, then details on demand

Shneiderman's mantra is "Overview first, zoom and filter, then details-on-demand" ([Shneiderman 1996](https://www.cs.umd.edu/~ben/papers/Shneiderman1996eyes.pdf)). The paper lists seven tasks. Rungs already covers overview, zoom and details on demand. Two are missing:

- **Relate:** view relationships among items.
- **Filter:** remove uninteresting items.

### 1.5 Tufte

Tufte's small multiples (the same frame repeated, so the eye compares only what differs) and data-ink (spend ink on data, not decoration) come from *The Visual Display of Quantitative Information* and *Envisioning Information* ([books](https://www.edwardtufte.com/books/)). I could not read the books. These ideas are labeled unverified, and no implication below rests on them alone.

### 1.6 Why maps are legible

Kuhn, Loretan & Nierstrasz point out that an atlas shows population, industry and trade on the same layout, so the reader correlates them freely. Software visualizations usually have layouts where "position and distance have no meaning," and the layout changes from one view to the next ([Kuhn et al. 2008](https://scg.unibe.ch/assets/archive/papers/Kuhn08bSoftwareMap.pdf)). They argue for one consistent layout under many thematic maps.

When they put such a map into an IDE and watched developers use it, the main results were ([Kuhn, Erni & Nierstrasz 2010](https://arxiv.org/abs/1007.4303), SoftVis 2010):

- Developers used the map most to see the **quantity and dispersion of search results** and to follow **call graphs** through an overlay.
- Developers expected the layout to follow **package structure**. A layout by topic "kept surprising them even after working with the map for almost two hours." Their implication: base the layout on code structure, and use other data to enrich it.
- **Isolated elements drew attention** whether or not they mattered.
- Elements must be **easy to discern and click**. A single zoom level made crowded clusters unreadable.
- Professionals skimmed code looking for "landmarks" such as constructors, signatures and field definitions.

Kevin Lynch's *The Image of the City* (paths, edges, districts, nodes, landmarks) is the classic account of why places are legible. The publisher page refused automated access, so I do not rely on it.

## 2. What software and change visualization research found

### 2.1 Treemaps

- **Origin.** Shneiderman built treemaps in 1990 to see where space went on a shared 80 MB disk ([treemap history](https://www.cs.umd.edu/hcil/treemap-history/), [Shneiderman 1992](https://www.cs.umd.edu/~ben/papers/Shneiderman1992Tree.pdf)). The question was "what is big", and treemaps answer it well.
- **Hierarchy is hard to see.** "Treemaps often fall short to visualize the structure of the tree. The worst case is a balanced tree" ([Bruls et al. 2000](https://www.win.tue.nl/~vanwijk/stm.pdf)). Squarifying makes the structure "somewhat harder to grasp," so Bruls et al. added shaded frames around groups. Cushion treemaps add ridged shading for the same reason ([van Wijk & van de Wetering 1999](https://www.win.tue.nl/~vanwijk/ctm.pdf)).
- **Novices need small trees.** New users needed 10 to 15 minutes to learn the layout. They did better with 20 to 50 nodes at 1 to 3 levels than with thousands at 5 to 7. WinSurfer users with 5,000 or more files at 7 or more levels were "often struggling to understand the layout" ([treemap history](https://www.cs.umd.edu/hcil/treemap-history/)).
- **Order and squareness trade off.** Squarified layouts give up alphabetical order. Ordered layouts give up some squareness (same source).
- **Stability under change.** Most treemap algorithms recompute the layout when data changes, so small edits can move many rectangles. Vernier et al. compared 14 algorithms on over 2,000 time-varying datasets and found that the best choice depends on how the data changes ([Vernier et al. 2020](https://arxiv.org/abs/1906.06014)).

### 2.2 Other software pictures

- **SeeSoft** draws each line of code as a thin row, coloured by a statistic such as age or author, so tens of thousands of lines fit on one screen ([Eick, Steffen & Sumner 1992](https://doi.org/10.1109/32.177365)). I saw only bibliographic records and the abstract. Its lasting idea is that a line-level picture is useful when colour carries one well-chosen statistic.
- **CodeCity** draws classes as buildings and packages as districts ([CodeCity page](https://wettel.github.io/codecity.html)). In a controlled experiment with 41 participants in four locations, it gave a statistically significant gain in task correctness and a drop in completion time against Eclipse plus a spreadsheet ([Wettel, Lanza & Robbes 2011](https://2011.icse-conferences.org/content/software-systems-cities-controlled-experiment.html), abstract only).
- **Software Cartography** is covered in 1.6. Its key lessons are a consistent layout, a structural base, and overlays for search and calls.
- **Gource** animates a repository's history as a growing tree with contributors moving among the files ([gource.io](https://gource.io/)). It shows activity, not structure or meaning.
- **CodeFlower** draws files as discs sized by line count in a force-directed tree ([CodeFlower](https://www.redotheweb.com/CodeFlower/)). Its author warns that large projects "will make your computer scream" and that `wc` counts comments and blank lines.

The pattern: pictures that encode one or two well-chosen facts on a meaningful layout get used. Pictures that are mostly shape and motion are striking but answer no question.

### 2.3 Change and comparison

Gleicher et al. found that every comparison design is built from three moves: **juxtaposition** (side by side), **superposition** (overlaid in the same space) and **explicit encoding** (compute the difference and draw it) ([Gleicher et al. 2011](https://doi.org/10.1177/1473871611416549); the categories are confirmed on [Gleicher's own page](https://pages.graphics.cs.wisc.edu/VisSnacks/papers/comparison), which recommends his [2018 follow-up](https://graphics.cs.wisc.edu/Papers/2018/Gle18/)). I did not read either paper in full.

Archambault, Purchase & Pinaud compared animation with small multiples for graphs that change over time ([2011](https://doi.org/10.1109/TVCG.2010.78)). I could not reach the paper or its abstract directly. A search-engine summary of the abstract says small multiples were faster on all tasks, animation had fewer errors when spotting additions, and preserving the mental map had little effect. Treat this as unverified.

Change blindness (1.1) argues against flipping between a "before" and an "after" picture and expecting the viewer to spot the difference. Explicit encoding avoids that.

### 2.4 Do developers use these tools, and why did many die?

- Merino et al. reviewed 181 SOFTVIS/VISSOFT papers and found 62% of the proposed approaches had no evaluation. They argue that adoption needs evaluation with the target audience on real systems ([Merino et al. 2018](https://scg.unibe.ch/research/softvis-eval), project page; the paper itself did not load).
- The Codemap study (1.6) shows the failure modes up close: a layout that did not match developers' mental model, elements too small to click, and isolated shapes that drew attention for no reason.
- I found no primary source that measures why individual tools were abandoned. Anything more specific would be speculation.

## 3. What reviewers struggle with

- **Understanding is the main challenge.** At Microsoft, reviewers named understanding the change, and the reason for it, as their hardest task ([Bacchelli & Bird 2013](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/ICSE202013-codereview.pdf), section VI). Only 14% of review comments were about defects. The authors tie that gap to understanding.
- **Descriptions are not enough.** One developer said "people can say they are doing one thing, while they are doing many more of them" (same source). This is the case for the "unmentioned" list.
- **Unfamiliar code is slow.** 91% of surveyed developers said reviewing files they do not know takes longer. One said that for a small change in unfamiliar code it is often necessary to read far more code than the change itself (same source). The base map is an orientation tool for exactly this reader.
- **Tools show only diffs.** All review tools the authors knew showed a highlighted diff "with no additional tool support" (same source).
- **Changes mix several purposes.** Engineers find a change easier to understand when it is split into sub-changes that match single issues, and they struggle to judge a change's risk to other components ([Tao et al. 2012](https://www.microsoft.com/en-us/research/publication/how-do-software-engineers-understand-code-changes-an-exploratory-study-in-industry/), abstract only). Up to 29% of 453 open-source changes were composite ([Tao & Kim 2015](https://hunkim.cse.ust.hk/papers/tao-msr2015.pdf)).
- **Group by relatedness, not by folder.** ClusterChanges grouped diff regions by def-use links. Over 40% of 1,000 Microsoft changesets split into more than one non-trivial group. In a study with 20 developers, 16 said the groups were correct and complete, and 16 found trivial groups easier to understand. One participant: "breaking things up into logical groups rather than just arbitrary directory order sounds like a big one for the reviewer" ([Barnett et al. 2015](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/barnett2015hdh.pdf), section V).
- **Ordering is mostly grouping.** Review tools sort changes by file path. Baum et al. found that "an optimal order is mainly an optimal grouping of the change parts by relatedness" ([Baum, Schneider & Bacchelli 2017](https://tobiasbaum.github.io/rp/optimalordering.pdf)). Principle 1: group related change parts as closely as possible. Principle 2: provide information before it is needed.
- **Agent-written changes.** In 567 Claude Code pull requests across 157 projects, 83.8% were merged, and 54.9% of those were merged without further change ([Watanabe et al. 2025](https://arxiv.org/abs/2509.14745), accepted at TOSEM). In 9,427 agent pull requests, peripheral developers were more likely to merge without running CI ([Cynthia, Das & Roy 2026](https://arxiv.org/abs/2601.20106), MSR '26).
- **Agent descriptions can be wrong.** Of 23,247 agent pull requests, 1.7% had a description that clearly disagreed with the code. Those were accepted far less often (28.3% against 80.0%) and took 3.5 times longer to merge. Among the inconsistent ones, the most common problem was describing changes that were never made (45.4%), followed by leaving out significant changes (22.0%) ([Gong et al. 2026](https://arxiv.org/abs/2601.04886), MSR '26).

## 4. Synthesis for Rungs

### 4.1 What the base map lacks today

Checked against the findings above, the current picture is a squarified treemap with area as line count, double-click zoom and a source panel.

- **One message only.** Area says "this is big." Nothing says what kind of code a region is, what it touches, or what depends on it. The eye has nothing to sort by, so every rectangle looks alike.
- **Weak hierarchy.** Leaves from different folders touch, and squarifying breaks visual order (Bruls et al., Wagemans et al.). A newcomer cannot see the package and folder skeleton in a few seconds.
- **Too many levels at once.** Showing every level down to functions puts thousands of small boxes on screen. That is the range where treemap novices struggled.
- **No names at a glance.** Without labels on regions, the reader cannot attach the picture to the words they already know.
- **No relations.** Imports, calls and effects exist in the graph but are invisible. Relate is the missing task in Shneiderman's list.
- **No landmarks.** Nothing marks entry points, exported surface or external effects, so there is nothing to orient by.

### 4.2 Base map: design implications

Each row is checked against SPEC. "Rule 3" means nothing drawn that is not a fact. "Rule 5" means never guess.

| # | Implication | Support | Evidence | SPEC check |
|---|---|---|---|---|
| B1 | Show two or three levels at a time. Children of the focused node are filled in, and grandchildren appear only as texture or not at all. Zoom moves the window down. | Strongly supported | Treemap novices did well at 1 to 3 levels ([history](https://www.cs.umd.edu/hcil/treemap-history/)); overview then zoom ([Shneiderman 1996](https://www.cs.umd.edu/~ben/papers/Shneiderman1996eyes.pdf)) | Fits. It is a view choice; nothing is added. |
| B2 | Draw each parent as a bounded region with a visible frame or gutter, and shade by depth, so common region beats connectedness. | Strongly supported | Common region and connectedness ([Wagemans et al.](https://ruccs.sas.rutgers.edu/images/archive/personal-manish-singh/papers/Wagemans_etal_2012_I.pdf)); frames and cushions ([Bruls et al.](https://www.win.tue.nl/~vanwijk/stm.pdf), [van Wijk 1999](https://www.win.tue.nl/~vanwijk/ctm.pdf)) | Fits. A frame styles the parent, which is a fact. |
| B3 | Label every region large enough to hold its name. Hide labels that do not fit; never shrink them into noise. | Suggested | Codemap users read class labels and needed discernible elements ([Kuhn et al. 2010](https://arxiv.org/abs/1007.4303)) | Fits. A name is a fact. Decide whether labels belong to the layout or the theme. |
| B4 | Keep the layout structural (package > folder > file), as now. Do not switch to clustering by topic or coupling. | Strongly supported | Developers expected package structure and were confused by topic layout ([Kuhn et al. 2010](https://arxiv.org/abs/1007.4303)) | Fits SPEC as written. |
| B5 | Give hue one job: one categorical property with five values or fewer, plus neutral. | Strongly supported (the limit); the property is an open question | Five colours searched in parallel, seven did not ([Healey 1996](https://www.cs.ubc.ca/sites/default/files/tr/1996/TR-96-10_0.pdf)) | The property must be derived. See Q1. |
| B6 | Use luminance or saturation for at most one secondary number, such as fan-in or number of exported symbols. | Suggested | Luminance does not disturb area judgments ([Kong et al. 2010](https://homes.cs.washington.edu/~jheer/files/treemaps.pdf)) | Fits if the number is a graph fact. |
| B7 | Keep area for size, but present it as "where is the bulk." Show exact line counts on hover, and use a bar or number list when comparing a few items. | Strongly supported | Area reads poorly, and squares worst ([Heer & Bostock 2010](https://homes.cs.washington.edu/~jheer/files/2010-MTurk-CHI.pdf)); bars win below a few hundred items ([Kong et al.](https://homes.cs.washington.edu/~jheer/files/treemaps.pdf)) | Fits. |
| B8 | Mark a small set of landmarks with one distinct feature that no other fact uses, such as an icon or outline. Candidates are modules with external effects, exported entry points, or unresolved calls. Never mark with a conjunction such as "red and small". | Suggested | Single features pop out; conjunctions need serial search ([Treisman & Gelade](https://doi.org/10.1016/0010-0285(80)90005-5), [Healey](https://www.csc2.ncsu.edu/faculty/healey/PP/)); professionals scan for landmarks ([Kuhn et al. 2010](https://arxiv.org/abs/1007.4303)) | Effects and unresolved calls are derived facts, and Rule 5 already asks to show unresolved calls as exactly that. See Q2. |
| B9 | Draw relations on demand. Selecting a region shows its import, call and effect edges to other regions, bundled at the current level. Do not draw all edges at once. | Suggested | Call-graph overlay was the most used part of Codemap ([Kuhn et al. 2010](https://arxiv.org/abs/1007.4303)); Relate task ([Shneiderman 1996](https://www.cs.umd.edu/~ben/papers/Shneiderman1996eyes.pdf)) | Edges are graph facts. SPEC Rule 4 already makes call edges lazy. |
| B10 | Support "highlight where X is": search a name and light up every match on the map, dimming the rest. | Strongly supported | Quantity and dispersion of search results was the map's clearest use ([Kuhn et al. 2010](https://arxiv.org/abs/1007.4303)); Filter task ([Shneiderman 1996](https://www.cs.umd.edu/~ben/papers/Shneiderman1996eyes.pdf)) | Fits. This is also the mechanism #10 needs (4.4). |
| B11 | The theme must not vary hue for decoration. Circuit traces, pads and chips can vary in shape and texture, but colour stays reserved for facts. | Suggested | Hue interferes with form grouping, not the reverse ([Healey](https://www.csc2.ncsu.edu/faculty/healey/PP/)); isolated or odd shapes draw attention regardless of meaning ([Kuhn et al. 2010](https://arxiv.org/abs/1007.4303)) | Directly supports Rule 3: a sprite that looks like a fact but is not one misleads. |
| B12 | Test the base map. Show a newcomer a real repository for 10 seconds, then ask: what are the main parts, which is biggest, what talks to the outside world, where would you start? Repeat for each theme change. | Suggested | Most software visualizations were never evaluated ([Merino et al. 2018](https://scg.unibe.ch/research/softvis-eval)); preattentive means about one look ([Healey](https://www.csc2.ncsu.edu/faculty/healey/PP/)) | Fits. It is a process, not a feature. |

### 4.3 Encodings to use and to avoid

Use:

- **Position** for structure. Nesting carries the hierarchy, and it is the most accurate channel (Cleveland & McGill via Heer & Bostock).
- **Area** for size, read roughly, with numbers on hover.
- **Hue** for one category, five values or fewer.
- **Luminance** for one secondary number.
- **One reserved mark** (icon, outline, or slow flicker for a transient highlight) for landmarks or alerts. Healey's survey lists flicker and motion as strong cues that draw attention.
- **Frames, gutters and depth shading** for hierarchy.

Avoid:

- Hue for decoration, or more than one hue scheme at once.
- Meaning carried only by a combination of channels, such as "dark red small boxes."
- Exact comparisons by area, especially between near-square boxes.
- Every level drawn at once.
- Animated before-and-after flips as the main way to show change. Change blindness says viewers miss the difference. Encode the difference instead.
- Layouts that move when unrelated code changes, if comparison (#9) is to work (see 4.4).

### 4.4 What the base map must make possible for #9 and #10

The overlay and panel are not being built yet, but the base map should not block them.

- **A stable layout.** An overlay superposes two trees, so a module that did not change should stay where it was. Consistent layout is the core cartography argument ([Kuhn et al. 2008](https://scg.unibe.ch/assets/archive/papers/Kuhn08bSoftwareMap.pdf)). How to buy stability is a known trade-off ([Vernier et al. 2020](https://arxiv.org/abs/1906.06014)). **Suggested.** The evidence that a preserved mental map helps is mixed (Archambault et al., unverified), so stability is a requirement of superposition more than a proven aid by itself.
- **Explicit encoding of change.** Draw "changed", "added" and "removed" as a computed difference on the map, not by flipping between snapshots ([Gleicher et al.](https://pages.graphics.cs.wisc.edu/VisSnacks/papers/comparison), change blindness in [Healey](https://www.csc2.ncsu.edu/faculty/healey/PP/)). Change kind then needs hue, so the base map's hue category must be able to step aside, for example by dimming to neutral in review mode. **Suggested.**
- **Highlight groups that cut across folders.** Reviewers want changes grouped by relatedness rather than directory ([Barnett et al.](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/barnett2015hdh.pdf), [Baum et al.](https://tobiasbaum.github.io/rp/optimalordering.pdf), [Tao & Kim](https://hunkim.cse.ust.hk/papers/tao-msr2015.pdf)). A def-use grouping is computable from the graph, so it is a derived fact. Keep the structural layout (B4) and show each group as a highlight across it, the same mechanism as B10. **Strongly supported** for the need; the mechanism is **suggested**.
- **Unmentioned must pop out.** One reserved preattentive feature, used for nothing else. The evidence: descriptions understate scope ([Bacchelli & Bird](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/ICSE202013-codereview.pdf), [Gong et al.](https://arxiv.org/abs/2601.04886)), and only single features pop out. **Strongly supported.**
- **Claimed but not found.** The most common agent description error is claiming changes that were not made (45.4% of inconsistent PRs, [Gong et al.](https://arxiv.org/abs/2601.04886)). SPEC's panel lists unmentioned changes but not claims that point at nothing. **Speculative** as a feature; see Q6.
- **Orientation for strangers.** Reviewers of unfamiliar code are slower and shallower ([Bacchelli & Bird](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/ICSE202013-codereview.pdf)). Agent PRs are often merged with little change and sometimes without CI ([Watanabe et al.](https://arxiv.org/abs/2509.14745), [Cynthia et al.](https://arxiv.org/abs/2601.20106)). A base map a stranger can read in seconds is what lets the overlay mean anything. **Suggested.**

### 4.5 Open product questions

1. **Which category gets hue?** Candidates that are derived facts: the kind of external effect a module has (network, process, file system, queue, timer, which is exactly five), exported against internal, or "no language adapter." Test, config and generated code are recognised by path convention. Is a convention a fact under Rules 3 and 5, or a guess?
2. **What is a landmark?** Modules with external effects, exported entry points, highest fan-in, unresolved calls? How many may show at once before they stop popping out?
3. **How many levels does the picture show at once,** and does that number change with zoom or stay fixed at two or three?
4. **Do labels belong to the layout or to the theme?** If to the layout, every theme shows the same names in the same places.
5. **Is the treemap stable across commits?** A stable algorithm costs some aspect-ratio quality. Decide before #9, because changing layout later moves everything.
6. **Should the review panel add "claimed but not found"** next to "unmentioned"? It would need claims that name paths or symbols, which SPEC already uses for mentions.
7. **Should the extractor compute def-use change groups** so the PR view can highlight related changes across folders?
8. **Is line count the right size?** Statements or non-blank, non-comment lines would stop comments and whitespace from inflating area. CodeFlower's author flags the same problem.

## Sources not reached

- **Bertin, *Semiology of Graphics*.** Book; not available to read. The variable list in 1.3 is labeled unverified.
- **Tufte, *The Visual Display of Quantitative Information* and *Envisioning Information*.** Books; the publisher page lists them but has no text. Small multiples and data-ink are labeled unverified, and no implication rests on them alone.
- **Lynch, *The Image of the City*.** The publisher page returned 403. Not used.
- **Cleveland & McGill 1984.** The full text timed out. The ranking is taken from Heer & Bostock's description and replication.
- **Healey & Enns 2012.** The PDF returned 404 or a bot check. Only the abstract was read; Healey's survey page carries the same claims.
- **Eick et al. 1992 (SeeSoft).** Paywalled; only bibliographic records and the abstract.
- **Wettel, Lanza & Robbes 2011 (CodeCity).** The PDF returned 404; only the abstract on the ICSE 2011 page. No effect sizes are given here for that reason.
- **Kuhn et al. 2010, JSME "Software Cartography".** Restricted. The WCRE 2008 paper and the SoftVis 2010 study were used instead.
- **Tao et al. 2012 (FSE).** The PDF returned 403; only the abstract on the Microsoft Research page.
- **Merino et al. 2018.** The PDF returned 503; only the project page.
- **Gleicher et al. 2011 and Gleicher 2018.** Papers not read; the three categories are confirmed on Gleicher's own page.
- **Archambault, Purchase & Pinaud 2011.** Blocked at HAL, PubMed and Glasgow; only a search-engine summary of the abstract. Labeled unverified.
- **Sadowski et al. 2018 (Google code review).** Only secondary summaries were found, so it is not cited.

## Sources

Perception and visualization

- Treisman, A. M., & Gelade, G. (1980). A feature-integration theory of attention. *Cognitive Psychology* 12(1), 97-136. [doi:10.1016/0010-0285(80)90005-5](https://doi.org/10.1016/0010-0285(80)90005-5). Read from a [course copy](https://www.cs.princeton.edu/courses/archive/spring08/cos598B/Readings/TreismanGelade1980.pdf).
- Healey, C. G. Perception in Visualization. [Author's survey page](https://www.csc2.ncsu.edu/faculty/healey/PP/).
- Healey, C. G. (1996). Choosing effective colours for data visualization. IEEE Visualization '96; [UBC TR-96-10](https://www.cs.ubc.ca/sites/default/files/tr/1996/TR-96-10_0.pdf).
- Healey, C. G., & Enns, J. T. (2012). Attention and visual memory in visualization and computer graphics. *IEEE TVCG* 18(7), 1170-1188. [doi:10.1109/TVCG.2011.127](https://doi.org/10.1109/TVCG.2011.127). Abstract only.
- Wagemans, J., et al. (2012). A century of Gestalt psychology in visual perception: I. *Psychological Bulletin* 138(6), 1172-1217. [Author copy](https://ruccs.sas.rutgers.edu/images/archive/personal-manish-singh/papers/Wagemans_etal_2012_I.pdf).
- Cleveland, W. S., & McGill, R. (1984). Graphical perception. *JASA* 79(387). [doi:10.1080/01621459.1984.10478080](https://doi.org/10.1080/01621459.1984.10478080). Not reached.
- Heer, J., & Bostock, M. (2010). Crowdsourcing graphical perception. CHI 2010. [PDF](https://homes.cs.washington.edu/~jheer/files/2010-MTurk-CHI.pdf).
- Kong, N., Heer, J., & Agrawala, M. (2010). Perceptual guidelines for creating rectangular treemaps. *IEEE TVCG* 16(6). [Author PDF](https://homes.cs.washington.edu/~jheer/files/treemaps.pdf).
- Shneiderman, B. (1996). The eyes have it: a task by data type taxonomy for information visualizations. IEEE Symposium on Visual Languages. [PDF](https://www.cs.umd.edu/~ben/papers/Shneiderman1996eyes.pdf).
- Gleicher, M., et al. (2011). Visual comparison for information visualization. *Information Visualization* 10(4). [doi:10.1177/1473871611416549](https://doi.org/10.1177/1473871611416549). Gleicher, M. (2018). Considerations for visualizing comparison. [Paper page](https://graphics.cs.wisc.edu/Papers/2018/Gle18/). [Author's summary page](https://pages.graphics.cs.wisc.edu/VisSnacks/papers/comparison).
- Archambault, D., Purchase, H. C., & Pinaud, B. (2011). Animation, small multiples, and the effect of mental map preservation in dynamic graphs. *IEEE TVCG* 17(4). [doi:10.1109/TVCG.2010.78](https://doi.org/10.1109/TVCG.2010.78). Not reached.

Treemaps and software visualization

- Shneiderman, B. (1992). Tree visualization with tree-maps: 2-d space-filling approach. *ACM TOG* 11(1). [PDF](https://www.cs.umd.edu/~ben/papers/Shneiderman1992Tree.pdf).
- Shneiderman, B. Treemaps for space-constrained visualization of hierarchies. [History page](https://www.cs.umd.edu/hcil/treemap-history/).
- Bruls, M., Huizing, K., & van Wijk, J. J. (2000). Squarified treemaps. [PDF](https://www.win.tue.nl/~vanwijk/stm.pdf).
- van Wijk, J. J., & van de Wetering, H. (1999). Cushion treemaps. InfoVis '99. [PDF](https://www.win.tue.nl/~vanwijk/ctm.pdf).
- Vernier, E., et al. (2020). Quantitative comparison of time-dependent treemaps. EuroVis 2020. [arXiv:1906.06014](https://arxiv.org/abs/1906.06014).
- Eick, S. G., Steffen, J. L., & Sumner, E. E. (1992). Seesoft. *IEEE TSE* 18(11). [doi:10.1109/32.177365](https://doi.org/10.1109/32.177365). Abstract only.
- Wettel, R., Lanza, M., & Robbes, R. (2011). Software systems as cities: a controlled experiment. ICSE 2011. [Abstract](https://2011.icse-conferences.org/content/software-systems-cities-controlled-experiment.html). [CodeCity page](https://wettel.github.io/codecity.html).
- Kuhn, A., Loretan, P., & Nierstrasz, O. (2008). Consistent layout for thematic software maps. WCRE 2008. [PDF](https://scg.unibe.ch/assets/archive/papers/Kuhn08bSoftwareMap.pdf).
- Kuhn, A., Erni, D., & Nierstrasz, O. (2010). Embedding spatial software visualization in the IDE: an exploratory study. SoftVis 2010. [arXiv:1007.4303](https://arxiv.org/abs/1007.4303).
- Kuhn, A., Erni, D., Loretan, P., & Nierstrasz, O. (2010). Software cartography: thematic software visualization with consistent layout. *JSME* 22(3). [Record](https://boris.unibe.ch/4952). Not reached.
- Gource. [gource.io](https://gource.io/).
- CodeFlower. [Project page](https://www.redotheweb.com/CodeFlower/).
- Merino, L., Ghafari, M., Anslow, C., & Nierstrasz, O. (2018). A systematic literature review of software visualization evaluation. *JSS* 144. [Project page](https://scg.unibe.ch/research/softvis-eval).

Code review

- Bacchelli, A., & Bird, C. (2013). Expectations, outcomes, and challenges of modern code review. ICSE 2013. [PDF](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/ICSE202013-codereview.pdf).
- Barnett, M., Bird, C., Brunet, J., & Lahiri, S. K. (2015). Helping developers help themselves: automatic decomposition of code review changesets. ICSE 2015. [PDF](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/barnett2015hdh.pdf).
- Tao, Y., Dang, Y., Xie, T., Zhang, D., & Kim, S. (2012). How do software engineers understand code changes? FSE 2012. [Abstract](https://www.microsoft.com/en-us/research/publication/how-do-software-engineers-understand-code-changes-an-exploratory-study-in-industry/).
- Tao, Y., & Kim, S. (2015). Partitioning composite code changes to facilitate code review. MSR 2015. [PDF](https://hunkim.cse.ust.hk/papers/tao-msr2015.pdf).
- Baum, T., Schneider, K., & Bacchelli, A. (2017). On the optimal order of reading source code changes for review. ICSME 2017. [PDF](https://tobiasbaum.github.io/rp/optimalordering.pdf).
- Watanabe, M., et al. (2025). On the use of agentic coding: an empirical study of pull requests on GitHub. Accepted at TOSEM. [arXiv:2509.14745](https://arxiv.org/abs/2509.14745).
- Cynthia, S. T., Das, J. K., & Roy, B. (2026). Are we all using agents the same way? MSR '26. [arXiv:2601.20106](https://arxiv.org/abs/2601.20106).
- Gong, J., Pinna, G., Bian, Y., & Zhang, J. M. (2026). Analyzing message-code inconsistency in AI coding agent-authored pull requests. MSR '26. [arXiv:2601.04886](https://arxiv.org/abs/2601.04886).
