# Mission Control: Neo Rich build plan (with the distilled features)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Build Neo Rich as mocked (Aaron: "yes build neo rich like this", 2026-11-15): Raster crew characters, Braille rings, bead meters and framed decks in the terminal; one Svg deck and band on the desktop app; the built Neo text form as the fallback everywhere else. Fold in: detail pages for every primitive, open in editor, filling the height, stale focus, the crew map, the wide strip, and all eight distilled features.

**Spec:** `docs/superpowers/specs/2026-11-15-mission-control-rich-design.md` (binding; its "Changes against the Neo views" is the file list) over the Neo and HUD v2 specs. Distilled features: `docs/superpowers/notes/2026-11-15-feature-distillation.md` and `plans/2026-11-15-mission-control-distilled.md` (D1–D5). **Mocks:** canvas rows "Neo Rich" and "Neo Rich, round 2"; generator `scratchpad/gen-rich.js` (the shapes, Braille dots, palette and cell rules are the reference).

## Binding rules added by Aaron's feedback

1. Text uses all the width up to the next column; the headline wraps to two lines before it is cut; cuts land on words only.
2. Lists grow with `scroll.bodyRows` (`sectionRows`), one blank row between sections and never two.
3. A stale focus (older than 10 min with newer steps) dims with its age; the latest activity leads.
4. Entering a task, agent, step or artifact opens a full page (`ui.page`): nothing truncated, all metadata, related items, actions; `b`/Esc back.
5. Every file a step or artifact names gets `o: open`: `$.process.run([editor, '-r', '-g', 'path:line'])` on the press only; option `editor` (default `code`); on failure, copy the path and toast why. Images open the same way (the editor's preview).
6. The Agents Tree is the crew map (by task, then run, then parent).

## Constraints

Everything in the HUD v2 and Neo plans' Global Constraints. Raster only where the surface's element table has it (`lookOf`); every Raster has a same-size text fallback; no Button shares a cell with a Raster; at most two colours per cell; blit only changed keys from one 1 s clock that stops when nothing is live; Svg under 131072 characters with an `alt`. Ledger: Aaron took all distilled features (overrides the cost-analytics non-goal for it). Hooks observe; side effects only on press or command.

## Tasks and waves

| Task | Scope | Model | Wave |
|---|---|---|---|
| R1a | `raster.ts` (Grid, quadrant/Braille pickers, encode, sprites ×4 roles ×6 states ×2 sizes, beads, stack, bars, ring, rpill, lintel, sill, palettes) and `paint.ts` (the one clock owner, blit on change) — ported from `gen-rich.js` | Opus | 1 |
| D1 | Distilled data (plan D1): pace samples, cache usage, per-task tokens/time, long run, done turns, ledger rows, `lastExport`; selectors | Opus | 1 |
| R1b | `style.ts` (`RICH`, `lookOf`, `spriteOf`), `fit.ts` (`levels`, `beadCount`, `sectionRows`, `compartments`), `parts.tsx` (`inst`, rich `deck`, `hero`, `page`), `editor.ts` (`openInEditor`, option `editor`), `shell.tsx` (look per draw, `ui.page` routing, `,` reserved for Options) | Opus | 2 |
| R2 | Now, needs, budget view (rings, pace, output, cache, cost, shares, this week), slim, strip compartments: `overview.tsx`, `needs.tsx`, `budget.tsx`, `slim.tsx` | Sonnet | 3 |
| R3 | Agents line-up/roles/models, agent page, crew map: `agents.tsx`, `agentmeta.ts`, `tree.tsx` | Sonnet | 3 |
| R4 | Tasks (plan, pace, task page) and Steps (map, step page with files and `o`): `tasks.tsx`, `timeline.tsx`, `find.ts`, `detail.tsx`, `openstep.ts` | Sonnet | 3 |
| R5 | Artifacts (digest, artifact page) and the rich band: `artifacts.tsx`, `handoff.ts`, `band.tsx` | Sonnet | 3 |
| R6 | Options card (`,`; spike the reload question) and the desktop Svg (`svg.ts`): `options.tsx`, `svg.ts` | Opus | 3 |
| R7 | Quiet delights and Accent (plan D5) | Sonnet | 4 |

Then one Opus review of the whole build, Aaron's live check (`/reload-plugins`), and the final adversarial whole-branch pass.

Each task's tests follow the spec's "Tests" line for its files plus the binding rules above.
