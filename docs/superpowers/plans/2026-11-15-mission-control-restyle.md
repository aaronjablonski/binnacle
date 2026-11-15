# Mission Control Restyle Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Restyle every view to the approved "calm accent" look and add `/mc <tab>`.

**Spec:** `docs/superpowers/specs/2026-11-15-mission-control-restyle-design.md` · **Mocks:** https://claude.ai/artifact/R4JHk79nyTdVVFszFwfKsb (column A: `Main` wide, `CalmInline` narrow)

## Global Constraints

- Same as the main plan's Global Constraints (`docs/superpowers/plans/2026-11-15-mission-control-mod.md` lines 13–24), plus `docs/superpowers/notes/2026-11-15-docs-pass.md`.
- Colours only through `mod/hooks/views/style.ts` theme keys; no colour literals in views.
- Every line of every Text fits `bodyColumns` (measure per line); 24-column tests stay.
- Button children: strings and `Text` only. Keys are identity. Render writes no state.
- Existing behaviour tests keep passing; a test may change only where it asserted the old look (name each in the report).

## Models

R1–R3 Sonnet (well-specified UI). Then main-plan Task 9 (Sonnet) in the new style. Opus reviews R1–R3 + Task 9 as one batch, then the final whole-branch adversarial pass.

### Task R1: style module, tab bar, section headers, Overview and band

**Files:** Create `mod/hooks/views/style.ts`; modify `views/fit.ts`, `views/shell.tsx`, `views/overview.tsx`, `views/band.tsx`; tests beside them and `test/fit.test.ts`.

**Produces:**
```ts
// style.ts
export const C = { accent: 'suggestion', running: 'warning', done: 'success', error: 'error', doc: 'merged', rule: 'subtle', tabFg: 'inverseText' } as const
export function glyphColor(status: StepStatus | AgentRow['status'] | TaskItem['status']): string | undefined
// fit.ts
export function rule(columns: number): string            // '─' × max(0, columns)
export function blockBar(done: number, total: number, columns: number): { filled: string; rest: string }  // '█' and '░'
```
A `sectionHeader(label, meta, cols)` helper (function declaration) draws `LABEL ─── meta`: label `color: C.accent` bold, rule `color: C.rule` of `cols - label - meta - 2`, meta dim; when it cannot fit, the meta is dropped first, then the rule.

- [ ] Tests (four surfaces): the tab bar has a `│` Text between every two tabs; the open tab's element carries `backgroundColor: 'suggestion'`; numbers carry `color: 'suggestion'`; a section header's three parts sum to `cols` exactly at 62 and at 24; progress uses `█`/`░`; status glyphs carry their theme colours; at `bodyColumns ≥ 96` the Overview draws two columns and a one-line notes/artifacts summary; band parts separated by dim `│`; nothing exceeds 24 columns at 24. `fit.test.ts`: `rule`, `blockBar`. FAIL → implement → PASS.
- [ ] Probe whether a plain hotkeyed Button with Text children still prints `1:`; use `1 Overview` if it can be avoided while keeping the hotkey, else the `1: Overview` fallback. Record which.
- [ ] validate, tsc, npm test, plugin test; commit.

### Task R2: restyle Tasks, Agents list, tree, Timeline, Detail

**Files:** modify `views/tasks.tsx`, `agents.tsx`, `agentmeta.ts`, `tree.tsx`, `timeline.tsx`, `detail.tsx`; their tests.

- [ ] Each tab gets `sectionHeader` headings where it has headings, coloured status glyphs via `glyphColor`, meta dim and right-aligned in `space-between` rows, pending `○`, two-line rows' second line dim with `└ `. Detail: header lines use the section header; Pin/Back/Copy unchanged in behaviour.
- [ ] Tests (four surfaces): glyph colours per status in each tab; meta right-aligned (row Box `justifyContent: 'space-between'`); 24-column rule holds. FAIL → implement → PASS.
- [ ] validate, tsc, npm test, plugin test; commit.

### Task R3: `/mc <tab>`

**Files:** modify `views/shell.tsx` (`runMc`), `register.tsx` (argument hint).

- [ ] `/mc 1`…`/mc 5` and `/mc overview|tasks|agents|timeline|artifacts` (case-insensitive, also 3-letter prefixes) write `ui.tab`, clear `ui.detail`, open the pane (same open as `/mc`), answer `Mission Control: <Tab>.`; unknown → `Unknown tab. Try /mc 1-5 or a tab name.`; `close`, `pin` unchanged. `argumentHint: '[1-5 | tab | close | pin <note>]'`.
- [ ] Tests for each form, unknown, and that `pin`/`close` still work. FAIL → implement → PASS.
- [ ] validate, tsc, npm test, plugin test; commit.
