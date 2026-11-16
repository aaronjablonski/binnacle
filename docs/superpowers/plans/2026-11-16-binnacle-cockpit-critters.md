# Mission Control: calm cockpit + Critters build plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal (owner, 2026-11-16):** "go forward with the calm cockpit polish together with the critters." Restyle every screen to the cockpit, draw the crew as family A Critters, split NEEDS YOU from Watch, push the task list through the guide, then quiet delights and Accent (R7).

**Specs (binding):** `docs/superpowers/specs/2026-11-15-binnacle-cockpit-design.md` (look, words, screens, its "Changes against `mod/hooks/views/`" is the file list) and `docs/superpowers/specs/2026-11-15-binnacle-crew-design.md` (family A only; sizes, states, deck and map rules). Features from `rich-design.md` and HUD v2 stay. **Mocks and generators (reference for shapes, cells, colours, pixel grids):** `.superpowers/sdd/2026-11-16-cockpit-critters/ref/` (`gen-cockpit.js`, `gen-crew.js` with `FAM.A`, `cockpit-preview/*.png`, `crew-preview/*.png`). Independent DX reviews: `.superpowers/sdd/2026-11-16-cockpit-critters/fable-round{1,2,3}.md`.

## Owner rulings

1. **Critter hue:** role hues (lead ember `#e07b53`, scout teal `#3fbdb4`, build iris `#8a9bff`, check orchid `#b48cf2`; day values from `gen-crew.js` `DAY`) inside the Raster pixel art only. Text and every non-sprite element use the cockpit palette (one iris accent; ember not used in text for roles; no orchid in text).
2. **Tool names in narrow columns:** short names (`Hand`, `Todo`, `Nb`, ...: one table in `fit.ts`) at middle widths; the tool column is dropped below 40 body columns.
3. **Full build overnight** including R7.
4. Queued earlier: NEEDS YOU = real permission prompts only (marked on `classic.PermissionRequest`, matched by tool and input hash, as built in 825bdca), with `↵ go to prompt` and the tool and command; no `x` on a permission. Watch = long run, stalled, repeat, loop, failed turn: dim, `v g x`, never the band lead, never autoFocus, never notifies. Defaults `agentLimitMin` 60, `turnLimitMin` 120. An agent that is only thinking yields neither.

## Controller rulings (mine; recorded in the ledger)

- No hero size: the cockpit says no large character. Sizes are small 3×5 (cards, header, map nodes) and micro 2×4 (tethers, slim, band, short panes). The old large sprite and line-up go.
- Crew map bands use plain words ("Now", "Done", "Up next") and dim lowercase column heads, keeping the crew spec's table columns.
- Done critters are grey with a trace of the hue (crew spec), dim per the cockpit.
- Pages cannot hold a Raster: pages show the text fallback glyph for a critter.

## Fidelity bar (owner, 2026-11-16: "we really need to achieve the visual quality and cleanliness of the latest UI mocks")

- The mocks are the acceptance test. Each screen task renders its real views at 62 columns (and the narrow widths the mock shows) with the mock's session data, and compares them cell by cell with the generator's output (`gen-cockpit.js` / `gen-crew.js` model every board as terminal cells). Put the dump in a fidelity test (`*.fidelity.test.tsx`) that prints both side by side on failure, and keep it passing. Differences are allowed only where real data differs from mock data, and each is listed in the report.
- Same columns, same blank rows, same words, same colour roles, same glyphs as the mock. No extra labels, counters, separators or hints the mock doesn't have. Nothing cut that the mock shows whole.
- Every task report includes the rendered 62-column text of each screen it touched.

## Global Constraints

- Everything in the HUD v2, Neo and Neo Rich plans' constraints still binds: ≤ `bodyColumns`, no mid-word cuts and no `…` while width remains, theme keys for text, identity keys, render writes no state, hooks observe, side effects only on press or command, Raster only where `lookOf` says so and always with a same-size text fallback, no Button sharing a cell with a Raster, ≤ 2 colours per Raster cell, one 1 s paint clock that stops when nothing is live, Svg < 131072 chars with `alt`, worst-case Timeline < 2,500,000.
- Cockpit columns: gutter 0–1 (only `▍` marker and `◂`), content 2–59, gutter 60–61 at 62 columns; narrow tiers scale per the spec.
- Every critter cell comes from `FAM.A` grids in `gen-crew.js` (port exactly: shape per role and size, `tone` per state and frame, `cellsOf` to quadrant glyph + fg + bg).
- Tests keep behaviour; look tests are rewritten to the cockpit structure and named in the report. No fixture bent to hide a defect, no test weakened; say so if a test changes meaning.
- Agents that edit the same files run one at a time; commit by path; commit messages carry no attribution lines.

## Tasks and waves

| Task | Scope | Model | Wave |
|---|---|---|---|
| C1 | Foundation: `style.ts` (cockpit palette, role hues for sprites, `DECK` columns), `raster.ts` (Critters sprites small/micro × 4 roles × 6 states × 2 frames × 2 grounds from `FAM.A`; ring 9×5; `bar` in `━`; `todoBar`; lintel without pill; drop large size and line-up), `fit.ts` (`doing(step)` verbs, `wrapWords` headline 2 lines / slim 3, short tool names + drop rule), `parts.tsx` (`section`, `header`, `agentCard`, `allClear`, filled button) | Opus | 1 |
| C2 | Alert model + guide: `needs`/`watch` data split in the model and selectors, limits 60/120, no band lead or notify for Watch, thinking agent yields nothing; guide wording (task list first for requests of 3+ steps; wording chosen by whether `e.tools` offers the task tools), update tool `tasks` field mapped into the task list (bounded like the rest), one real haiku headless check of the guide | Opus | 1 |
| C3 | Now (busy, needs you, watch, idle), `needs.tsx`, new `watch.tsx`, `budget.tsx`, `slim.tsx`, strip (`stripband.tsx`) | Sonnet | 2 |
| C4 | Agents list (cards, failed reasons, folded finished, runs), crew map per crew spec "Crew map rules", agent page: `agents.tsx`, `agentmeta.ts`, `tree.tsx`, `crewnode.tsx`, `runboard.tsx` | Sonnet | 2 |
| C5 | Tasks (header sentence, Effort so far, Doing now / Up next / Done, tethered micro critters), Steps heads, Artifacts (Handoff header, filled export, It will hold), pages: `tasks.tsx`, `timeline.tsx`, `find.ts`, `artifacts.tsx`, `handoff.ts`, `detail.tsx` | Sonnet | 2 |
| C6 | Band (two-row working, amber ask, watch count, one dim idle line, one row at 64/40), desktop Svg in the cockpit palette with Critters: `band.tsx`, `svg.ts`, `svgview.tsx` | Sonnet | 2 |
| C7 | R7 quiet delights (clean-run sweep once per session, never while needs has rows; round-number toasts) and Accent option (structural colour to a theme key): `style.ts`, `shell.tsx`, `options.tsx` | Sonnet | 3 |

Wave 2 runs one task at a time (shared test kit). After wave 2: Opus review of C1–C6, fix round, then milestone `milestone-screens.md` (Fable round 2), fixes from round 2, C7, Opus whole-branch review, fixes, milestone `milestone-final.md` (Fable round 3), its fixes, then the owner's live check.

### Task C1: foundation
Per the cockpit spec's style/raster/parts/fit lines and the crew spec's sizes and states. Tests: every sprite exactly 5×3 / 4×2 cells for all roles × states × frames × grounds with ≤ 2 colours a cell; role identity differs between roles at both sizes; state recolour rules (queued 62 %, stalled 42 %, failed 50 % toward ground, done grey, badges `? z !`); `doing` maps Read/Grep/Glob/Bash/Edit/Write/Agent/thinking/asking to the spec's verbs; `wrapWords` never cuts a word and never ends in `…` while width remains; short tool names at middle widths and the column dropped below 40; `section` is title, hairline, sum with no caps and no `┌`; `header` puts gauges at 40 and 51 and the headline at 9, 29 wide; nothing in gutters but the marker.

### Task C2: alert model and guide
Tests: a permission request yields one need with tool, command and asker, and clears when answered; long run (60/120 defaults, 0 disables), stalled, repeat, loop and failed turn yield Watch rows and no need; Watch never leads the band, never notifies, never autoFocuses; a thinking agent yields neither; guide text with task tools present names them, without them names the update tool's `tasks` field; the `tasks` field adds and updates tasks in the task list within bounds; text stable across calls (prompt cache). Report the haiku headless check's transcript excerpt.

### Task C3: Now
Cockpit screens CockpitNow, CockpitNowNeedsYou, CockpitNowWatch, CockpitNowIdle, CockpitSlim, and the strip. Tests from the spec's Tests line: Now's tree has no step command, step count or error count; the needs slot is at the same row with and without an ask; Watch rows carry no `warning` colour; height rule (To do floor 3, Agents 1, Notes 1; spare to To do up to 7, Agents up to 3 cards, Notes up to 4); slim at 26 columns.

### Task C4: Agents and crew map
CockpitAgents plus crew spec "CREW deck" and "Crew map rules" (35 agents fit 33 rows at 62 columns; only live agents get a character; done fold to role-hue pips and `+ n done`; flagged agents never fold; table columns STATE 41, tokens to 54, time to 61; `d` unfolds). Tests for each rule.

### Task C5: Tasks, Steps, Artifacts, pages
CockpitTasks, CockpitSteps, CockpitArtifacts; pages take the palette, section heads and plain words. Tests: header sentence and bar, Effort so far one bar a task, three plain section names, tethered micro critters under Doing now, `d: show all`; Steps heads and chips; Handoff header with the filled export button.

### Task C6: Band and desktop Svg
CockpitBand. Tests: two rows working; amber ask row with who and what; watch count without colour; idle one dim line; one row at 64 and 40; no Buttons, no clamps, no pill, no beads. Svg under the limit with `alt`, cockpit palette, Critters at small size, presses kept.

### Task C7: delights and Accent
Distilled plan D5. Tests: the sweep runs once per session and never while needs has rows; toasts at round numbers only once each; Accent maps the structural colour to the chosen theme key and defaults to iris (`suggestion`).
