# Cockpit: a calm pass over the rich HUD (design round 7)

Date: 2026-11-15. Status: mocks only, nothing is built. It restyles Neo Rich (`rich-design.md`); HUD v2's keys and commands and the rich spec's features stay.
Mocks: 11 `Cockpit*.dc.html` boards in `…/scratchpad/mcstyles/project/`, made by `…/scratchpad/gen-cockpit.js` (screenshots in `…/scratchpad/cockpit-preview/`, taken by `shot-cockpit.sh`).
The generator models each surface as terminal cells and exits 1 when a row is too wide, two things share a cell, text enters the side gutters, text touches text, a line is cut with an ellipsis, a Raster cell needs a third colour or mixes glyph kinds, a Braille cell needs two colours, a Button overlaps a Raster, or three blank rows meet. All boards pass and were checked as screenshots. The product name is on no board.

## Principles

1. **Three questions, three blocks, always in the same place.** What is happening (the header). Does anything need me (one line, or the Needs you block in that same slot). How far along (the to-do list).
2. **Plain words.** A label is a sentence-case word a newcomer understands; a count comes with its noun ("2 working", "9 of 14 done"). Capitals only inside the state pill.
3. **The action is obvious, or obviously absent.** `✓ Nothing needs you` is drawn when nothing does. A permission gets one filled button. Watch says "no action needed".
4. **Now holds no log.** No commands, no step count, no error count. An error reaches Now only as a Watch row with words, or a failed agent with its reason.
5. **Space is part of the layout.** Fixed gutters, one blank row between blocks, gauges alone on the right, nothing cut where width exists. Spare rows stay empty at the bottom.
6. **Colour means one thing each.** One accent, one warm hue for living things, three status hues, greys for the rest.

## Vocabulary

| Old label | New words |
|---|---|
| `WORKING` pill, `turn 6 41m` | pill `WORKING`, then "41 min this turn" |
| `WAITING` pill | `WAITING FOR YOU`; kicker "Paused on" |
| (focus, unlabelled) / `FOCUS` | "Working on" above the headline; idle: "Finished" |
| `▸ Bash sed -i …` (running step) | removed from Now; each agent says "Editing test/rateLimit.test.ts" |
| `NEXT` + a line | the `next` tag on the first open to-do row |
| `CREW 2 live +31` | "Agents … 2 working", "31 finished earlier" |
| `TASKS 9/14`, `PLAN`, `PACE` | "To do … 9 of 14 done"; Tasks: "about 20 min left at this pace", "Effort so far" |
| `STEPS 2000`, `43 errors` | removed from Now; Steps: "212 steps · 41 min", chip "Errors 3" |
| `BUDGET 853k of context` | "853k of 1M used · cache warm 4:48" |
| `CTX`, `7D`, `5H` rings | "context", "this week", "5 hours" under the ring |
| `CACHE ~4:48` | "cache warm 4:48" |
| `LATEST` | removed from Now (Steps: "This turn") |
| `KEPT`, `NOTES` | "Notes and decisions" (`★` kept or decided, `·` a note) |
| `NEEDS YOU … stalled 3m` | "Needs you … 1 permission": "Builder asks to run a command" |
| `LONG RUN`, `STALLED`, repeat, loop | "Watch … no action needed": "Long run", "Stalled", "Repeat", "Loop" |
| `ACTIVE`, `QUEUED`, `DONE` | "Doing now", "Up next", "Done" |
| `tokens` / `time` heads, `2 live` | kept as dim heads; "2 working" |
| `HANDOFF`, `DIGEST` | "Handoff", "It will hold" |
| tool names on Now (`Read`, `Grep`, `Bash`) | verbs: Reading, Searching, Running, Editing, Thinking, Waiting for your answer |

Steps keeps tool names (`Edit`, `Bash`): it is the log.

## Palette

Text keeps theme keys; a Raster uses the hex of the chosen ground (`Ground: night | day` in Options).

| Role | Night | Day | Theme key | Used for |
|---|---|---|---|---|
| iris | `#8f9eff` | `#5364e8` | `suggestion` | now: current task, open tab, the one filled button, hotkeys |
| iris soft | `#5a659f` | `#9aa5ee` | (Raster only) | behind us: done segments, past effort |
| iris deep | `#2c3254` | `#dfe3fb` | background of a selected chip | the open chip or toggle |
| ember | `#e58a5f` | `#d9683c` | `claude` | a critter at work, and nothing else |
| amber | `#e3b04b` | `#b9790f` | `warning` | Needs you; a gauge at 70 % |
| red | `#ef6b7e` | `#cf3550` | `error` | a failure you can open; a gauge at 90 % |
| mint | `#4fbf93` | `#1e8f66` | `success` | the all-clear tick, `ALL DONE` |
| ink / dim | `#d7dbe5` / `#8a92a6` | `#262a35` / `#687083` | default / `dimColor` | what you read / what explains |
| mute / rule / rest | `#5b6478` / `#333a4c` / `#272c3a` | `#a4aab9` / `#d3d7df` / `#e3e5ea` | `subtle` | resting critters / hairlines / unlit bar |

Rules: done is dim, never green. Watch is all dim. A page shows amber only for a real permission or a hot gauge. `orchid` leaves the pane.

## Spacing and type

- Columns: gutter 0 to 1 (column 0 holds only the `▍` current-row marker and `◂` in view), content 2 to 59, gutter 60 to 61. Times end at 59; a second figure ends at 49.
- Header: lintel, pill row, a blank, kicker, two headline lines at column 9 (29 wide, wrapped at a word), a blank, the budget line, sill. Two gauges, 9 × 5 cells each, at columns 40 and 51, with labels under them.
- A section head is one row: bold title, a `─` hairline, the sum at the right. One blank row between blocks; a blank row after the to-do bar.
- An agent card is 3 rows: character 5 × 3 at column 2, name and job at 9, what it is doing under it, the third row empty.
- Four voices at one size: bold ink (answers), ink (names), dim (labels, times), pill (state). No caps labels, no `┌` corners.
- Bars are one row of `━` (to-do, shares, slim budget); rings are Braille; the effort chart and step map are eighth blocks; critters are quadrant blocks. All fall back to the Neo text form.
- Critters are placeholders for the character round: 5 × 3 (an agent card, the header) and 4 × 2 micro (tethers, slim, band). No large character anywhere.

## Screens

- **CockpitNow** (busy). Header: pill, turn time, "Working on" + headline beside the main critter, budget line, gauges right. `✓ Nothing needs you`. To do: bar with one segment a task, two done rows, the current row (marker, bold, `now · 12 min`), three open rows, `+ n more`. Agents: a card each for working agents, "31 finished earlier". Notes and decisions. Footer `↵ open  , options  esc prompt`. *Removed:* the running-step line, NEXT, CREW, TASKS and STEPS label rows, the sparkline, the error count, the AGENTS token column, LATEST, the third ring (the hotter of 5 hours and week shows).
- **CockpitNowNeedsYou.** Pill and frame turn amber. In the all-clear slot: "Needs you … 1 permission", the asker's critter, "Builder asks to run a command", the tool and command in bold, a filled `↵ go to prompt`, "answer it there: allow or deny". The current task reads `paused`; the asker's card reads "Waiting for your answer". `n` steps to the next ask. *Removed:* stalled, long run, repeat and loop from this block; `x: dismiss` on a permission.
- **CockpitNowWatch.** The all-clear line gains "· 2 things to watch". "Watch … no action needed": one dim row a thing (kind, then a sentence); the focused row shows `v: transcript  g: chat  x: dismiss`. No amber, no header change, no band alert. Limits: 60 min an agent, 120 min a turn. The long runner's time on its card turns bold, not amber.
- **CockpitNowIdle.** Mint `ALL DONE`, "Finished" + the result, the to-do bar full with one line, "This turn" (files changed, artifacts, agents), resting micro critters, notes. The only clock is the cache countdown.
- **CockpitBand.** Working: two rows (micro critter, "Working on" + focus, gauges as words; the to-do bar, "9 of 14 done · 2 agents working · nothing needs you", `/mc`). Asked: amber, who asks and what, "answer below". Watch: the same band plus "2 to watch". Idle: one dim line. One row at 64 and 40 columns. No hotkeys. *Removed:* clamps, pill, bead meters, the crew row.
- **CockpitTasks.** Header: "9 of 14 done", the pace sentence, the bar, "Effort so far" (one bar a task), the heaviest task. "Doing now" with its agents tethered as micro critters, "Up next", "Done" with tokens and time, `d: show all`. Enter opens the task page. *Removed:* the three-row PLAN strip, the PACE readout.
- **CockpitAgents** (list). Header: "2 agents working", finished and failed counts, the model share bar, total tokens. Toggle `l: List  t: Map  r: Working only`. "Working" as cards with tokens; "Failed" with the reason and `v g s`; "Finished" dim, three rows and `+ n more`; "Runs". Enter opens the agent page. *Removed:* the large line-up, ROLES, hull glyphs.
- **CockpitSteps.** `f: Find a step`, the total, chips `All  Kept  Errors  In view`, the activity map (errors red, rows in view bright), "This turn" with one failed step opened in place (`g k c`, `↵ full page`), a kept step with its note, "Earlier turns". `n`/`p` next error. Unchanged in features.
- **CockpitArtifacts.** Header: "Handoff", a filled `e: Export digest`, "It will hold" (a stack with a legend). "Artifacts" with one opened (`o c g`), "Files changed" with edit marks, "Kept". Enter opens the artifact page.
- **CockpitSlim** (26 columns, under 32). No tabs. Header (pill, headline on up to 3 lines), the all-clear line or Needs you with the command wrapped and the filled button, To do (bar, current, next), Agents (micro critters), Budget (two bars), Notes. Each title is a Button with `›`.
- **CockpitPalette.** Both grounds: swatches with their jobs, a sample pane, the type voices, the spacing rules.
- Not mocked this round: the inline strip (it takes Now's header left, To do and Agents right), the map, the budget view, Options and the four detail pages. They keep the rich spec's content and take this palette, the section head and the plain words.

## Changes against `mod/hooks/views/`

- `style.ts`: the palette above (`iris`, `irisSoft`, `irisDeep`; drop `orchid` from the pane); `DECK` columns become `{ text: 9, gauge: 40, gauge2: 51, right: 59, mid: 49 }`; `rateColor` unchanged.
- `raster.ts`: `ring` at 9 × 5 with the figure in the middle row and no name inside; `bar(cells, parts)` in `━`; `todoBar(total, done, current)`; `sprite` sizes 5 × 3 and 4 × 2 only (the large size and the line-up go); lintel without pill or readout.
- `parts.tsx`: `section(title, sum)` as title, hairline, sum (no `┌`, no caps); `header(...)` replaces `hero` and the deck rows; `agentCard`; `allClear`; the filled button (`Text` with `backgroundColor`) for the one primary action.
- `overview.tsx`: Now is header, needs slot, Watch, To do, Agents, Notes and decisions, with idle's "This turn". Delete the deck rows (NEXT, CREW, TASKS, STEPS, BUDGET), `LATEST`, the stale-focus swap's activity line, and the error count. Height rule: To do floor 3 (current, next, `+ n`), Agents 1 card, Notes 1; spare rows go to To do, then Agents, then Notes, up to 7, 3 cards and 4.
- `needs.tsx`: split in two. `needs` keeps only `asking` with a real permission (tool, command, asker) and `↵ go to prompt`; no `x`. New `watch.tsx` takes `long-run`, `stalled`, `repeat`, `loop`, `failed-turn`: dim rows, `v g x`, never the band lead, never autoFocus. Limits 60 and 120 min. An agent that is only thinking is neither.
- `fit.ts`: `doing(step)` maps a tool call to a verb phrase; `wrapWords` is used for the headline (2 lines) and slim (3); nothing ends in `…` while width remains.
- `tasks.tsx`: the header sentence and bar, "Effort so far" in place of PLAN, the three plain section names, tethered micro critters.
- `agents.tsx`, `agentmeta.ts`: cards for working, a reason line for failed, folded finished; the line-up and ROLES go; role names Explorer, Builder, Checker.
- `timeline.tsx`: plain heads ("This turn", "Earlier turns"), `Find a step`; otherwise as built.
- `artifacts.tsx`: Handoff as the header with the filled export button; "It will hold".
- `band.tsx`: the two-row band, the amber ask row, the one-line idle; no clamps, pill or beads; Watch never colours it.
- `slim.tsx`: the stack above; `budget.tsx`: two rings on Now (the third on the budget view), words under them.
- `guide.ts`: tell Claude to always keep a task list (task tools or the update tool) and to phrase focus as a plain clause.
- Tests: no row over `bodyColumns`; nothing in columns 0 to 1 or 60 to 61 but the marker; Now's tree has no step command, no step count and no error count; a thinking agent yields no need and no watch row; Watch rows carry no `warning` colour; the needs slot is at the same row with and without an ask; idle draws one band row.

## Open

- Whether `Text` `backgroundColor` accepts a tint as quiet as iris deep on every theme; else the open chip is bold with an iris underline.
- `↵ go to prompt` assumes focus can return to the permission dialog from the pane (`esc` does today).
- The critters and their props are the character round's; only the two sizes and the colour-by-state rule are fixed here.
