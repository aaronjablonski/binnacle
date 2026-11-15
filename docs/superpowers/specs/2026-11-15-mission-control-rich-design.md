# Neo Rich: the HUD drawn in cells (design round 6)

Date: 2026-11-15. Status: design only, nothing is built. It gives Neo (`neo-design.md`) a rich form; HUD v2's grid, keys, commands and features are unchanged.
Mocks: `Rich*.dc.html` in `…/scratchpad/mcstyles/project/`, made by `…/scratchpad/gen-rich.js` (screenshots in `…/scratchpad/rich-preview/`, taken by `shot-rich.sh`).
The generator models each surface as terminal cells. It exits 1 when a row is too wide, two things share a cell, text touches text, a grid row starts off a stop, a Raster leaves its box or overlaps another, a Raster cell needs more than two colours or mixes glyph kinds, a Raster holds over 1024 colour pairs, a Button overlaps a Raster, or two blank rows meet. All 14 boards pass and were checked as screenshots.
The product name is on no board.

## What the API allows (type file, checked)

- `Raster` is on the **terminal surface only** (`Elements`, TF 4101). Desktop, VS Code and mobile have `Svg` and no Raster; a tree with a Raster is refused there. Ask `$.ui.resolve(e)` for the table before drawing one.
- A Raster is a fixed box (`columns` × `rows`, up to 512 × 256, `key` required) of cells; a cell is one width-1 BMP glyph, a foreground and a background (`0x00RRGGBB`, or `0x01000000` for the terminal default). No bold, no underline, no children, no `onPress`, no hover. 1024 colour pairs at once.
- `$.ui.blit({ requestId, key, cells })` repaints a mounted Raster at the same size, up to 120 a second. A resize is a redraw.
- `Image` needs kitty, Ghostty or iTerm2 3.5+. The owner's terminal has none of them: **Image is not used.**
- `Svg` (desktop, VS Code, mobile): one document up to 131072 characters, `alt` required. `isInteractive` gives hover, CSS `:hover`, SMIL and `<title>` tooltips on the desktop; VS Code always draws a still image.
- The mod cannot read the theme or its light/dark scheme (`$.theme` has `set` and `clear` only).

## Identity

**One rule: labels are keys, pictures are Rasters.** A deck row is a dim caps label in the label column (a Button) with a small Raster beside it and plain Text values after it. Nothing pressable is ever inside a Raster, and every Raster has Text next to it that says the same thing in words.

**Frame: the lintel and the sill.** Neo's twin brackets (sides, no top or bottom) turn a quarter: a deck now has a top and a bottom and no sides. The lintel is one Raster row: a chunky clamp top left (`█▀▀▀`), a hairline (`▔`), and the **state pill hanging from the line** at the gauge column, with one dim readout at the right (turn and elapsed, or the tab's count). The sill is one Raster row: a hairline (`▁`) ending in the mirrored clamp bottom right (`▄▄▄█`). The two clamps sit on a diagonal. Waiting turns clamps and pill amber. Cost: two rows per deck.

**Crew: pods grown into sprites.** The four Neo hulls keep their silhouettes: lead is the diamond, scout the round one on legs, build the block on treads, check the spire. Each has exactly one lamp pixel.
- Large: 5 × 3 cells (5 × 6 pixels), for the hero, the Agents line-up and the band's lead. Small: 5 × 2 cells (5 × 4 pixels), at a pitch of 6, for crew rows.
- State: queued is an outline in `mute`; working is solid in the accent (the lead in `ember`) with a white lamp that pulses on the 1 s clock; done is solid `mute` with the lamp out; waiting is solid `amber` with the lamp on; stalled is dulled amber with the lamp out; failed is a red outline with a red lamp. The lower half of a body is one shade darker.
- Signals stay `?`, `z`, `!`: one letter cell on the state colour, beside the top right corner of a large sprite and on that corner of a small one.
- In tables and trees an agent is still its Neo hull glyph (`◈ ◉ ▣ ◬`), so a row stays one Button. The glyph is the sprite's text form.

**Meters.**
- Beads: a segment is two cells, `▄` then `▖` (a square with a gap). 22 cells is 11 beads, 10 cells is 5. Any non-zero value lights one; only 100 % lights all. Colour by `rateColor`: accent, amber from 70 %, red from 90 %.
- Stack: a solid `▄` run in several hues (cache read/written/fresh, model share, the digest).
- Bars: eighth blocks (`▁`…`█`), 8 levels a cell, 1 to 3 rows tall. The step trace, the plan strip, the rate trend, the step map, the week.
- Ring: 7 × 4 cells, 18 pixels lit clockwise from the top, with its name and its figure inside it. Three sit in the hero (CTX, 5H, 7D). A ring under 7 × 4 reads as a square, so narrower surfaces use beads.
- Pill: inside a Raster, half-cell caps (`▐ ▌`) around letters on the colour. Outside one, Neo's `Text` with `backgroundColor`.

**Palette.** A Raster's background is always the terminal default, so the ground is the person's theme. Six hues shadow the theme keys they sit beside and are shared by both grounds: `iris` (suggestion) `#8a9bff`, `ember` (claude) `#e07b53`, `amber` (warning) `#e0a93f`, `red` (error) `#ee5f74`, `mint` (success) `#43b888`, `orchid` (merged) `#b48cf2`. Three neutrals change with the ground: night `mute #5d6679`, `rest #333b4d`, `ink #c9cfdb`; day `mute #a3a9b8`, `rest #d6dae2`, `ink #2b2f3a` (and iris deepens to `#6f82f2`). Text keeps theme keys only.

## Surfaces: Raster, Text, Button, Svg, and the fallback

| Surface | Raster | Text / Button | Fallback |
|---|---|---|---|
| Terminal pane, strip, slim | lintel, sill, sprites, meters, rings | tabs, labels (Buttons), values, all tables, opened rows, footer | the Neo text form (below) |
| Terminal band | lead and clamp, crew, plan strip, three bead meters | pill, focus, next, figures, `/mc` | the Neo band |
| Desktop app | none | tabs, tables, footer as native rows | one `Svg` deck (`isInteractive`), one `Svg` band |
| VS Code extension | none | the same | the same Svg as a still image, or the text form |
| Mobile | none | the text form | text only |

**The text form is Neo as built.** Every Raster has a Text stand-in of the same width and rows: sprite to hull glyph plus signal, beads to `▮▯`, ring to dial (`◔ 9%`), bars to the sparkline, lintel to `┏` and a Text pill, sill to nothing. The label column, the stops and the row count do not change, so the two forms swap without moving anything (`RichSlim` shows both). It is drawn when the surface has no Raster, when `Look` is `text`, and for a screen reader; in the rich form the Text beside each Raster already carries its figure.

## Screens: what shows, and one press

- **Now.** Lintel (state pill, `turn 6 41m`). Hero, four rows: the lead's large sprite in the label column, the focus in bold on two lines, the running step (a Button: opens it in Steps), and three rings on the right. `BUDGET` under the sprite (a Button: opens the budget view) with one dim line. `NEXT`. `CREW` (small sprites, two counts; opens Agents). `TASKS` (the plan strip one row tall, done/total, elapsed; opens Tasks). `STEPS` (trace, count, errors; opens Steps). Sill. Then `AGENTS`, `LATEST`, `KEPT`, `NOTES` as v2. 11 deck rows against Neo's 7.
- **Now, waiting.** An amber frame first: the pill `NEEDS YOU 3`, the asker's large sprite with its `?`, the first item opened (`g: chat  x: dismiss  n: next`). The label column says why each item waits: `PERMISSION`, `LONG RUN`, `STALLED`. Then the main deck with a `WAITING` pill.
- **Budget view** (from `BUDGET`; `esc` back). Per window, two rows: 22 beads, used, resets; under them a 10-cell rate trend, points per 10 minutes, `full 37m` and `short 35m`. `OUTPUT`, `CACHE`, `COST` (only with `showCost`). `MODELS` and `AGENTS` with a 10-cell share bar. `THIS WEEK`. `e` writes the CSV.
- **Tasks.** `PLAN`: one column per task, three rows tall, with the heaviest and the current one named under it. `PACE`. `ACTIVE` with agents tethered and tokens and time on the two metric columns; `QUEUED`; `DONE`. A task opens or folds its agents; `d` unfolds done.
- **Agents, list.** `CREW` as a line-up of large sprites with tokens under each; `ROLES` (hull, role, count); `MODELS` (a stack). The toggle row, the table with one row opened, `RUNS`. A row opens to `result` and `agent`.
- **Agents, tree.** The short deck (small sprites). Neo's tethers and gutter flags. A new `ROLES` table: count, tokens and the usual time per role.
- **Steps.** `FIND`, `SHOW` (chips, the chosen one a pill), and `MAP`: 44 buckets, two rows tall, errors red, the run in view bright. The turn tables, the opened step and the second press to the full step are v2's.
- **Artifacts.** `HANDOFF` (`↥ Export digest`, a Button), `DIGEST` (a stack of what the export will hold, and its size), `KEPT`. `ARTIFACTS` with one opened; `FILES CHANGED` with a 6-cell edit bar. `e` exports.
- **Options** (`,`). A `PREVIEW` deck that redraws at once, then `LOOK`, `SIGNALS`, `BUDGET` rows (Enter flips or opens) and `NEVER`.
- **Band.** Three rows from 86 columns with the pane closed: clamp and large lead sprite; pill, focus, age; small crew; `next`; `TASKS` strip; a bead meter per window; `/mc`. Waiting: amber, row 1 the first ask, row 2 the rest. All done: one dim row. Compact (pane or strip open, or under 86): one row, hull glyphs, one CTX bead meter. No Buttons in the band.
- **Slim** (under 32). Lintel with the pill, the focus on two lines, `CREW` (three small sprites, then `+n` and `!n`), `TASKS` (strip), `BUDGET` (label 2, value 8, 5 beads at 14), `LATEST`, sill.
- **Strip** (under 110, 14 rows). The frame holds cells 1 to 4: hero without rings, crew, plan strip, three 5-bead meters with captions. Tables keep cells 5 to 8. 12 rows.
- **Desktop.** The same deck as one Svg: vector clamps with a glow, real rings, rounded pills, the same pixel sprites, a proportional font, tooltips on hover, a pulsing lamp. It takes no presses; tabs, rows and footer stay native.

## Where the new features live

| Feature | Home |
|---|---|
| Pace | Budget view: the trend row under each window. On Now, the name inside the hot ring becomes `▲37m` when the window fills before it resets; the band shows `▲ 37m` beside 5H. `PACE` on Tasks is the completion rate. |
| Cache line | Budget view: the `CACHE` stack, shares, `warm ~3:48`, and what going cold re-sends. While idle the lintel's readout becomes the warm countdown. `AGENTS` notes a low read share. |
| Task meter | `PLAN` on Tasks; the same strip one row tall as `TASKS` on Now, in the band, the strip and slim. Task rows gain tokens and time. |
| Long run | A needs-you kind named in the label column (`LONG RUN`, `24m of 20m`); the agent's time cell turns amber at 80 %; the lintel's turn clock does the same against the turn limit. `ROLES` gives the usual time. |
| Done signal | The band's `ALL DONE` row (`done in 6m 12s`) and a `THIS TURN` section on Now in LATEST's place; one notification after a turn over 60 s. |
| Options card | `RichOptions`, opened with `,`. |
| Ledger | `THIS WEEK` at the foot of the budget view: seven stacked day columns; `e: csv`. |
| Quiet delights | A clean run sweeps a bright run of cells along the sill once (a blit loop) and the band reads `14/14 clean`. Round-number steps get one dim toast. Off with `Delights` or `Motion`. |
| Accent | Options: `iris`, `ember`, `mint`, `orchid`. It sets the Raster accent and the matching theme key for Text (`suggestion`, `claude`, `success`, `merged`). |

## Changes against the Neo views (`mod/hooks/views/`)

- **New `raster.ts`** (pure, no engine): `Grid` (cells with two colours, the generator's rules as runtime asserts), `px`, `lv`, `glyph`, `encode()` to base64 u32 triplets; `sprite(role, state, size)`, `beads`, `stack`, `bars`, `ring`, `rpill`, `lintel`, `sill`; `PALETTE.night` / `.day`. `gen-rich.js` is the reference for every one of them.
- `style.ts`: add `RICH` (the six hues, both neutral sets, accent to theme key); `lookOf(e, options)` returning `rich`, `svg` or `text` from `$.ui.resolve(e)` and the `Look` option; `spriteOf(agent, now)` beside `podOf` (same role and state, so both forms agree). `DECK` gains `ring: 39`. `GLYPHS` and `podOf` stay: they are the text form.
- `fit.ts`: no removals. `bar`, `pips`, `spark`, `crewRow`, `meter` stay as the text form; add `levels(values, rows)` (shared by `spark` and `raster.bars`) and `beadCount(pct, n)`.
- `parts.tsx`: add `inst(key, cols, rows, cells, fallback)`: a `Raster` when the look is rich, else the fallback Runs in a Box of the same size. `deck(rows)` gains `lintel` and `sill` and rows that are `[label Button][inst][Text…]`; the rails go. Add `hero(...)`. `pill`, `row`, `section`, `opened`, `footer`, `more` are unchanged.
- **New `paint.ts`**: the one `$.clock.every(1000)` owner. It keeps the last `cells` per key and blits only keys whose cells changed (lamp pulse, countdown, sweep).
- `shell.tsx`: route `,` to Options; pick the look once per draw; tiers unchanged.
- `overview.tsx`: the hero and the Now deck; the strip's left half; the slim stack; `THIS TURN`.
- `needs.tsx`: the amber frame, the asker's sprite, kinds in the label column, the `long run` kind.
- `budget.tsx`: rings in the hero; the budget view's window pairs, `OUTPUT`, `CACHE`, `COST`, share bars, `THIS WEEK`.
- `tasks.tsx`: `PLAN` and `PACE`; tokens and time on task rows.
- `agents.tsx`, `agentmeta.ts`: the line-up; `ROLES`; `MODELS` as a stack. `tree.tsx`: the short deck and the `ROLES` table. `runboard.tsx`: no change.
- `timeline.tsx`, `find.ts`: the `MAP` row and its buckets. `detail.tsx`, `openstep.ts`, `handoff.ts`: `handoff.ts` reports the digest's parts and size; the rest unchanged.
- `artifacts.tsx`: `DIGEST`, the edit bars.
- `band.tsx`: the three-row rich band; the compact row's bead meter.
- **New `options.tsx`** and **`svg.ts`** (the desktop deck and band as strings, from the same model as `raster.ts`).
- Tests: `raster.ts` cell rules (two colours a cell, sizes, pair count, `encode` length is `cols × rows × 12` bytes); every `inst` fallback is exactly its Raster's size; no Button shares a cell with a Raster; the drawn tree has no `Raster` when the table lacks it; a blit is sent only when cells change; the Svg is under 131072 characters and has an `alt`.

## Risks

- **No Raster outside the terminal.** A tree that includes one is refused on desktop, VS Code and mobile, so `lookOf` must come from the element table, never from a guess. The text form is the built Neo, so the fallback is already tested.
- **Light themes.** The mod cannot read the scheme. The hues are mid-tones that hold on both grounds (`RichKit` shows both), but `rest` and `mute` must be chosen: `Ground: night | day` in Options, default night. On the wrong ground the unlit beads are too heavy or too faint; nothing becomes unreadable, because every figure is also Text. Spike: look for a scheme signal in `e.props` before shipping the option.
- **Blit at 1 s.** The API takes 120 a second, so the cost is ours: encode only on change, blit per key (the lamp pulse touches `lead` and `crew`, about 80 cells), and stop the clock while nothing is live. A resize or a crew count change is a redraw, not a blit: crew Rasters keep a fixed width (6 or 8 slots) and blank the unused ones.
- **Glyph coverage.** `▖ ▐ ▌ ▔ ▁`…`█` are Block Elements; Windows Terminal and VS Code's terminal draw them themselves, other terminals take them from the font. `▖` is the least common: if it is missing, beads fall back to `▄` with a blank cell.
- **Rings are coarse.** 18 steps of about 5.6 %; the figure inside carries the value. Cells are taller than wide, so a ring is slightly oval.
- **Two rows per frame.** Now's deck is 11 rows. At 24 rows or fewer of body the deck drops `STEPS`, then `NEXT`; the hero never drops.
- **Raster text is not text.** The pill word and the lintel readout cannot be selected or read aloud: the band and the focus row repeat the state, and the screen-reader path uses the text form.
- **Open:** whether a Raster may sit in a row Box beside a Button at the widths used here (expected, not spiked); the Options reload question from `distill.md` stands; the Ledger still needs the owner's yes.


## Artboards

- `RichKit`: the crew sprites (4 roles × 6 states, large and small), rings, meters, pills and the frame, on a night and a day ground (1440 × 1120).
- `RichBand`: the band working, waiting, all done with `THIS TURN`, and compact at 84 and 48 columns.
- `RichNowBusy`: Now, busy: the hero with rings, the deck, then AGENTS, LATEST, KEPT, NOTES.
- `RichNowWaiting`: Now with three things waiting: the amber frame with kinds in the label column, then the deck.
- `RichBudget`: the budget view: windows with pace, output, cache, cost, shares, the ledger week.
- `RichTasks`: the plan strip and pace; the active task with its agents tethered.
- `RichAgents`: the crew line-up, roles and models; the list with one agent opened.
- `RichAgentsTree`: the short deck, the tethered tree, the ROLES table.
- `RichSteps`: find, chips and the step map; a failed step opened in place.
- `RichArtifacts`: handoff, the digest stack and kept; artifacts with one opened; files changed.
- `RichSlim`: the slim sidebar at 24 columns, text form beside rich form.
- `RichStrip`: the 14-row inline strip at 96 columns with the compact band under it.
- `RichDesktopSvg`: the desktop app: the Now deck and the band as Svg.
- `RichOptions`: the options card with a live preview and the accent choice.
