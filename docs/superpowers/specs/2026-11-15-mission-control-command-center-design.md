# Mission Control: command-center look, two variants

Date: 2026-11-15. Status: design only, for Aaron to choose between. Nothing is built.
Mocks: `CmdT*.dc.html` and `CmdH*.dc.html` in `…/scratchpad/mcstyles/project/`, made by `…/scratchpad/gen-cmd.js`.
The generator pads every row by character count and fails on any row over its column budget, so the mocks are honest about columns: pane rows are at most 62, the chat band at most 48, the strip at most 96.
Both variants build on the current look ("Calm accent"), not on the rejected Calm redesign. Both keep five tabs, accent labels, coloured status glyphs and the conciseness. They fix the problems found in real use.

## Shared by both variants

1. **Reading order on every screen:** headline, then alerts, then progress, then detail. Equal weight goes. Only the headline is bold, labels are small, and detail rows are plain or dim.
2. **Air:** one blank row between sections and never two. Rows inside a section have no blank rows between them, except two-line artifact rows in H.
3. **One right-hand column.** Meta (elapsed, tokens, agent type, age) is dim and right-aligned, ending at column `cols-2`. The last two columns are the affordance gutter: T draws a dim `›` there on every pressable row, and H reveals `→` on hover only. Elapsed time is never joined to a name (this fixes `…reducer3s`).
4. **One line per agent.** The row is glyph, type, task, model and tokens, then elapsed. The raw answer (`└ 17`) shows only in an opened row. `View` is no longer its own line: the row is the Button (Enter opens it), and an open row offers `s: Steps  v: Transcript`.
5. **Quiet zeros.** A count of zero is not written: `✖0` and `○0 queued` go, and an empty section is not drawn. A readout cell with nothing in it shows only its dim label.
6. **Short bars only.** Bars are 10 cells (14 for Tasks in T), never sized to `cols`. Counts sit next to the bar as numbers.
7. **Timeline groups are named by the prompt:** the first line, in quotes, with paths shortened to `…/<last>`. Never a raw `C:\…` path. Older turns fold to one line: `▸ "count .ts files in mod/"  13:02 · 12`.
8. **Hotkeys:** `1`-`5` for tabs. `f` find, `n`/`p` next or previous error (next or previous hit while finding), `g` jump to the step in chat. `l`/`t`/`r` for list, tree and live only. `s`/`v` on an open agent. `c` copy as Markdown, `q` quote in prompt, `e` export, `b` back. **Pin moves from `p` to `k`** (keep) because `p` now means previous. One dim key-hint line sits at the bottom, drawn only while `e.props.isFocused`.

## Variant T, "Telemetry" (mission console)

1. **A status header** tops every tab: `◆ MISSION CONTROL` on the left. On the right: `T+01:23  ●2 live  ✖1  ctx 9% 7d 22%` (time since the first prompt, live LED, faults, context, the tightest rate window).
2. **The tab bar has a track:** the open tab is filled (`suggestion` background, `inverseText`). The one rule on the screen sits under the bar: thin `─` in `subtle`, with a heavy `━` in the accent under the open tab.
3. **Instrument gutter:** sections are labelled in a 5-column left gutter with 3-letter codes (`NOW YOU TSK AGT LOG ART SYS`, and on Tasks `RUN QUE`). A section label costs no row of its own, and data starts at one column.
4. **LEDs mean state:** `●` green is live, amber `▲`/`?` is waiting on you, red `✖` is a fault, and a dim `✔` is done. Done items are never bright.
5. **Tables with dim caps headers** where rows compare (Agents, Artifacts): fixed columns for agent, task, model, tokens and time.
6. **Telemetry glyphs:** a segmented `■` bar (filled `success` or `warning`, the rest `subtle`), and a 12-bucket `▁▂▃▅▇` sparkline of steps per minute on LOG. Step numbers (`041`) and task ids (`#09`) are drawn as serials.
7. **Master caution:** when something waits on you, the header gains a filled amber `▲2 NEED YOU` chip and so does the band. YOU is the first section after NOW.

## Variant H, "HUD" (heads-up display)

1. **No header line.** The tab bar is the first row, and the open tab is accent, bold and underlined. No rule anywhere.
2. **A focus bar:** the headline and its `next` carry an accent `▍` in column 0. This is the one bold thing.
3. **Readout block:** right under the headline, up to five 12-column cells, each three rows: a dim caps label, a bold value, a mini graphic (`━─` bar, `▸▸○○○✖` LEDs, sparkline). It is the HUD's instrument cluster and replaces the Overview TASKS section and the budget bars.
4. **Corner-marked sections:** `┌ AGENTS` with the `┌` in the accent (warning for `┌ NEEDS YOU`), the label in bold caps and the meta dim on the right. Rows are indented 2 under the corner.
5. **Accent is line colour:** corners, the focus bar, running `▸`, the open tab and the open row's `│` rail. Status colour appears only for warning and error. Done rows have no glyph or a dim `✓`.
6. **Description first:** rows lead with what the agent or step is doing. Type, tokens and time are one dim run on the right, with no column headers.
7. **More negative space:** wider tab gaps (3), readout cells with breathing room, and two-line artifact rows with a blank row between them.

## Tab bar (plain hotkeyed Buttons; the engine draws `1: Label`)

| Width | T | cols | H | cols |
|---|---|---|---|---|
| ≥ 56 (62 shown) | `1: ▐OVERVIEW▌  2: TASKS  3: AGENTS  4: LOG  5: ARTIFACTS` gap 2, open tab padded | **56** | `1: Now   2: Tasks   3: Agents   4: Steps   5: Artifacts` gap 3 | **55** |
| 38-55 (40 shown) | `1: ▐OVR▌ 2: TSK 3: AGT 4: LOG 5: ART` gap 1 | **36** | `1: Now  2: Tas  3: Age  4: Ste  5: Art` gap 2 | **38** |
| 24-37 | `1: ◆ 2: ▣ 3: ◎ 4: ≡ 5: ↗` gap 1, open icon filled | **24** | same icons, open accent and underlined | **24** |

Under 38 columns the open tab's name moves into the header (T: `◆ AGENTS ●2 ✖1`) or the first section label (H). The icons double as the tab glyphs in the band and the docs. The bar never wraps: `flexWrap` is dropped from the tab Box, and the width tier is chosen from `bodyColumns`. Old words still work (`/mc overview`, `timeline`, `5`), and `/mc log` and `/mc now` are added.

## Type, colour and spacing scale (theme keys only)

| Role | T | H |
|---|---|---|
| Headline | bold, `NOW` code bold accent | bold, accent `▍` |
| Section label | 3-letter accent code in the gutter (`YOU` warning, `QUE`/`SYS`/`FIL` dim) | `┌` accent + bold caps |
| Rows | normal; done rows dim | normal; done rows dim |
| Meta, tool names, units | `dimColor` | `dimColor` |
| Live | `success` `●` | `suggestion` `▸` |
| Waiting on you | `warning` `?` `▲`, filled chip `backgroundColor: warning` | `warning` `?` `▲` and corner |
| Fault | `error` `✖` | `error` `✖` |
| Artifact kinds | page `suggestion` `↗`, doc `merged` `▤`, result `success` `◆` | dim on Now; coloured as T on the Artifacts tab |
| Bars | `■` fill `success` (rate windows `suggestion`, `warning` at ≥70 %, `error` at ≥90 %), rest `subtle` | `━` fill accent, rest `─` `subtle`, same thresholds |
| Find hit | `suggestion` + `underline` | same |
| Action without hotkey (`show`, `×`) | dim + `underline` | same |

Spacing: tab bar, then (T) its track; one blank row; sections separated by exactly one blank row (`rowGap={1}` on the body Box). T content starts at column 5 (gutter), H at column 2. Second lines: T `┊` rail at column 5 or 1, H `│` rail at column 2. Under 48 columns the T gutter label moves onto its own line, and the H readout drops to three cells and then to `label value` rows.

## Screens: what shows, and what is one press away

**Overview (T `OVERVIEW` / H `Now`).** T: header; NOW (headline, `next`, the 2 newest notes as dim `·` lines); YOU when there are problems (one row each, `×` to dismiss, a hint `g jump · n/p step through`); TSK (bar, `9/14`, `▸ 1 active ·
4 queued`); AGT (counts, then the running agents one line each); LOG (sparkline, steps, files, errors, newest 3 steps with `◂`); ART (newest 2); SYS (ctx and 5h bars, 7d and reset, opus total). H: focus bar; NEEDS YOU; readout (TASKS
AGENTS STEPS CTX 7D, with 5H instead of 7D when it is the hotter window); AGENTS; LATEST (3); NOTES (2); ARTIFACTS (2).
One press: any section label or `›` opens its tab. An agent row opens Agents with that row open. A step opens it in
LOG/Steps. SYS (T) or the CTX cell (H) opens the budget readout in place (every window, its reset, the per-model totals).

**Tasks.** T: bar row with `64%`; `✔ 6 earlier  show`; the last 3 done dim with `#id`; RUN with the active task bold and its agents one line each; QUE with `○ #id` rows; SYS with started time and `/mc export`. H: readout (DONE ACTIVE QUEUED
ELAPSED); `┌ ACTIVE` (task, then `type · task` per agent); `┌ QUEUED`; `┌ DONE 9 show all` with the 3 newest and `+ 6 earlier`. One press: `show` unfolds the done list, and an agent line opens it on Agents.

**Agents (list).** T: counts plus `l: LIST t: TREE r: ○ live only` on one row; a caps header; one row per agent (`main` first); one row opened with its answer on a `┊` rail and `s: steps v: transcript`; RUN `≡ review-branch workflow · 6 agents · ✖1 6m`; Σ line with per-model totals and ctx. H: readout (LIVE DONE FAILED OPUS HAIKU); `┌ AGENTS` with the toggles; the same rows description-first; `┌ RUNS`. One press: a row opens in place, a run opens the run board, `t` the tree. The tree keeps today's `!` marks, folded counts and live only, drawn with the variant's row and rail.

**Timeline (T `LOG` / H `Steps`) with find.** T: LOG row (sparkline, steps, turns, errors); FND row (`› query▌`, `7 hits n/p`); chips `ALL 7 PINNED 1 ERRORS 1 ◂ ON SCREEN 2` (the active one filled, zero chips hidden). The newest turn open, step rows `041 ✖ Bash  npm test -- timeline  general-purpose 4s`. H: `/ query` with `7 of 52 n/p`; underlined active chip; the turn under a `┌ "prompt"` corner; no serials. **A step opens inline** under its row on a rail: a meta line, the first 5 lines of Result, `… n more lines`, and the actions `g: Show in chat  k: Pin  c: Copy as Markdown  q:
Quote`. Enter on an open step goes to the full detail (today's `detail.tsx`: Change, Result, Input). `◂` marks rows on screen. Folded turns show hit counts while finding.

**Artifacts (top level again).** T: count row; kind chips; caps header; one row per artifact (kind glyph, kind word, title, `×3` rewrites, age) with its ref or summary dim under it; FIL (files changed by code edits, `4: LOG ›`); OUT (`e: export digest`, last export path). H: two-row readout (PAGES DOCS RESULTS FILES EXPORT); `┌ ARTIFACTS` two-line rows with air; `┌ FILES CHANGED` on one line; `┌ HANDOFF`. One press: Enter opens the artifact's step, else copies the ref; `e` runs `/mc export`.

**Band.** T: `◆ 9/14 ▸ focus │ ●2 live │ ✖1 │ ctx 9% 7d 22% │ T+01:23` with `/mc` on the right. Waiting leads with the filled `▲2 NEED YOU` chip. Done is one dim row. H: `▍9/14  focus  2 live · 1 error · ctx 9%` with `/mc` on the right. Waiting leads with bold amber `▲ 2 need you`. Done is dim. Both drop parts in this order: budget, clock, `/mc`, agents, then the focus is cut. No digit hotkeys in the band.

**Inline strip (under 110 columns, `rows: 14`).** T: the header and tab bar share row 1, then the track; two columns from 80 body columns (left NOW, TSK, SYS; right AGT, LOG); a key-hint line. H: the tabs with `ctx 9% · 7d 22%` on the right; left the focus bar and two readout lines, right `┌ AGENTS` and `┌ LATEST`. Both use about 11 of the 14 rows. The other tabs draw as docked and scroll.

## Where each feature lives

- **Needs you:** T YOU section, header chip and band chip. H `┌ NEEDS YOU` corner in warning and the band lead. In both, `!` in the tree, `n`/`p` steps through, `×` dismisses, and `autoFocus` goes on the first row.
- **Find and jump:** the find row tops LOG/Steps (`f`, `/mc find <text>`). Hits are underlined in the accent. `g` jumps to the step in chat from an open step or a YOU row. `◂` is in the right column.
- **Budget:** T header (ctx and the tightest window), SYS section, Σ line. H CTX/7D/5H readout cells. In both, model and tokens on every agent row, per-model totals on Agents, the budget readout one press away, and the existing toasts.
- **Handoff:** `c: Copy as Markdown` and `q: Quote` on every open step. `e: export digest` and the last export on Artifacts. `/mc export` from the prompt.
- **Run board:** the RUN row (T) or `┌ RUNS` (H) on Agents opens today's board, restyled with the same rail.
- **Agent tree:** `t` on Agents, `r` live only, and `!` on problem nodes and folded ancestors (unchanged logic).
- **Keyboard:** the hotkey map above, the focused-only hint line, and `/mc 1-5 | <tab> | find | pin | export | close`.

## Changes per view file (`mod/hooks/views/`)

- `style.ts`: add `C.live` (T `success`, H `suggestion`), `C.wait` (`warning`), `C.track` (`subtle`) and a `VARIANT` constant. `glyphColor('done')` returns undefined (dim).
- `fit.ts`: `shortBar(done, total, cells, glyph)` instead of `blockBar`; `spark(counts)` with 8 levels `▁…█`; `shortPaths(text)`; `promptTitle(text)` (first line, quoted); `gutter(code)`.
- `parts.tsx`: `sectionLabel` (T: gutter `Box` width 5 beside a column `Box`; H: `┌ LABEL` row with right meta); `metaRow(left, right, cols, affordance)` reserving the 2-column gutter; `rail(children)`; `readout(cells)` (H); `hint(keys)`. Remove `sectionHeader` and its rule.
- `shell.tsx`: three tab tiers by `bodyColumns`; no `flexWrap`; no `│` separators. T adds the header row and the track `Text`, H marks the open tab with a bold underlined accent child. The focused-only hint. `tabFor` accepts `log`/`now`.
- `overview.tsx`: section order NOW, YOU, TSK, AGT, LOG, ART, SYS (T) or focus, NEEDS YOU, readout, AGENTS, LATEST, NOTES, ARTIFACTS (H). The tasks section becomes one row. Notes join NOW in T. Keep two columns for the inline strip only.
- `needs.tsx`: one row per problem with dim age and `×`. Feeds the header chip (T) and the band lead.
- `budget.tsx`: `budgetSection` becomes SYS (T) or readout cells (H), and the opened readout keeps today's rows. `modelsSection` becomes the Σ line (T) or OPUS/HAIKU cells (H).
- `tasks.tsx`: done fold (last 3 plus `show`), RUN with agents one line each (no raw `doing` output), QUE capped at 5, `#id` serials (T).
- `agents.tsx`, `agentmeta.ts`: one-line row in fixed columns (T) or description first (H). `ui.agentOpen` for the open row with answer and `s`/`v`. Drop the `└` answer line and the `View` line. Workflow runs become one RUN row.
- `tree.tsx`: the same row and rail; no `View` line; `!` and folded counts kept.
- `runboard.tsx`: rail and short strips; `b: Back` row unchanged.
- `timeline.tsx`, `find.ts`: FND row and chips with zeros hidden; `promptTitle` for turn headers; step serials (T); `ui.stepOpen` for the inline open step; hit counts on folded turns; `n`/`p` walk hits while a query is set.
- `detail.tsx`, `openstep.ts`, `handoff.ts`: the full detail stays as the second press. Shared action row `g k c q`. Pin hotkey `k`.
- `artifacts.tsx`: kind chips, the table (T) or two-line rows (H), the FIL and OUT sections. Identity keys unchanged.
- `band.tsx`: the new parts and drop order; the T chip uses `backgroundColor: warning`, `color: inverseText`.
- `onscreen.ts`: none (feeds `◂`).
- State: `UiState` gains `agentOpen?`, `stepOpen?`, `liveOnly` (list and tree share it). Restore defaults where `ui` is restored.
- Tests: header, label and glyph-colour assertions change with each view. The 24-column floor, the 14-row strip and the surface loops stay. Add a test that the tab row fits in one line at 62, 40 and 24.

Buildability notes: no Box inside a Button (rows are Buttons of strings and `Text`; rails and gutters are siblings).
The H hover arrow is a keyed row `Box` with a child `display: "none"` and `hover: { display: "flex" }`; keyboard focus already inverts the Button. The T track is one `Text` of three coloured children measured from the label widths. Text `size: 'heading'` on the headline is a desktop nicety, and the terminal ignores it.

## Artboards

- `CmdTOverview.dc.html`: T Overview, busy: header telemetry, NOW with notes, TSK, AGT, LOG with sparkline, ART, SYS.
- `CmdTOverviewWaiting.dc.html`: T Overview with two problems: `▲2 NEED YOU` chip, YOU section, 5h at 78 % in amber.
- `CmdTTasks.dc.html`: T Tasks: done fold with serials, RUN with its agents, QUE, SYS.
- `CmdTAgents.dc.html`: T Agents: caps table, one row opened with answer and `s`/`v`, RUN row, Σ totals.
- `CmdTLog.dc.html`: T Log: find `timeline`, chips, prompt-titled turn, the failed Bash opened inline, folded turns.
- `CmdTArtifacts.dc.html`: T Artifacts: kind chips, table of three, FIL files changed, OUT export.
- `CmdTBandStrip.dc.html`: T band (working, waiting, done, 40 columns), tab bars at 40 and 24, the 96-column strip.
- `CmdHNow.dc.html`: H Now, busy: focus bar, five-cell readout, AGENTS, LATEST with a hovered row, NOTES, ARTIFACTS.
- `CmdHNowWaiting.dc.html`: H Now with two problems: amber `┌ NEEDS YOU`, readout with 5H at 78 %.
- `CmdHTasks.dc.html`: H Tasks: readout, ACTIVE with agents, QUEUED, DONE folded.
- `CmdHAgents.dc.html`: H Agents: readout, description-first rows, one opened on a rail, RUNS.
- `CmdHSteps.dc.html`: H Steps: `/ timeline` find, chips, `┌ "prompt"` turn, a step opened inline, folded turns.
- `CmdHArtifacts.dc.html`: H Artifacts: readout, two-line rows with air, FILES CHANGED, HANDOFF.
- `CmdHBandStrip.dc.html`: H band (working, waiting, done, 40 columns), tab bars at 40 and 24, the 96-column strip.
