# Neo Rich: the HUD drawn in cells (design round 6)

Date: 2026-11-15. Status: design only, nothing is built. It gives Neo (`neo-design.md`) a rich form; HUD v2's grid, keys, commands and features are unchanged.
Mocks: 21 `Rich*.dc.html` boards in `…/scratchpad/mcstyles/project/`, made by `…/scratchpad/gen-rich.js` (screenshots in `…/scratchpad/rich-preview/`, taken by `shot-rich.sh`).
The generator models each surface as terminal cells. It exits 1 when a row is too wide, two things share a cell, text touches text, a grid row starts off a stop, a Raster leaves its box or overlaps another, a Raster cell needs more than two colours or mixes glyph kinds, a Braille cell needs two colours, a Raster holds over 1024 colour pairs, a Button overlaps a Raster, or two blank rows meet. All boards pass and were checked as screenshots.
The product name is on no board.

## What the API allows (type file, checked)

- `Raster` is on the **terminal surface only** (`Elements`, TF 4101). The desktop app, the VS Code extension and mobile have `Svg` and no Raster; a tree with a Raster is refused there. Ask `$.ui.resolve(e)` for the table before drawing one.
- A Raster is a fixed box (up to 512 × 256 cells, `key` required). A cell is **one width-1 BMP glyph, one foreground and one background** (`0x00RRGGBB`, or `0x01000000` for the terminal default). No bold, no underline, no children, no `onPress`, no hover. 1024 colour pairs at once.
- `$.ui.blit({ requestId, key, cells })` repaints a mounted Raster at the same size, up to 120 a second. A resize is a redraw.
- `Image` needs kitty, Ghostty or iTerm2 3.5+: **not used.**
- `Svg` (desktop, VS Code, mobile): one document up to 131072 characters, `alt` required. `isInteractive` gives hover, SMIL and `<title>` tooltips on the desktop; VS Code draws a still image.
- The mod cannot read the theme or its light/dark scheme.

## Cells, glyph sets and aspect

A terminal cell is about 1 : 2. The mocks draw every cell 9 × 18 px (JetBrains Mono at 15 px: 0.6 em wide, 1.2 em line), so nothing is stretched. Four glyph sets, each with what it buys:

| Set | Sub-cells | Colours in a cell | Used for |
|---|---|---|---|
| Quadrant blocks `▖▗▘▝▚▞▛▜▙▟▀▄▌▐█` | 2 × 2 (4.5 × 9 px each) | two | the crew's bodies |
| Braille U+2800 to U+28FF | 2 × 4 dots (4.5 px pitch, square) | one, on the default ground | rings, antennae, claw, tick |
| Half and eighth blocks `▀▄ ▁`…`█ ▔` | 1 × 2 square pixels, or 8 levels | two | beads, stacks, bars, the frame |
| A letter on a colour | one glyph | two | badges, pills, ring figures |

The default background counts as one of a cell's two colours. Sprites are laid out so no cell needs a third (the lamp only sits in cells with no empty sub-pixel; a body has one tone per cell row). On a ring, a cell where lit meets unlit takes the colour of most of its dots.

## Identity

**One rule: labels are keys, pictures are Rasters.** A deck row is a dim caps label in the label column (a Button) with a small Raster beside it and plain Text values after it. Nothing pressable is inside a Raster, and every Raster has Text beside it that says the same thing in words.

**Frame: the lintel and the sill.** Neo's twin brackets turn a quarter: a deck has a top and a bottom and no sides. The lintel is one Raster row: a chunky clamp top left (`█▀▀▀`), a hairline (`▔`), the **state pill hanging from the line** at the gauge column, and one dim readout at the right. The sill is a hairline (`▁`) ending in the mirrored clamp bottom right (`▄▄▄█`). Waiting turns clamps and pill amber. Two rows per deck.

**Crew: four characters.** Large is 8 × 4 cells (16 × 8 sub-pixels, 72 × 72 px); small is 4 × 2 cells (8 × 4), at a pitch of 6. Each has one lamp.
- **lead**, a commander: helmet with a dark visor, a neck, shoulders, a cape that flares to the ground; lamp on the chest. Small: a lit visor over a wide cape.
- **scout**, an explorer: a round head that is one big scanning eye (the eye is the lamp), a Braille antenna, two feet. Small: the eye ball.
- **build**, a builder bot: a flat head with a dark eye band, a wide body, one arm raised with a Braille claw. Small: a box with a raised arm.
- **check**, an inspector: slim and tall, the lamp is its lens, a dark belt, a Braille tick beside it. Small: a head on a stick body.
- State never changes the body. Queued: an outline in `mute`. Working: solid in the accent (the lead in `ember`), white lamp pulsing on the 1 s clock. Done: solid `mute`, lamp out. Waiting: solid `amber`, lamp on, `?`. Stalled: dulled amber, lamp out, `z`. Failed: a red outline, red lamp, `!`. The badge is one letter cell beside the top right corner.
- In tables an agent is still its Neo hull glyph (`◈ ◉ ▣ ◬`), so a row stays one Button. The glyph is the character's text form.

**Meters.** Beads: a segment is `▄` then `▖` (a square with a gap); 22 cells is 11 beads; any non-zero value lights one, only 100 % lights all; colour by `rateColor`. Stack: a solid `▄` run in several hues. Bars: eighth blocks, 1 to 3 rows tall (trace, plan strip, rate trend, step map, week). **Ring: 7 × 4 cells of Braille**, a 14-dot circle two dots thick, lit clockwise from the top; its name and its figure are letter cells in the three middle cells of rows 1 and 2 (`100` at full). Pill: half-cell caps (`▐ ▌`) around letters on the colour; outside a Raster, Neo's `Text` with `backgroundColor`.

**Palette.** A Raster's background is always the terminal default, so the ground is the person's theme. Six hues shadow the theme keys they sit beside and serve both grounds: `iris` (suggestion) `#8a9bff`, `ember` (claude) `#e07b53`, `amber` (warning) `#e0a93f`, `red` (error) `#ee5f74`, `mint` (success) `#43b888`, `orchid` (merged) `#b48cf2`. Three neutrals change with the ground: night `mute #5d6679`, `rest #333b4d`, `ink #c9cfdb`; day `mute #a3a9b8`, `rest #d6dae2`, `ink #2b2f3a`. Text keeps theme keys only.

## Surfaces and fallbacks

| Surface | Raster | Text / Button | Fallback |
|---|---|---|---|
| Terminal pane, strip, slim | frame, characters, meters, rings | tabs, labels, values, tables, pages, footer | the Neo text form |
| Terminal band | clamps, small crew, plan strip, bead meters | pill, focus, next, figures, `/mc` | the Neo band |
| Desktop app | none | tabs, tables, footer as native rows | one `Svg` deck (`isInteractive`), one `Svg` band |
| VS Code extension | none | the same | the Svg as a still image, or the text form |
| Mobile | none | the text form | text only |

**The text form is Neo as built.** Every Raster has a Text stand-in of the same width and rows (character to hull and signal, beads to `▮▯`, ring to dial, bars to sparkline, lintel to `┏` and a Text pill), so the two forms swap without moving anything (`RichSlim` shows both). It is drawn where there is no Raster, when `Look` is `text`, and for a screen reader.

## Screens: what shows, and one press

- **Now.** Lintel. Hero, four rows: the lead's large character in the label column; the focus in bold on two lines; the running step (a Button: opens its page); the `BUDGET` line (a Button: opens the budget view); three rings on the right. Then `NEXT`, `CREW` (small characters, two counts; opens Agents), `TASKS` (plan strip; opens Tasks), `STEPS` (trace; opens Steps), sill. Then `AGENTS`, `LATEST`, `KEPT`, `NOTES`.
- **Stale focus** (`RichNowFilled`). When the focus is over 10 minutes old and steps have run since, the latest activity leads the hero in bold with its agent and age, and the focus moves to its own dim row labelled `FOCUS 14m` in amber. A new focus returns to the hero.
- **Now by height.** After the deck each section takes its floor: LATEST 2, AGENTS 3 (live first), TASKS 1 (the active one, from 40 rows), KEPT 1, NOTES 2. Spare rows are dealt one at a time in that order up to LATEST 8, AGENTS 6, TASKS 8, KEPT 4, NOTES 4, and taken back in reverse. Empty sections are left out; one blank row between sections, never two. Under 24 rows the deck drops `STEPS`, then `NEXT`.
- **Now, waiting.** An amber frame first: `NEEDS YOU 3`, the asker's large character with its `?`, the first item opened with its kind (`permission`) and `g: chat  x: dismiss  n: next`; the others one row each with the kind in the label column (`LONG RUN`, `STALLED`). Then the deck with a `WAITING` pill.
- **Budget view** (`esc` back). Per window: 22 beads, used, resets; under them a 10-cell rate trend, points per 10 minutes, `full 37m`, `short 35m`. `OUTPUT`, `CACHE`, `COST` (only with `showCost`). `MODELS` and `AGENTS` share bars. `THIS WEEK`. `e` writes the CSV.
- **Tasks.** `PLAN` (one column per task, three rows tall, heaviest and current named), `PACE`, then `ACTIVE` with agents tethered, `QUEUED`, `DONE`. Enter on a task opens its page.
- **Agents, list.** `CREW` as a line-up of five large characters (then `+n`) with tokens under each; `ROLES`; `MODELS`. The table, `RUNS`. Enter on an agent opens its page.
- **Agents, map** (`t`, `RichCrewMap`; replaces the tree, `RichAgentsTree` is kept only for comparison). Main, large, at the top. A trunk carries one branch per task, per workflow run, and one for agents with no task; agents hang under what they serve, a nested agent under its parent. A node is two rows: the small character and the name (a Button), then its facts. Done agents fold to a count; `!` and `?` climb to the gutter. It has structure even when every agent is a child of main.
- **Steps.** `FIND`, `SHOW` chips, `MAP` (44 buckets, errors red, the run in view bright). A step opens in place; the second press opens its page.
- **Artifacts.** `HANDOFF`, `DIGEST` (a stack of what the export will hold), `KEPT`; the tables. Enter opens the artifact's page; `e` exports.
- **Detail pages** (replace the list; `b` back; nothing is ever cut: text wraps in full, long lists scroll).
  - Agent: large character, name, full description; AGENT (type, role, model), TOKENS in and out, TIME and start, STATE, TASK; `STEPS`; `FILES` each with `o: open`; the result in full; `v: transcript  g: chat  s: steps  b: back`.
  - Step: TOOL, AGENT, STATUS, TIME; `INPUT` wrapped; `CHANGE` (a diff for Edit and Write); `RESULT` scrolling; `FILES` with `o: open` (an image row says it opens in the editor's image preview); `o g k` then `c: copy as Markdown  q: quote  b: back`.
  - Task: full subject and active form, status, time against the usual, tokens stacked by agent; its agents with character and full description; its steps.
  - Artifact: full title, kind, ref or path, summary, the step that made it, versions; `o: open  c: copy  g: chat  b: back`.
- **Options** (`,`). A `PREVIEW` deck that redraws at once, then `LOOK`, `SIGNALS`, `BUDGET` rows and `NEVER`.
- **Band.** Three rows from 86 columns with the pane closed: clamp, pill, focus, age; the small crew (lead first) beside `next`; `TASKS` strip; a bead meter per window; `/mc`. Three rows cannot hold a large character. Waiting: amber, row 1 the first ask. All done: one dim row. Compact: one row, hull glyphs, one CTX bead meter.
- **Slim** (under 32). Lintel with the pill, focus on two lines, `CREW` (three small characters, `+n`, `!n`), `TASKS`, `BUDGET` (5 beads a row), `LATEST`, sill.
- **Strip** (14 rows). Compartments, each with its own lintel and sill, three clear columns between them, dropped whole and never squeezed. NEEDS YOU takes the second place whenever something waits.

| Columns | Compartments (width) |
|---|---|
| 185 and up | NOW 52, TASKS 34, AGENTS 36 (characters, name, facts), LATEST 28, BUDGET 23 (three rings, resets, cache) |
| 148 to 184 | NOW, AGENTS, LATEST, BUDGET (NOW keeps the plan strip) |
| 117 to 147 | NOW, AGENTS, BUDGET (the hero keeps the running step) |
| 96 to 116 | NOW 48 with three bead meters, AGENTS over LATEST 46 (`RichStrip`) |

- **Desktop.** The deck as one Svg: vector clamps with a glow, real rings, rounded pills, the same characters, a proportional font, tooltips, a pulsing lamp. It takes no presses.

## Where the new features live

| Feature | Home |
|---|---|
| Pace | Budget view: the trend row under each window. On Now the hot ring's name turns amber and the `BUDGET` line reads `▲ 5h full 37m`; the band shows `▲ 37m`. `PACE` on Tasks is the completion rate. |
| Cache line | Budget view: `CACHE` stack, shares, `warm ~3:48`, what going cold re-sends; the wide strip's BUDGET compartment. While idle the lintel's readout is the warm countdown. |
| Task meter | `PLAN` on Tasks; the same strip one row tall as `TASKS` on Now, band, strip and slim. Task rows and the task page carry tokens and time. |
| Long run | A needs-you kind (`LONG RUN`, `24m of 20m`); the agent's time cell turns amber at 80 %; the lintel's turn clock likewise. `ROLES` and the task page give the usual time. |
| Done signal | The band's `ALL DONE` row and a `THIS TURN` section on Now in LATEST's place; one notification after a turn over 60 s. |
| Options card | `RichOptions`, opened with `,`. |
| Ledger | `THIS WEEK` at the foot of the budget view: seven stacked day columns; `e: csv`. |
| Quiet delights | A clean run sweeps a bright run of cells along the sill once and the band reads `14/14 clean`. Round-number steps get one dim toast. |
| Accent | Options: `iris`, `ember`, `mint`, `orchid`: the Raster accent and its theme key for Text. |

## Changes against the Neo views (`mod/hooks/views/`)

- **New `raster.ts`** (pure): `Grid` with `sp` (quadrant), `dot` (Braille), `px`, `lv`, `glyph` and the generator's cell rules as asserts; glyph pickers (16 quadrant glyphs from 4 bits, Braille from 8 bits at U+2800); `encode()` to base64 u32 triplets; `sprite(role, state, size)`, `beads`, `stack`, `bars`, `ring`, `rpill`, `lintel`, `sill`; `PALETTE.night` / `.day`. `gen-rich.js` is the reference (shapes in `SHAPES` and `DOTS`).
- `style.ts`: `RICH` palette; `lookOf(e, options)` (`rich`, `svg`, `text`) from `$.ui.resolve(e)` and `Look`; `spriteOf(agent, now)` beside `podOf`; `DECK.ring = 39`. `GLYPHS` and `podOf` stay as the text form.
- `fit.ts`: nothing removed; add `levels(values, rows)`, `beadCount(pct, n)`, `sectionRows(bodyRows, counts)` (the height rule) and `compartments(cols, waiting)` (the strip table).
- `parts.tsx`: `inst(key, cols, rows, cells, fallback)`; `deck` with lintel and sill and rows of `[label Button][inst][Text…]`; `hero(...)`; `page(...)` for detail pages (label rows, wrapped blocks, a scroll list, an action row). `row`, `section`, `opened`, `footer`, `more` unchanged.
- **New `paint.ts`**: the one `$.clock.every(1000)` owner; blits only keys whose cells changed.
- `shell.tsx`: `,` to Options; the look once per draw; page routing (`ui.page = { kind, id }`) and `b`.
- `overview.tsx`: hero, deck, the height rule, the stale-focus swap, `THIS TURN`, the strip's compartments, the slim stack.
- `needs.tsx`: amber frame, asker's character, kinds, the `long run` kind.
- `budget.tsx`: rings; the view's window pairs, `OUTPUT`, `CACHE`, `COST`, shares, `THIS WEEK`.
- `tasks.tsx`: `PLAN`, `PACE`, tokens and time; **new** task page.
- `agents.tsx`, `agentmeta.ts`: line-up, `ROLES`, `MODELS`; **new** agent page (description, files read and edited from its steps). `tree.tsx` becomes the crew map (group by `taskId`, then run, then parent). `runboard.tsx`: unchanged.
- `timeline.tsx`, `find.ts`: `MAP`. `detail.tsx`: the step page (adds FILES with `o`, the image note, `c` as Markdown). `openstep.ts`, `handoff.ts`: `handoff.ts` reports the digest's parts.
- `artifacts.tsx`: `DIGEST`, edit bars; **new** artifact page.
- `band.tsx`: the three-row rich band; the compact row's bead meter.
- **New `options.tsx`** and **`svg.ts`** (the desktop deck and band from the same model).
- Tests: cell rules and `encode` length (`cols × rows × 12` bytes); every `inst` fallback has its Raster's size; no Button shares a cell with a Raster; no `Raster` in the tree when the table lacks it; a blit only on change; detail pages never end a line in `…`; `sectionRows` at 24, 36 and 50 rows; `compartments` at 96, 120, 150 and 185; the Svg under 131072 characters with an `alt`.

## Risks

- **No Raster outside the terminal.** `lookOf` must come from the element table. The text form is the built Neo, so the fallback is already tested.
- **Light themes.** The mod cannot read the scheme. The hues hold on both grounds (`RichKit` shows both), but `rest` and `mute` must be chosen: `Ground: night | day` in Options, default night. Every figure is also Text, so the wrong ground is ugly, not unreadable.
- **Glyph coverage and seams.** Windows Terminal and VS Code's terminal draw block elements and Braille themselves; other terminals use the font, where Braille dots may be small or hollow-marked and quadrants may leave hairline seams. Check on the owner's terminal first; the fallback for a missing set is the text form for that instrument.
- **Braille is dots, not a line.** A ring reads as a dotted circle and its lit arc moves in whole cells (about 20 cells a ring); the figure inside carries the value.
- **Character detail is bounded by the two-colour rule.** A face, a visor and a lamp must each own their cells. New roles or poses must pass the generator's check before they are built.
- **Blit at 1 s.** Encode only on change, blit per key (the pulse touches `lead` and `crew`), stop the clock while nothing is live. A changed crew count is a redraw: crew Rasters keep a fixed slot count and blank the unused ones.
- **Rows.** Now's deck is 11 rows and a map node is 2: on a short pane the map shows fewer agents than the list. The list stays one key away.
- **Open:** whether a Raster may sit in a row Box beside a Button at these widths (expected, not spiked); `o: open` needs an editor-open call the API may not offer on every surface (else it copies the path); the Options reload question from `distill.md`; the Ledger needs the owner's yes.


## Artboards

- `RichKit`: the four characters × six states, large and small, rings, meters, pills, frame, on a night and a day ground, with an enlarged strip (1440 × 1120).
- `RichBand`: the band working, waiting, all done with `THIS TURN`, and compact at 84 and 48 columns.
- `RichNowBusy`: Now, busy: the hero with rings, the deck, the tables.
- `RichNowWaiting`: Now with three things waiting: the amber frame, then the deck.
- `RichNowFilled`: Now on a 46-row pane with the height rule, and a stale focus.
- `RichBudget`: windows with pace, output, cache, cost, shares, the ledger week.
- `RichTasks`: the plan strip and pace; the active task with its agents tethered.
- `RichAgents`: the line-up, roles and models; the list with one agent opened in place.
- `RichCrewMap`: the map: main, branches by task and run, characters on tethers.
- `RichAgentsTree`: the earlier tree with the short deck (superseded by the map).
- `RichSteps`: find, chips and the step map; a failed step opened in place.
- `RichArtifacts`: handoff, the digest stack and kept; artifacts; files changed.
- `RichDetailAgent`, `RichDetailStep`, `RichDetailTask`, `RichDetailArtifact`: the four pages.
- `RichSlim`: the slim sidebar at 24 columns, text form beside rich form.
- `RichStrip`: the strip at 96 columns with the compact band under it.
- `RichStripWide`: the strip at 185 columns in five compartments, with the collapse diagram (1600 × 560).
- `RichDesktopSvg`: the desktop app: the Now deck and the band as Svg.
- `RichOptions`: the options card with a live preview and the accent choice.
