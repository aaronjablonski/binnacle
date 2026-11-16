# Mission Control: Neo restyle plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Restyle the HUD v2 views to Neo (Aaron: "the neo redesign is sick, let's build it like this", 2026-11-15): decks with twin brackets, the pod crew, dials, `▮▯` bars, pips, pills, tethered trees, the three-row band.

**Spec:** `docs/superpowers/specs/2026-11-15-binnacle-neo-design.md` (binding), on top of `2026-11-15-binnacle-hud2-design.md` (grid, keys, commands, features unchanged). **Mocks:** canvas top row `Neo*` (https://claude.ai/artifact/R4JHk79nyTdVVFszFwfKsb); sources `scratchpad/mcstyles/project/Neo*.dc.html`, generator `scratchpad/gen-neo.js` (column constants, glyphs, colours).

## Global Constraints

- Everything in `docs/superpowers/plans/2026-11-15-binnacle-hud2.md` Global Constraints still binds (grid, ≤ bodyColumns, no mid-word cuts, no Box in a Button, theme keys only, identity keys, render writes no state, the six commands, anti-goals).
- Deck rows: rails at column 0 and the last column; label in cell 1; gauge at 14, value at 38, aside at 50 (ends by 59). A bracket that opens also closes.
- Bars exactly 10 or 22 cells; crew rows never pass column 36 in a table deck; pods pitch 3; ≤ 7 pods in the pane (then 6 + `+n`), ≤ 12 in the band.
- Hull glyphs only through `podOf`; an ASCII fallback set lives behind one constant in `style.ts`.
- Pulse uses the existing 1 s clock (`ctx.now` parity); no new timers.
- Narrow tiers (38–61) for decks: drop the aside, then the value (spec's open point).
- Behaviour tests keep passing; look tests are rewritten to the Neo structure (named in reports).

## Tasks and waves

| Task | Scope | Model | Wave |
|---|---|---|---|
| N1 | Foundation: `style.ts` (HULL, `roleOf`, `podOf`, `dialOf`, RAIL, ASCII fallback, `C.spark`), `fit.ts` (`bar` ▮▯ 10/22, `pips`, `spark(n)`, `crewRow`, `meter`), `parts.tsx` (`deck`, `pill`, `row` tether prefix) | Opus | 1 |
| N2 | Now, needs, budget view, slim head/crew/pips, strip: `overview.tsx`, `needs.tsx`, `budget.tsx`, `slim.tsx` | Sonnet | 2 |
| N3 | Agents deck (CREW, ROLES, MODELS), list hulls, tethered tree, run board hulls: `agents.tsx`, `agentmeta.ts`, `tree.tsx`, `runboard.tsx` | Sonnet | 2 |
| N4 | Tasks deck + tethered agents, Steps FIND/SHOW deck + chip pill, Artifacts HANDOFF/KEPT deck + `✦`: `tasks.tsx`, `timeline.tsx`, `find.ts`, `artifacts.tsx` | Sonnet | 2 |
| N5 | Band: three-row / compact / all-done forms and the pick rule; pane-open flag set by `/mc` open/close and the person's close: `band.tsx`, `shell.tsx` | Sonnet | 2 |

Wave 2 owns disjoint files and runs in parallel. Then one Opus review of N1–N5, then the final adversarial whole-branch pass.

### Task N1: foundation
Per the spec's "Identity" and the `style.ts`, `fit.ts`, `parts.tsx` lines of its change list. Keep HUD v2 helpers wave 2 still imports (`@deprecated` where replaced, e.g. `bar10`). vitest: `roleOf` per agent type family, `podOf` for every role × state (queued, working, waiting `?`, stalled `z`, failed `!`, done) incl. colours, `dialOf` thresholds, `bar` 10/22 rules (non-zero ≥ 1, only 100 % full), `pips` incl. > 22 → bar, `spark` bucket counts, `crewRow` pitch and `+n`. Plugin tests: a `deck` row's rails at 0 and the last column at 62/40/32, label/gauge/value/aside on their stops, aside then value dropped at narrow tiers, `pill` uses `backgroundColor` + `inverseText`, `row` tether prefix columns.

### Task N2: Now
Spec "Now", "Now, waiting", "Budget view", "Slim", "Inline strip". Tests: deck rows and order, pods pulse on clock parity, NEEDS YOU warning bracket + pill first, BUDGET dials, budget view with 22-cell bars and share tables (no dollar figure), slim head/crew/pips at 20/24/28, strip left-only deck ≤ 11 rows.

### Task N3: Agents
Spec "Agents, list", "Agents, tree". Tests: CREW/ROLES/MODELS deck, hulls via `podOf` as row glyphs, `!`/`?`/`z` signals in the gutter, tree tethers `├╌ ╰╌ ┆`, role in the opened row.

### Task N4: Tasks, Steps, Artifacts
Spec "Tasks", "Steps", "Artifacts". Tests: TASKS/PACE deck, `▸ ▫ ▪` glyphs, agents tethered under the active task, FIND/SHOW deck with the chosen chip as a pill, HANDOFF/KEPT deck at the top, result glyph `✦`.

### Task N5: Band
Spec "Band". The mod must know whether the pane is open: a `ui.paneOpen` boolean written on `/mc` open, `/mc close`, `/mc slim` and the person's close (observe `ui.close`), restored false. Tests: three rows at ≥ 86 columns with the pane closed; compact one row when the pane is open or < 86; waiting form; all-done form; drop order; no Buttons.
