# Mission Control: developer-experience features plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Build ideas 1, 2, 3, 5, 7, 8 and 11 from `docs/superpowers/notes/2026-11-15-dx-ideas.md` (Aaron's pick, 2026-11-15).

**Spec:** `docs/superpowers/notes/2026-11-15-dx-ideas.md` (each idea's "Sees and does", "API", "Risks") plus the rulings below. **Mocks:** https://claude.ai/artifact/R4JHk79nyTdVVFszFwfKsb (`Idea1`, `Idea2`, `Idea3`, `Idea5`, `Idea7`, `Idea8`, `Idea11`; sources in the scratchpad `mcstyles/project/`). Look: `docs/superpowers/specs/2026-11-15-mission-control-restyle-design.md`.

## Global Constraints

- Everything in the main plan's Global Constraints (`docs/superpowers/plans/2026-11-15-mission-control-mod.md` lines 13–24), the restyle plan's, and `docs/superpowers/notes/2026-11-15-docs-pass.md`.
- One unmatched hook per event per module: new events (`tool.check`, `session.measure`) get one hook each, in `capture.ts`; existing events (`turn.complete`, `agent.spawn`, `tool.call`) are extended inside their existing hooks.
- New hooks observe: `tool.check` and `session.measure` return what `next(e)` resolved to, unchanged.
- Nothing is added to a conversation. `$.prompt.fill`, `$.ui.scroll`, `$.ui.view`, `$.ui.copy`, `$.fs.write` run only inside a press or a command the person ran; never in a hook on its own.
- No model calls. Dollar cost is never shown unless the option `showCost` is true (default false).
- Bounds hold: the worst-case Timeline test stays under 2,500,000 characters with the new fields at their caps.
- Colours through `style.ts`; every line fits `bodyColumns`; Button children strings and `Text`; identity keys; render writes no state.

## Compatibility assessment (why these seven fit together)

| Shared thing | Who needs it | Resolution |
|---|---|---|
| Agent model + tokens | 3 (columns, totals), 11 (node meta) | F1 adds `model`, `tokensIn`, `tokensOut` to `AgentRow`, from `agent.spawn`'s result and `turn.complete.usage`. |
| "Stalled" / "asking" / repeat / loop | 1 (queue), 11 (`!` on nodes), 7 (`/mc next-error`) | F1 adds `Step.asking` and one pure selector `problems(t, now)`; all three read it. |
| Workflow agent result line | 8 (run board), 11 | F1 stores the agent's `StructuredOutput` input summary as `AgentRow.result` (≤ 200 chars). |
| Budget numbers | 3 | F1 adds `Timeline.budget` from `session.measure` (context %, windows with `percentUsed` + `resetsAt`, cost kept but hidden). |
| Overview space | 1 (NEEDS YOU, top), 3 (BUDGET) | NEEDS YOU draws only when non-empty; BUDGET is one line below NOW in narrow/inline seats, a section in wide ones. |
| Band | 1 (alert), 3 (toasts only) | Band shows `! n need you` in `error` colour first when `problems` is non-empty, else the calm band. |
| `/mc` subcommands | 2 (`find`), 5 (`export`), 7 (`next-error`, `agent`) | One parser in `runMc`; tasks touching it run in different waves. |
| Detail view buttons | 2 (Show in chat), 5 (Copy as Markdown, Quote in prompt) | Different waves. |
| Agents tab | 3 (columns), 8 (run board), 11 (tree) | Different waves. |
| `ToolUse` render site | 2 (on-screen marker) | The guide already hooks `ui.render{component:'ToolUse'}` for its own tool; the observer joins that hook (no second registration) and returns `next(e)` untouched; visible ids live in a module variable — a ruling: ephemeral UI, not session state. Done last, on Opus. |
| Non-goals | 3 (cost analytics), 8 (waterfall) | Aaron picked both; kept to the mocked scope: one BUDGET section + two columns, no charts/history; a step strip, not a time-scaled waterfall. |
| Export location | 5 | Ruling: the digest goes to the session's journal folder (`…/mission-control/<journal>/export-<yyyy-mm-dd-hhmm>.md`) and to the clipboard; nothing is written into the repo. Only pinned steps' bodies are included. |
| Chord toggle | 7 | A `userConfig` string `toggleAction` (no default) names an engine keybinding action; the band's toggle Button carries it as `action`. Empty → no chord. |
| Notifications | 1 | `userConfig` `notify`: `'off' | 'waits' | 'all'`, default `'waits'`; never for a wait < 20 s; one per step. |

Nothing contradicts. The order below follows the data dependencies and keeps tasks that edit the same file in different waves.

## Models and waves

| Task | Idea | Model | Wave |
|---|---|---|---|
| F1 Data: contract `timeline-3`, capture, selectors | all | Opus | 0 |
| F2 Needs-you queue | 1 | Sonnet | A |
| F4 Find and jump (no on-screen marker) | 2 | Sonnet | A |
| F6 Workflow run board | 8 | Sonnet | A |
| F3 Budget line + agent columns | 3 | Sonnet | B |
| F5 Handoff | 5 | Sonnet | B |
| F7 Agent tree upgrade | 11 | Sonnet | C |
| F8 Keyboard flow | 7 | Sonnet | C |
| F9 On-screen marker (ToolUse observer) | 2 | Opus | C |

Opus review after waves A+B (F1–F6), Opus review after wave C, then the final adversarial whole-branch pass.

---

### Task F1: data for all seven features

**Files:** `mod/types/index.d.ts`, `mod/hooks/model/{limits,reduce,select}.ts`, `mod/hooks/capture.ts`, `mod/hooks/state.ts`, `mod/.claude-plugin/plugin.json`; tests in `test/` and `mod/hooks/capture.test.tsx`; fixtures.

**Produces (contract, shape `timeline-3`; `ui-3`):**
```ts
// additions
Step.asking?: number                    // when tool.check resolved decision 'ask'; cleared at step.end
AgentRow.model?: string; tokensIn?: number; tokensOut?: number; result?: string; lastStepAt?: number
Budget = { contextPct?: number; windows: { name: string; pct: number; resetsAt?: number }[]; costUsd?: number; at: number }
Timeline.budget?: Budget
UiState.dismissed: string[]             // problem signatures the person dismissed (≤ 200)
UiState.query: string                   // Timeline find text (≤ 200)
Ev additions: { kind: 'step.ask'; at; id } | { kind: 'usage'; at; agent; model?; tokensIn; tokensOut } | { kind: 'measure'; at; budget } | { kind: 'agent.model'; id; model }
// select.ts
export type Problem = { key: string; kind: 'asking' | 'repeat' | 'loop' | 'stalled' | 'failed-turn'; label: string; agent: AgentKey; stepId?: string; since: number; count?: number }
export function problems(t: Timeline, now: number, dismissed: string[]): Problem[]   // newest first; a dismissed key returns only if its count grew
export function signatureOf(step: Step): string                                    // tool + normalised label
export function findSteps(t: Timeline, query: string): Step[]                     // case-insensitive over tool, label, agent type, pin note
export function runBoard(t: Timeline, runId: string): { run: Run; agents: AgentRow[]; steps: Record<AgentKey, Step[]>; done: number; failed: number; elapsed: number }
```
Rules: repeat = same signature `error` ≥ 2 in the session; loop = same signature ≥ 3 in one turn; stalled = running non-main agent with `now - (lastStepAt ?? startedAt) > 180000`; asking = `Step.asking` set and the step still running; failed-turn = a turn that ended `failed` within the last 10 minutes. `StructuredOutput` step.start by a workflow agent sets that agent's `result` to its input collapsed to one line, cut to 200.

Capture: one `tool.check` hook (`const r = await next(e)`; `r.decision === 'ask'` → `step.ask` for `e.tool_use_id`; return `r`); one `session.measure` hook (→ `measure` when `e.changed` says something moved); `turn.complete` adds `usage` from `e.usage` (model + token counts); `agent.spawn`'s result `model` → `agent.model`. Exact field names from the type file (dx-ideas cites TF lines); record any mismatch in the report.

- [ ] vitest: one test per rule (problems' five kinds, dismissed-then-grown, signatures, findSteps, runBoard counts, usage accumulates per agent, StructuredOutput result line, measure replaces budget), bounds test extended. FAIL → implement → PASS.
- [ ] capture tests: `tool.check` ask marks the step and returns the engine's answer unchanged; `session.measure` records a budget and returns unchanged; `turn.complete` usage lands on the agent; a stored `timeline-2` reads as the initial value.
- [ ] One real headless run on `--model haiku` with a subagent: record a fixture `test/fixtures/probe-usage.jsonl` (turn.complete usage, session.measure, agent.spawn model) using a temporary local recorder that is not committed; a fixture test folds it and asserts the agent has a model and tokens. If `tool.check` never resolves `ask` headlessly, say so.
- [ ] validate, tsc, npm test, plugin test; commit.

### Task F2: Needs-you queue (idea 1)
Overview `NEEDS YOU` section first (only when `problems` non-empty): one row per problem (glyph `!` in `error`, label, dim agent + age, right-aligned), pressing opens the step (detail) or the agent (timeline filtered); a `dismiss` Button per row (key `dismiss-<key>`) writing `ui.dismissed`. Band: `! n need you` first in `error`. Clock: when a new `asking` problem reaches 20 s and `notify` is not `off`, one `$.ui.notify` per step id (ids notified kept in `ui`, bounded 200); `notify: 'all'` also for failed turns. Toast when a subagent finishes (first line of its doing). Tests over four surfaces (band three) incl. 24 columns, dismiss, notify once.

### Task F4: Find and jump (idea 2, without the on-screen marker)
Timeline: an `Input` at the top bound to `ui.query` (filters live via `findSteps`), Enter = deep search over stored bodies (`readBody` newest first, ≤ 200 bodies, stop at 8 s) marking hits `in result`; filter chips restyled with the accent. `/mc find <text>` sets the query, opens Timeline. Step rows and detail: `Show in chat` → `$.ui.scroll({ to: { requestId: step.id }, block: 'center' })` (on `{ deny }` toast its reason). Agents rows: `View` → `$.ui.view({ agentId })`. Tests: filter, deep search marks, `/mc find`, scroll and view called only on press.

### Task F6: Workflow run board (idea 8)
Agents List: a run header is a Button; pressing opens the run board (`ui.run = runId`, add to `UiState`, `ui-3`): header `n/m done · f failed · elapsed`, one row per agent in spawn order: index, glyph, description, a strip of `■` per step coloured by status (newest 20, `+n` before), elapsed, dim `result` line; pressing a block opens that step. `Back`. Tests incl. 24 columns.

### Task F3: Budget line + agent columns (idea 3)
Overview `BUDGET` (wide: section with context `blockBar` and each window `pct · resets <time>`; narrow/inline: one line `ctx 62% · 5h 71%`), hidden when no budget yet. Agents rows: dim `model · tokens` in the meta (`…` while running with no usage); a totals line per model under the list. Toasts at context ≥ 80 % and at each 10 points of any window past 70 % (once each, tracked in `ui`). `showCost` option shows `$x.xx`. Tests.

### Task F5: Handoff (idea 5)
`/mc export` (and an Overview footer Button `Export`): Markdown digest (tasks with status, notes, pinned steps with input and result cut to 2,000 chars, artifacts with refs, changed files, open problems) written to `<journal>/export-<stamp>.md` and copied; toast the path. Detail: `Copy as Markdown` (tool, input, result in fenced blocks) and `Quote in prompt` (`$.prompt.fill({ text: '> …', mode: 'insert' })`). Tests: digest content, only pinned bodies, copy/fill only on press.

### Task F7: Agent tree upgrade (idea 11)
Tree node meta adds tokens; `!` on a node with a problem and on its folded ancestors; folded branch shows `▸ n agents · r running`; `View` per agent row; a `running only` toggle (`ui.runningOnly`). 24-column rule: drop meta before the description. Tests.

### Task F8: Keyboard flow (idea 7)
`/mc next-error` (opens the newest unseen error step's detail), `/mc agent <name|id>` (Timeline filtered to it); pane `autoFocus` on the newest error else the running step; keys inside the pane: `n`/`p` next/previous error (Buttons with hotkeys, labels readable without keys), `g` = Show in chat on the open step; band toggle Button with `action` from `toggleAction` (omitted when empty); key hints only while `e.props.isFocused`. README section updated. Tests.

### Task F9: On-screen marker (idea 2, last)
Extend the guide's `ui.render{component:'ToolUse'}` hook: for other tools, read `e.props.onScreen` and the row's `requestId`, keep a bounded module-level `Set` of visible ids (ruling: ephemeral), return `next(e)` untouched, never throw, O(1). Timeline rows whose id is visible get a dim `◂ on screen`. Tests: the hook returns the engine's node unchanged for every non-guide tool; marker shows; a throw inside is swallowed.
