# Task list

Updated 2026-11-15. Plans live in `docs/superpowers/plans/`; the working ledger is `.superpowers/sdd/2026-11-15-mission-control-mod/progress.md`.

## Done

- [x] v1: scaffold and probe, model and reducer, capture and journal, guide, pane, Overview, band, Tasks, Agents, tree, Timeline, detail, pins, Artifacts, README, CI
- [x] Record survives `/clear` and `--resume`
- [x] Calm-accent restyle and `/mc <tab>`
- [x] Features: needs-you queue, find and jump, budget line, handoff export, workflow run board, agent tree upgrade, on-screen marker
- [x] False-alarm fixes (asks, restored snapshots, loop/repeat)
- [x] `/mc` trimmed to `/mc`, `/mc 1-5`, `keep`, `export`, `close`, `slim`
- [x] HUD v2 rebuild (H1–H5): grid, tabs, slim mode, Keep, keys
- [x] Local marketplace manifest (live install with `/plugin` + `/reload-plugins`)
- [x] Visual README draft (`README.draft.md`, `docs/readme/`)

## In progress

- [x] HUD v2 fix round and re-check (footer fitting, open in place, Keep export, word-safe types)
- [x] Neo N1: foundation (pods, dials, `▮▯` bars, pips, deck frame, pills)

## Next: Neo restyle (`plans/2026-11-15-mission-control-neo.md`)

- [x] N2: Now deck, NEEDS YOU bracket, budget view, slim head, strip
- [x] N3: Agents CREW/ROLES/MODELS deck, hulls, tethered tree
- [x] N4: Tasks deck with tethered agents, Steps FIND/SHOW deck, Artifacts HANDOFF/KEPT deck
- [x] N5: three-row / compact / all-done band
- [ ] Opus review of N1–N5

## Then: navigation pass (`plans/2026-11-15-mission-control-navigation.md`)

- [x] V1: focus starts in the content, keyboard skips the tab bar (tabs by 1–5 / click), Down walks the active tab top to bottom

## Now: Neo Rich build (`plans/2026-11-15-mission-control-neo-rich.md`), includes the distilled features

- [x] R1a raster engine + paint clock · D1 distilled data
- [x] R1b style/fit/parts/editor/shell routing
- [x] R2 Now/needs/budget/slim/strip · R3 Agents + crew map · R4 Tasks + Steps pages · R5 Artifacts + band · R6 Options + desktop Svg
- [ ] R7 delights + Accent
- [x] Opus review + fix round
- [ ] Aaron's live check
- [ ] Next: calm cockpit restyle + chosen crew family + NEEDS YOU/WATCH split + task-list guide (awaiting Aaron's picks)

## (superseded by Neo Rich) distilled features (`plans/2026-11-15-mission-control-distilled.md`)

- [ ] D1: data (pace samples, cache usage, per-task tokens, long run, done turns, ledger)
- [ ] D2: budget view and Now (Pace, Cache, warm countdown, This week ledger + CSV, session cost, This turn)
- [ ] D3: Tasks plan strip, Agents Roles, Long run in NEEDS YOU, done notification + sound option
- [ ] D4: Options card (`,`), after a reload spike
- [ ] D5: quiet delights (clean-run sweep, round-number toasts) and Accent option
- [ ] Opus review of D1–D5

## Release prep

- [ ] Choose a new name (Mission Control is taken by several Claude Code mods) and rename plugin, pane id, tool, `/mc`, docs
- [ ] Merge `README.draft.md` into `README.md`; regenerate renderings for Neo (`node docs/readme/gen.js`)
- [ ] Licence, author, icon (512–2048 px PNG); GitHub remote for badges
- [ ] Remove personal names from tracked docs (`HANDOVER.md`)
- [ ] Triage deferred minor findings (listed in the ledger)
- [ ] Final adversarial whole-branch review (Opus), fixes, PR
