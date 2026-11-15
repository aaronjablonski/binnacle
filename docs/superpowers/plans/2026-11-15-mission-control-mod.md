# Mission Control Mod Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude Code mod that keeps an overview, tasks, agents, a step timeline and artifacts in a persistent pane and band beside the chat, and has Claude keep the overview current.

**Architecture:** Observing hooks (`tool.call`, `agent.spawn`, `turn.*`) are translated into small events and folded by a pure reducer into one bounded `Timeline` value held in `$.state`. Step bodies and a snapshot go to disk through `$.fs`. A guide (one tool, one system-prompt section) lets Claude post its focus, notes and results. Views are pure functions from the `Timeline` to element trees, drawn in a `Pane` and an `AbovePrompt` band.

**Tech Stack:** TypeScript hooks module loaded directly by Claude Code ≥ 2.1.325 (no build); `claude plugin validate|test`; vitest for the pure model.

**Spec:** `docs/superpowers/specs/2026-11-15-mission-control-mod-design.md` · **Mocks:** https://claude.ai/artifact/L51pHiKbjfBac7eQEVUUnF (sources in `docs/mocks/`)

## Global Constraints

- Mod folder is `mod/`; plugin name `mission-control`; command `/mc`; pane id `mission-control`; tool `mcp__mission-control__update`.
- Every capture hook returns exactly what `next(e)` resolved to. No `{ deny }`, no rewritten `e`, no `$.prompt.submit`, no `$.model.*`, no `$.session.append`. The only additions to a conversation are in `mod/hooks/guide.ts`.
- A capture hook must never throw into the chain: wrap the mod's own work in `try/catch` and report with `$.ui.log(msg, { to: 'debug' })`.
- Hooks module rules: event names are string literals; write `$.ns.method` in full (never destructure or alias `$`); relative imports only plus `'claude-code'`; no dynamic `import()`, no `require`, no Node APIs, no `setTimeout` (use `$.clock`).
- `mod/hooks/model/**` imports nothing from `'claude-code'` (types come from `../../types`), so vitest can load it.
- State lives in `$.state` through `atom(ref, initial, { shape })`; never in module variables. Render hooks never write state.
- Bounds: ≤ 2,000 steps, ≤ 200 turns, ≤ 50 notes, ≤ 200 artifacts, ≤ 1,000 changed paths in the `Timeline`; pinned steps are never dropped. Result text stored per step ≤ 20,000 characters.
- Tests: pure model in `test/*.test.ts` (vitest, `npm test`); hooks and drawings in `mod/hooks/**/*.test.tsx` (`claude plugin test ./mod`), each drawing test looped over `['terminal', 'desktop', 'vscode', 'mobile'] as const`.
- The API reference is the generated type file `mod/.claude-plugin/types/claude-code/index.d.ts` (grep it for the name at hand); it wins over this plan where they disagree — record the disagreement under Findings. Load the `plugin-authoring` skill before writing mod code.
- Work on a feature branch; one subagent at a time; commit by path. Commit and PR text follows `CLAUDE.local.md` (no Claude attribution).

## Models and review gates

| Task | Implementer | Why |
|---|---|---|
| 1 Scaffold + probe spike | Opus | judgment: decides what the API really delivers |
| 2 Model + reducer | Opus | core logic |
| 3 Capture + journal | Opus | core logic, persistence |
| 4 Guide (tool + prompt section) | Opus | sensitive: changes what Claude is told |
| 5 Pane shell, Overview, band | Sonnet | well-specified UI |
| 6 Tasks view, Agents list | Sonnet | well-specified UI |
| 7 Agents tree | Sonnet | well-specified UI over a pure selector |
| 8 Timeline, detail, pins | Sonnet | well-specified UI |
| 9 Artifacts view, docs, CI | Sonnet | well-specified |

Opus reviews: once after Tasks 1–4, once after Tasks 5–9, then one adversarial whole-branch pass. Aaron checks the look by hand after Task 5 (first time the pane is real) before Tasks 6–9 start.

## Review Focus

1. **A tool call arriving with an `agentId` no `agent.spawn` announced** (resumed runs, forks, compaction). Expected: the step is kept and an agent row is created on the fly with type `unknown`. → test in Task 2.
2. **A tool call that never settles** (interrupted turn, reload mid-call). Expected: when its turn completes, a still-running step becomes `interrupted`. → test in Task 2.
3. **`TodoWrite` and `TaskCreate/TaskUpdate` both used, or `TaskUpdate` for an id never seen.** Expected: one list; an unknown id creates a placeholder `Task <id>`. → test in Task 2.
4. **A huge or non-text result, and a malformed update call** (3 MB read, image, `undefined` text; an update with no fields, a 5,000-character focus, wrong types). Expected: previews cut with a marker, update fields cut to their limits or ignored, nothing thrown, the tool still answers. → tests in Tasks 3 and 4.
5. **A narrow pane (`bodyColumns` 24), an empty session, and Claude never calling the update tool.** Expected: every view draws without a refused tree; the Overview's Now falls back to the in-progress task and latest step. → tests in Tasks 5–9.

---

### Task 1: Scaffold the repo and the mod, and probe what the engine delivers

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.github/workflows/ci.yml`, `README.md`
- Create: `mod/.claude-plugin/plugin.json`, `mod/hooks/hooks.json`, `mod/hooks/register.tsx`, `mod/hooks/probe.ts`, `mod/tsconfig.json`
- Create: `test/fixtures/probe-subagent.jsonl`, `test/fixtures/probe-tasks.jsonl`, `test/fixtures/probe-workflow.jsonl`, `test/fixtures/probe-guide.jsonl`
- Modify: this plan's **Findings** section

**Interfaces:**
- Produces: `npm test` running vitest over `test/**/*.test.ts`; a mod `claude plugin validate ./mod` accepts; `register.tsx` exporting `register: Register`; `probe.ts` exporting `registerProbe(on, options): void`, active only when the `userConfig` boolean `probe` is true; fixtures in the line format below; the Findings section.

Fixture line format (one JSON object per line, in arrival order):
`{ "at": number, "event": "tool.call" | "tool.result" | "agent.spawn" | "agent.spawned" | "turn.start" | "turn.complete" | "session.receive", "e": <the event input, strings cut to 500 chars>, "r"?: <the result, strings cut to 500 chars> }`

- [ ] **Step 1:** Create a feature branch. Write `package.json` (private, devDependencies `vitest` and `typescript` only, scripts `test: vitest run`, `typecheck: tsc -p mod --noEmit`), `vitest.config.ts` (`include: ['test/**/*.test.ts']`, node environment), a root `tsconfig.json` covering `test/` and `mod/hooks/model/`, and `ci.yml` (Node 20: `npm ci`, `npm test`; a gitleaks job as in `../claude-code-workflow-visualizer/.github/workflows/ci.yml`). `npm install`.
- [ ] **Step 2:** Write `plugin.json` (`name: "mission-control"`, `version: "0.1.0"`, a `userConfig` with booleans `probe` (default false), `autoOpen` (default false), `guide` (default true)), `hooks.json` (`{ "modules": ["./register.tsx"] }`), and a `register.tsx` that registers `/mc` in `session.start` and answers it with `{ text: 'Mission Control: not built yet.' }`.
- [ ] **Step 3:** Run `claude plugin validate ./mod`. Expected: no errors; `hooks:` lists `session.start` and `command.run{command=mc}`.
- [ ] **Step 4:** Run `claude -p "/mc" --plugin-dir ./mod`. Expected output contains `Mission Control: not built yet.` This loads the mod once, which lays `mod/.claude-plugin/types/`; then write `mod/tsconfig.json` extending `./.claude-plugin/types/tsconfig.json` and run `tsc -p mod` — expected: no errors. (If a headless run lays no types, use the tsconfig from the type file's header, with `include` naming that type file and `hooks`; record which under Findings.)
- [ ] **Step 5:** Write `probe.ts`: observing hooks on `tool.call`, `agent.spawn`, `turn.start`, `turn.complete`, `session.receive` that append fixture lines to `<cwd>/.mc-probe/<session-id>.jsonl` via `$.fs`, each returning `next(e)`'s value untouched. In probe mode also register a throwaway tool `mcp__mission-control__probe_update` (not deferred, input `{ focus: string }`, answered `ok`) and add a `prompt.compose` section saying "Call the probe_update tool once, with a five-word focus, before you answer."
- [ ] **Step 6:** Record four probe runs with the probe option on, using `--model haiku` to keep cost low:
  - subagent: `claude -p "Use the Explore agent to count the .json files in this folder, then tell me the number." --plugin-dir ./mod`
  - tasks: `claude -p "Create a task list with three tasks named A, B, C, mark A in progress then completed, then stop." --plugin-dir ./mod`
  - workflow: `claude -p "Run a workflow with two agents that each read package.json and report its name field." --plugin-dir ./mod` (if the Workflow tool is unavailable headless, say so under Findings and hand-write this fixture from the type file's `AgentSpawnInput.workflow` shape, marked `"synthetic": true` on line one)
  - guide: `claude -p "Use the Explore agent to read README.md and summarise it in one line." --plugin-dir ./mod`
  Copy the four files to `test/fixtures/`, delete `.mc-probe/`.
- [ ] **Step 7:** Fill in **Findings**, answering each with evidence from the fixtures: (a) do subagent tool calls reach `tool.call` with `agentId`? (b) do workflow agents' tool calls? (c) which task tools appear, and does `TaskCreate`'s result carry `task.id`? (d) does `turn.complete` carry the subagent's `answer`? (e) what does `e.tool_use_id` look like and is it unique per call? (f) how were `userConfig` options set for a `--plugin-dir` mod? (g) largest `$.state` value that round-trips (try 64 KB, 512 KB, 2 MB of JSON in a `claude plugin test`); (h) does `$.fs.write` to `~/.claude/mission-control/x.json` succeed (`~` expanded or not)? (i) did the model call the probe tool because the section told it to, and what exact shapes do `$.tool.register` and a `prompt.compose` section take? (j) did the subagent also see the section and call the tool (its line has an `agentId`)? (k) with one `tool.call` hook carrying a `{ tool }` matcher and one without, which run, and in which order?
- [ ] **Step 8:** If a finding contradicts a later task, write the consequence under Findings as "Plan change:" and stop for the orchestrator before Task 2. Remove the probe tool and section from `probe.ts` once the fixtures are recorded.
- [ ] **Step 9:** Write `README.md`: what the mod is, the dev loop from the spec's "Developing and testing locally", verbatim commands. Commit.

---

### Task 2: The model and its reducer

**Files:**
- Create: `mod/types/index.d.ts`, `mod/hooks/model/limits.ts`, `mod/hooks/model/reduce.ts`, `mod/hooks/model/label.ts`, `mod/hooks/model/select.ts`
- Modify: `mod/.claude-plugin/plugin.json` (add `"types": "./types/index.d.ts"`)
- Test: `test/reduce.test.ts`, `test/label.test.ts`, `test/select.test.ts`, `test/fixtures.test.ts`

**Interfaces:**
- Consumes: fixture line format from Task 1.
- Produces (exact). Every type lives in `mod/types/index.d.ts`, the mod's state contract: one self-contained file with **no import or reference**, types exported at its top level (pattern: the skill's `examples/pane-state.d.ts`). Model and view files import them with `import type { … } from '../../types'`.

```ts
// mod/types/index.d.ts
export type AgentKey = string            // 'main' or an agentId
export type StepStatus = 'running' | 'done' | 'error' | 'denied' | 'interrupted'
export type Step = {
  id: string; seq: number; agent: AgentKey; turnId?: string
  tool: string; label: string; status: StepStatus
  startedAt: number; endedAt?: number
  pin?: string                           // the note; '' when pinned without one
  pending?: Record<string, unknown>      // input kept between start and end; cleared at step.end
}
export type AgentRow = {
  id: AgentKey; parent: AgentKey; type: string; description: string
  runId?: string; agentIndex?: number    // workflow agents only
  status: 'running' | 'done' | 'error'
  startedAt: number; endedAt?: number
  doing: string; stepCount: number
  taskId?: string                        // the task in progress when it spawned
}
export type Run = { runId: string; name: string; parent: AgentKey; startedAt: number }
export type TaskItem = {
  id: string; subject: string; activeForm?: string
  status: 'pending' | 'in_progress' | 'completed'
  owner: AgentKey; updatedAt: number
}
export type TurnRow = { id: string; agent: AgentKey; prompt: string; startedAt: number; endedAt?: number }
export type Now = { focus: string; next?: string; at: number }
export type Note = { text: string; agent: AgentKey; at: number }
export type ArtifactKind = 'page' | 'document' | 'result' | 'link'
export type ArtifactRow = {
  id: string; kind: ArtifactKind; title: string
  ref?: string; summary?: string; stepId?: string
  agent: AgentKey; count: number; updatedAt: number
}
export type Timeline = {
  seq: number; turns: TurnRow[]; steps: Step[]
  agents: Record<AgentKey, AgentRow>; runs: Record<string, Run>
  tasks: TaskItem[]; now?: Now; notes: Note[]
  artifacts: ArtifactRow[]; changed: string[]   // distinct code paths written or edited
}
export type Update = {
  focus?: string; next?: string; note?: string
  artifact?: { title: string; kind: 'result' | 'link'; ref?: string; summary?: string }
}
export type Ev =
  | { kind: 'turn.start'; at: number; turnId: string; agent: AgentKey; prompt: string }
  | { kind: 'turn.end'; at: number; turnId: string; agent: AgentKey; answer: string; failed: boolean }
  | { kind: 'step.start'; at: number; id: string; agent: AgentKey; tool: string; input: Record<string, unknown> }
  | { kind: 'step.end'; at: number; id: string; status: 'done' | 'error' | 'denied'; result?: unknown }
  | { kind: 'agent.start'; at: number; id: AgentKey; parent: AgentKey; type: string; description: string; runId?: string; agentIndex?: number }
  | { kind: 'update'; at: number; agent: AgentKey; update: Update }
  | { kind: 'pin'; id: string; note: string }
  | { kind: 'unpin'; id: string }
export type StepFilter = { kind: 'all' } | { kind: 'pinned' } | { kind: 'errors' } | { kind: 'agent'; id: AgentKey }
export type StepBody = { input: Record<string, unknown>; text: string; cut: number; isError: boolean }
export type Tab = 'overview' | 'tasks' | 'agents' | 'timeline' | 'artifacts'
export type UiState = {
  tab: Tab; filter: StepFilter
  agentsMode: 'list' | 'tree'; folded: string[]        // folded tree node keys
  detail?: { stepId: string; body?: StepBody; missing?: true }
}
declare module 'claude-code' { interface PluginState { 'mission-control': {
  timeline: Shaped<Timeline>
  ui: Shaped<UiState>
} } }

// limits.ts
export const MAX_STEPS = 2000
export const MAX_TURNS = 200
export const MAX_NOTES = 50
export const MAX_ARTIFACTS = 200
export const MAX_CHANGED = 1000
export const MAX_LINE = 200            // focus, next, note, artifact title and summary are cut to this
export const DOC_EXT = ['.md', '.mdx', '.html', '.pdf', '.docx', '.pptx', '.xlsx', '.csv', '.png', '.jpg', '.jpeg', '.svg']

// reduce.ts
export const empty: Timeline
export function reduce(t: Timeline, ev: Ev): Timeline   // pure; never mutates t; never throws

// label.ts
export function labelOf(tool: string, input: Record<string, unknown>): string  // ≤ 80 chars, one line
export function pathsOf(tool: string, input: Record<string, unknown>): string[]
export function isDoc(path: string): boolean                                   // extension in DOC_EXT, case-insensitive

// select.ts
export type TaskNode = { task: TaskItem; agents: { agent: AgentRow; tasks: TaskItem[] }[] }
export function taskTree(t: Timeline): TaskNode[]
export function agentGroups(t: Timeline): { run?: Run; agents: AgentRow[]; done: number }[]  // runless group first, running agents first inside each
export type TreeNode = { key: string; kind: 'agent' | 'run'; agent?: AgentRow; run?: Run; done?: number; children: TreeNode[] }
export function agentTree(t: Timeline): TreeNode            // root is main, key 'main'; a run's key is 'run:<runId>'
export type TreeLine = { key: string; prefix: string; node: TreeNode; folded: boolean }
export function treeLines(root: TreeNode, folded: string[]): TreeLine[]
export function stepGroups(t: Timeline, f: StepFilter): { turn?: TurnRow; steps: Step[] }[]  // newest turn first, newest step first
export type Summary = {
  focus?: string; next?: string; focusAt?: number; fromClaude: boolean
  done: number; total: number; current?: TaskItem; upcoming?: TaskItem
  running: AgentRow[]; finished: number
  latest: Step[]; steps: number; errors: number; changed: number     // latest: newest 4, pinned ones included
  notes: Note[]; artifacts: ArtifactRow[]                            // newest 3 each
}
export function summary(t: Timeline): Summary
export function fromFixture(line: unknown): Ev[]   // one probe line → zero or more Ev
```

Reducer rules the tests pin:
- `step.start` appends a `Step` with `seq = ++t.seq`, `label = labelOf(...)`, bumps the agent's `stepCount` and sets its `doing` to the label. An unknown `agent` creates an `AgentRow` with `type: 'unknown'`, `description: ''`, `parent: 'main'`.
- `step.start` for tool `TodoWrite` replaces all tasks owned by that agent with the input's `todos` (ids `todo:<agent>:<index>`). `step.end` for `TaskCreate` (done) adds a task from the pending input's `subject`/`activeForm` and the result's `task.id`. `step.end` for `TaskUpdate` (done) applies `status`/`subject`/`activeForm`; `status: 'deleted'` removes it; an unseen `taskId` first creates `{ subject: 'Task <id>', status: 'pending' }`.
- `step.end` (done) for `Write`, `Edit`, `MultiEdit`, `NotebookEdit`: each path from `pathsOf` that `isDoc` adds or updates a `document` artifact (id `doc:<path>`, title = last two path segments, `count` + 1, `stepId` = this step); every other path is added to `changed` if absent.
- `step.end` (done) for `Artifact` whose result holds a `url` string adds or updates a `page` artifact (id `page:<url>`, `ref` = url, title = the input's `title` string, else the basename of its `file_path`, else `Page`).
- `step.end` (done) for `Workflow` with a result holding `runId` and `workflowName` records a `Run` with `parent` = the step's agent. An `agent.start` with a `runId` not yet in `runs` records `{ name: 'workflow', parent: ev.parent }`; the `Workflow` step's end replaces `name`.
- `agent.start` sets `taskId` to the id of the newest `in_progress` task owned by `parent`, if any.
- `update`: every string is trimmed, collapsed to one line and cut to `MAX_LINE`; non-strings and empty strings are ignored. `focus`/`next` from `main` set `now` (`next` alone keeps the old `focus`); a `focus` from another agent sets that agent's `doing` instead. `note` appends a `Note`. `artifact` (needs a non-empty `title` and a `kind` of `result` or `link`) adds or updates an artifact with id `<kind>:<ref or title>`. An update with nothing usable returns `t` unchanged.
- `turn.end` sets the agent's `status` (`error` when `failed`, else `done`; `main` never changes status), sets its `doing` to the first line of `answer` cut to 80 chars when non-empty, and turns every still-`running` step of that agent into `interrupted`.
- Bounds: after an append, drop the oldest unpinned step past `MAX_STEPS`, the oldest turn past `MAX_TURNS`, the oldest note past `MAX_NOTES`, the oldest-updated artifact past `MAX_ARTIFACTS`; `changed` stops growing at `MAX_CHANGED`.
- `pin`/`unpin`/`step.end` for an id not present return `t` unchanged.

`labelOf` values the tests pin: `Bash {command:'npm test'}` → `Bash npm test`; `Read {file_path:'C:/r/src/a.ts'}` → `Read src/a.ts` (last two path segments); `Edit`/`Write` likewise; `Grep {pattern:'on\\('}` → `Grep "on\("`; `Agent {description:'find sites', subagent_type:'Explore'}` → `Agent Explore · find sites`; `TaskUpdate {taskId:'3', status:'completed'}` → `Task 3 → completed`; a tool not listed → tool name plus its first string argument; everything collapsed to one line and cut to 80 characters with `…`.

`agentTree` rules: an agent sits under its `parent`'s node; an agent with a `runId` sits under its run's node, and the run's node sits under the run's `parent`; an agent whose parent is unknown sits under `main`; children are ordered by `startedAt`; a run's `done` counts its agents with status `done`. `treeLines` walks depth-first, skips the children of a key in `folded`, and builds `prefix` from `├─ `, `└─ `, `│  ` and three spaces (root has an empty prefix).

- [ ] **Step 1:** Write `test/reduce.test.ts` with one test per rule above (names: `appends a step and updates the agent`, `creates an unknown agent on the fly`, `TodoWrite replaces that agent's tasks`, `TaskCreate adds a task from its result id`, `TaskUpdate for an unseen id creates a placeholder`, `TaskUpdate deleted removes the task`, `TodoWrite and Task tools share one list`, `writing a .md adds a document artifact and a second write bumps its count`, `editing a .ts adds to changed and not to artifacts`, `an Artifact result url adds a page`, `Workflow result names the run`, `agent.start links the in-progress task`, `a main update sets now`, `next alone keeps the focus`, `a subagent focus sets its doing, not now`, `an update note is cut to MAX_LINE and one line`, `an empty or mistyped update is a no-op`, `a declared link artifact is added once and updated on repeat`, `turn.end interrupts running steps`, `turn.end sets doing to the answer's first line`, `drops oldest unpinned past MAX_STEPS and keeps pins`, `keeps only the newest MAX_NOTES notes`, `unknown ids are no-ops`, `never mutates its input` (deep-freeze `t` first)). Run `npx vitest run test/reduce.test.ts` — expected: FAIL, module not found.
- [ ] **Step 2:** Implement `types/index.d.ts`, `limits.ts`, `label.ts`, `reduce.ts`; add `"types"` to `plugin.json`; run `claude plugin validate ./mod` (it checks the contract). Run the test — expected: PASS.
- [ ] **Step 3:** Write `test/label.test.ts` with the pinned values, plus: a 500-character command is cut to 80 with `…`; a multi-line command is one line; `input` with no string argument yields the bare tool name; `isDoc('A/B.MD')` is true, `isDoc('a.ts')` false. Run, fix, PASS.
- [ ] **Step 4:** Write `test/select.test.ts`: `taskTree` nests an agent under the task it was spawned in and that agent's own tasks under it; `agentGroups` puts runless first and counts `done`; `agentTree` nests a sub-subagent two levels down and a run's agents under the run under the caller; `treeLines` yields the prefixes `''`, `'├─ '`, `'│  └─ '`, `'└─ '` for main → [A → [A1], B] and omits A1 when `A` is folded; `stepGroups` orders newest first and each filter returns only matching steps; `summary(empty)` is `{ fromClaude: false, done: 0, total: 0, running: [], finished: 0, latest: [], steps: 0, errors: 0, changed: 0, notes: [], artifacts: [] }`; with no `now`, `summary` takes `focus` from the in-progress task's `activeForm ?? subject` and `fromClaude` is false; with `now`, `fromClaude` is true. Implement `select.ts`. PASS.
- [ ] **Step 5:** Write `test/fixtures.test.ts`: for each fixture, fold `fromFixture(line)` through `reduce` from `empty` and assert — subagent: at least one agent besides `main`, every step's `agent` is a key of `agents`, no step left `running`; tasks: three tasks, A `completed`; workflow: one run with two agents. Implement `fromFixture`. Run `npm test` — expected: all PASS.
- [ ] **Step 6:** Commit.

---

### Task 3: Capture hooks and the journal

**Files:**
- Create: `mod/hooks/state.ts`, `mod/hooks/capture.ts`, `mod/hooks/journal.ts`
- Modify: `mod/hooks/register.tsx`
- Test: `mod/hooks/capture.test.tsx`, `mod/hooks/journal.test.tsx`

**Interfaces:**
- Consumes: contract types, `reduce`, `empty` (Task 2); Findings (f)–(h), (k).
- Produces:

```ts
// state.ts
export const timeline  // atom({ plugin: 'mission-control', key: 'timeline' } as const, empty, { shape: 'timeline-1' })
export const ui        // atom(..., { tab: 'overview', filter: { kind: 'all' }, agentsMode: 'list', folded: [] }, { shape: 'ui-1' })
export async function apply($: EngineInterface, ev: Ev): Promise<void>   // update($, timeline, t => reduce(t, ev)); swallows and debug-logs any error

// capture.ts
export const UPDATE_TOOL = 'mcp__mission-control__update'
export function registerCapture(on: On): void

// journal.ts
export const MAX_TEXT = 20000
export function bodyOf(input: Record<string, unknown>, result: { text?: unknown; isError?: unknown } | undefined): StepBody
export async function writeBody($, sessionId: string, stepId: string, body: StepBody): Promise<void>
export async function readBody($, sessionId: string, stepId: string): Promise<StepBody | undefined>
export async function saveSnapshot($, sessionId: string, t: Timeline): Promise<void>
export async function loadSnapshot($, sessionId: string): Promise<Timeline | undefined>
export async function prune($, keep: number): Promise<void>   // keep newest `keep` session folders
```

Journal root: `~/.claude/mission-control/<session-id>/` with `timeline.json` and `steps/<step-id>.json` (path spelling per Finding (h)). Step id is `e.tool_use_id`; when absent, `mc-<at>-<seq>`.

Capture rules:
- `tool.call`: when `e.tool === UPDATE_TOOL`, do nothing and `return next(e)` (the guide owns it; adjust per Finding (k)). Otherwise apply `step.start` (`agent: e.agentId ?? 'main'`, `input` = `e` without `tool`, `tool_use_id`, `agentId`, `consent`), `const ran = await next(e)`, apply `step.end` (`denied` when `ran.deny`, `error` when `ran.isError`, else `done`; `result: ran.result`), `void writeBody(...)` (not awaited), `return ran`.
- `agent.spawn`: `const out = await next(e)`; when `out.agentId`, apply `agent.start` (`parent: e.parentAgentId ?? 'main'`, `type: e.subagentType`, `runId`/`agentIndex` from `e.workflow`); `return out`.
- `turn.start` / `turn.complete`: apply `turn.start` (prompt cut to 200 chars) / `turn.end` (`failed` when `e.reason` is `error` or `refusal`), then on a main-loop `turn.complete` `void saveSnapshot(...)`.
- Every hook: the mod's own work inside `try/catch`; `next(e)` is called exactly once whatever fails. Each registration gets `.catch(($, e, next) => next(e))`.

- [ ] **Step 1:** Write `mod/hooks/capture.test.tsx`. Tests (each stubs the engine with `on('tool.call', () => ({ result: {}, text: 'ok' }))` etc. and reads the timeline back with `$.state.get`): `a tool call becomes a done step with a label`; `an errored call becomes an error step`; `a denied call becomes a denied step`; `a subagent's call lands under its agentId` (`$.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' })`); `agent.spawn records the agent with its workflow run`; `the update tool is not recorded as a step`; `the hook returns the engine's answer unchanged`; `a failing state write does not break the call` (stub `state.set` to throw; the call still resolves `ok`). Run `claude plugin test ./mod` — expected: FAIL.
- [ ] **Step 2:** Implement `state.ts`, `capture.ts`; call `registerCapture(on)` from `register.tsx`. Run `claude plugin test ./mod` and `claude plugin validate ./mod` — expected: PASS; validate lists `tool.call`, `agent.spawn`, `turn.start`, `turn.complete` and no `gating hook without .catch` line.
- [ ] **Step 3:** Write `mod/hooks/journal.test.tsx` (stub `fs.write`/`fs.read`/`fs.list` with an in-memory map): `bodyOf cuts text to MAX_TEXT and reports cut` (30,000 chars in → `text.length === 20000`, `cut === 10000`); `bodyOf tolerates a missing or non-string text` (→ `text: ''`); `a 3 MB result writes one file under 64 KB`; `write then read round-trips`; `readBody of a missing file is undefined`; `snapshot round-trips`; `loadSnapshot of corrupt JSON is undefined`; `prune keeps the newest 20`. Run — FAIL. Implement `journal.ts`. PASS.
- [ ] **Step 4:** In `register.tsx` `session.start`: `prune($, 20)`, then if `loadSnapshot` returns a timeline and the state's is `empty`, set it. Add `on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, ...)` doing the same load. Test: `a resumed session restores its snapshot`. PASS.
- [ ] **Step 5:** Run the real thing once: `claude -p "Use the Explore agent to count .json files in this folder." --model haiku --plugin-dir ./mod`, then check `~/.claude/mission-control/<id>/timeline.json` holds ≥ 2 agents and no `running` step. Put the two counts in the commit body.
- [ ] **Step 6:** `tsc -p mod` clean, `npm test` green. Commit.

---

### Task 4: The guide — Claude keeps the Overview current

**Files:**
- Create: `mod/hooks/guide.tsx`
- Modify: `mod/hooks/register.tsx`
- Test: `mod/hooks/guide.test.tsx`

**Interfaces:**
- Consumes: `apply`, `UPDATE_TOOL` (Task 3); `Update` (contract); Findings (i)–(k).
- Produces: `export function registerGuide(on: On, options: { guide?: boolean }): void`, `export const GUIDE_TEXT: string`, `export const UPDATE_SCHEMA` (the tool's JSON schema).

Behaviour (all of it skipped when `options.guide === false`):
- `session.start` registers the tool `update` (listed as `mcp__mission-control__update`, `isDeferred: false`). Description: `Keep the Mission Control overview current for the person watching this session. Cheap; returns nothing useful.` Schema: an object with optional string `focus`, `next`, `note` (each `maxLength: 200`) and optional `artifact` `{ title: string, kind: 'result' | 'link', ref?: string, summary?: string }`, `additionalProperties: false`.
- A `tool.call` hook on `{ tool: 'mcp__mission-control__update' }` applies `{ kind: 'update', agent: e.agentId ?? 'main', update: <the input's four fields> }` and answers `{ result: 'Noted.' }` without calling `next`. A malformed input is still answered `Noted.` (the reducer ignores what it cannot use).
- A `prompt.compose` hook answers `next(e)`'s sections with one added last (`scope: 'session'`), its text exactly `GUIDE_TEXT`, the same on every call so the prompt cache holds:

```text
# Mission Control
The person follows this session in a side panel called Mission Control. Keep it current:
- Keep the task list up to date with the task tools as work starts and finishes.
- Call mcp__mission-control__update with `focus` (and `next` when you know it) whenever what you are working on changes. One short line each.
- Add `note` when you learn something the person would want to find again later: a decision, a root cause, a surprising fact. One line.
- Add `artifact` when you produce a result or a link worth keeping (review findings, a report, a pull request).
Batch these into one call, at most once per step, and never call it only to say nothing changed. Do not mention the panel or these updates in your replies.
```

- A `ui.render` hook on `{ component: 'ToolUse' }` for this tool draws one dim `Text`: `◆ Mission Control updated: <focus ?? note ?? artifact title ?? 'noted'>` (cut to `bodyColumns`), and a `ToolResult` hook for it draws nothing extra (return what Findings shows is the empty answer). Any other tool: `next(e)`.

- [ ] **Step 1:** Tests: `registers the update tool, not deferred`; `a focus update sets now and answers Noted.`; `a subagent's focus sets its doing`; `a note and an artifact in one call both land`; `a call with no fields answers Noted. and changes nothing`; `a 5,000-character focus is stored cut to 200`; `prompt.compose gains exactly one section, last, equal to GUIDE_TEXT, and the engine's sections are untouched`; `with guide: false no tool is registered and no section is added`; `the tool's row draws one dim line on every surface`; `another tool's row is left to the engine`. Run `claude plugin test ./mod` — FAIL.
- [ ] **Step 2:** Implement `guide.tsx`; call `registerGuide(on, options)` from `register.tsx`. PASS; `claude plugin validate ./mod` clean (the update hook reads as answering its own tool; give it a `.catch` that answers `{ result: 'Noted.' }`).
- [ ] **Step 3:** Run the real thing: `claude -p "Use the Explore agent to read README.md, then tell me in one line what this repo is." --model haiku --plugin-dir ./mod`. Check `timeline.json` has a `now` with a focus. Run it three times and put under Findings how many of the three set a focus; if fewer than two, tighten `GUIDE_TEXT` (one change, re-run) and record the wording that worked.
- [ ] **Step 4:** `tsc -p mod`, `npm test`. Commit.

**→ Opus review of Tasks 1–4** (focus: hooks cannot alter or break the chain; the guide is the only thing added to a conversation and is off with `guide: false`; reducer bounds; journal failure modes; no fixture edited to hide a defect).

---

### Task 5: Pane shell, Overview, band

**Files:**
- Create: `mod/hooks/views/shell.tsx`, `mod/hooks/views/overview.tsx`, `mod/hooks/views/band.tsx`, `mod/hooks/views/fit.ts`
- Modify: `mod/hooks/register.tsx`
- Test: `mod/hooks/views/overview.test.tsx`, `mod/hooks/views/band.test.tsx`, `test/fit.test.ts`

**Interfaces:**
- Consumes: `timeline`, `ui` atoms (Task 3); `summary` (Task 2).
- Produces:

```ts
// fit.ts (pure, no claude-code import)
export function fit(text: string, columns: number): string       // cut with '…', never longer than columns, '' for columns <= 0
export function fitLeft(text: string, columns: number): string   // cut from the left with a leading '…'
export function elapsed(fromMs: number, toMs: number): string    // '8s', '2m', '1h04'
export function bar(done: number, total: number, columns: number): { filled: number; rest: number }
// shell.tsx
export function registerShell(on: On, options: { autoOpen?: boolean }): void
export type View = (ctx: { $: EngineInterface; e: RenderInput; t: Timeline; u: UiState; cols: number; now: number }) => RenderElement
export const PANE = 'mission-control'
export const TABS: { tab: Tab; label: string; hotkey: string }[]   // Overview 1, Tasks 2, Agents 3, Timeline 4, Artifacts 5
// overview.tsx / band.tsx
export const overviewView: View
export function registerBand(on: On): void
```

Behaviour:
- `/mc` → `$.ui.open({ id: PANE, title: 'Mission Control', focus: true, columns: 62 })`, answers `{ text: 'Mission Control opened.' }`. `/mc close` → `$.ui.close`. With `autoOpen`, `session.start` opens it without `focus`.
- The shell draws a tab row of five `Button`s, keys `tab-<tab>`, hotkeys `1`–`5`, the current one `variant="primary"`; when `cols < 56` labels shorten to their first three letters. Pressing writes `ui.tab` with `update`. Below it, the current tab's `View` (tabs whose task has not landed draw `Text` "Coming in a later task.").
- Overview (see `docs/mocks/Main.dc.html`), six sections in this order, each headed by a `Button` (`plain`, key `go-<tab>`) that opens its tab, a section with nothing to show left out except Now and Tasks:
  - **NOW** — `focus` bold; `Next  <next>` when set; right of the heading `from Claude · <elapsed> ago` when `fromClaude`, else nothing. With no focus at all: `Idle. Nothing running yet.`
  - **TASKS d/n** — a `Progress` (`value: done`, `max: total`); the current task with elapsed; the upcoming task; a dim `✔ <d> done · ☐ <m> more`. No tasks: `No tasks yet.`
  - **AGENTS r running · f done** — one row per running agent: `▶ <type> · <description>` and dim `<doing>`.
  - **LATEST s steps · e errors · c files changed** — the `latest` steps as `Button`s (key `step-<id>`; pressing opens the Timeline with that step's detail), glyphs as in Task 8.
  - **NOTES** — newest three, `• <text>`, dim agent type when not `main`.
  - **ARTIFACTS n** — newest three, glyph by kind (`↗` page, `▤` document, `◆` result, `⎇` link), title, dim `<kind> · <elapsed>`.
- Band (`AbovePrompt`): `▣ <done>/<total> tasks · ▶ <focus> · <running> agents · /mc`, parts with nothing to say left out; with no tasks, no focus and no running agents it returns `next(e)` (no row).
- A `$.clock.every(1000, ...)` started in `session.start` calls `$.ui.invalidate('ui.render')` only while any agent or step is running.

- [ ] **Step 1:** `test/fit.test.ts`: `fit('abcdef', 4) === 'abc…'`; `fit('abc', 10) === 'abc'`; `fit('abc', 0) === ''`; `fitLeft('src/server/a.ts', 8) === '…r/a.ts'`; `elapsed(0, 8000) === '8s'`, `elapsed(0, 125000) === '2m'`, `elapsed(0, 3840000) === '1h04'`; `bar(2, 6, 36)` → `{ filled: 12, rest: 24 }`; `bar(0, 0, 10)` → `{ filled: 0, rest: 10 }`. Implement. PASS (`npm test`).
- [ ] **Step 2:** `overview.test.tsx`, looped over the four surfaces, seeding state via a `state.get` stub: `shows Claude's focus and next under NOW with "from Claude"`; `with no update, NOW shows the in-progress task and no "from Claude"`; `an empty session says Idle and No tasks yet. and draws no other section`; `lists a running agent with its doing line`; `shows an error step and a pinned step under LATEST`; `shows a note and an artifact`; `pressing go-agents writes ui.tab = 'agents'`; `pressing a latest step opens its detail in the timeline`; `at bodyColumns 24 no Text is longer than 24`; `/mc opens the pane with focus`; `pressing tab-tasks writes ui.tab`. Run `claude plugin test ./mod` — FAIL. Implement `shell.tsx`, `overview.tsx`. PASS.
- [ ] **Step 3:** `band.test.tsx`: `summarises tasks, focus and running agents`; `draws no row for an empty session` (the engine stub's node comes back). Implement `band.tsx`. PASS.
- [ ] **Step 4:** `claude plugin validate ./mod`, `tsc -p mod`, `npm test` all clean. Commit.

**→ Aaron looks at it:** `claude --plugin-dir ./mod`, give Claude a multi-step job with a subagent, type `/mc`. Layout feedback lands here, before Tasks 6–9.

---

### Task 6: Tasks view and Agents list

**Files:**
- Create: `mod/hooks/views/tasks.tsx`, `mod/hooks/views/agents.tsx`; Modify: `mod/hooks/views/shell.tsx`
- Test: `mod/hooks/views/tasks.test.tsx`, `mod/hooks/views/agents.test.tsx`

**Interfaces:**
- Consumes: `taskTree`, `agentGroups` (Task 2); `View`, `fit`, `elapsed` (Task 5).
- Produces: `export const tasksView: View`, `export const agentsView: View`, `export function agentRow(ctx, agent: AgentRow, prefix: string, selected: boolean): RenderElement` (reused by the tree).

Behaviour:
- Tasks (see `docs/mocks/Tasks.dc.html`): one row per task — `✔` completed, `▶` in progress, `☐` pending — subject cut with `fit`; in-progress rows show `activeForm` when set and elapsed since `updatedAt`. Under a task, its `TaskNode.agents`, indented 2, as `└ <type> · <description>` then a dim `▶ <doing>` line; under an agent, its own tasks indented 6. Empty state: `No tasks yet. They appear when Claude writes a task list.`
- Agents list (see `docs/mocks/Agents.dc.html`): a mode row of two `Button`s, `List` (hotkey `l`) and `Tree` (hotkey `t`), writing `ui.agentsMode`; Tree shows "Coming in the next task." until Task 7. One block per group; a run's header `⚙ <name> · workflow · <done>/<n> done`. Each agent is one `Button` (`plain`, key `agent-<id>`): status glyph (`▶` running, `✔` done, `✖` error), `<type> · <description>`, dim `<elapsed> · <stepCount> steps`; a second dim line `<doing>`. Pressing sets `ui.tab = 'timeline'` and `ui.filter = { kind: 'agent', id }`. `main` is listed first as `main · this conversation`. Empty state (only `main`, no steps): `No agents yet. Subagents and workflow agents appear here while they run.`

- [ ] **Step 1:** `tasks.test.tsx` over four surfaces: `shows a completed, an in-progress and a pending task with their glyphs`; `nests an agent and its doing line under the in-progress task`; `nests an agent's own tasks under it`; `empty state text`; `narrow: no Text longer than 24`. FAIL → implement → PASS.
- [ ] **Step 2:** `agents.test.tsx` over four surfaces: `lists main, a running subagent and a finished one with glyphs`; `groups two workflow agents under their run with 1/2 done`; `pressing an agent opens the timeline filtered to it`; `two agents with the same description keep distinct keys`; `pressing Tree writes ui.agentsMode = 'tree'`; `narrow: no Text longer than 24`; `empty state`. FAIL → implement → PASS.
- [ ] **Step 3:** validate, `tsc`, commit.

---

### Task 7: Agents tree

**Files:**
- Create: `mod/hooks/views/tree.tsx`; Modify: `mod/hooks/views/agents.tsx`
- Test: `mod/hooks/views/tree.test.tsx`

**Interfaces:**
- Consumes: `agentTree`, `treeLines` (Task 2); `agentRow` (Task 6).
- Produces: `export const treeView: View`.

Behaviour (see `docs/mocks/AgentsTree.dc.html`): drawn when `ui.agentsMode === 'tree'`. A header `<n> agents · <r> running`. One `Button` (`plain`, key `node-<key>`) per `TreeLine`: the dim `prefix`, then for an agent its glyph, `<type> · <description>` and dim `<elapsed> · <stepCount>`; for a run `⚙ <name> · workflow · <done>/<n> done`. A node with children shows `▾` (open) or `▸` (folded) before its glyph. Under the row that has focus, a dim continuation line with that agent's `doing`. Pressing an agent row opens the Timeline filtered to it; pressing a run row toggles its key in `ui.folded`; each row with children also carries a one-glyph `Button` (key `fold-<key>`) that toggles the fold without leaving the tab. The description is cut first, then the type, so the prefix always survives; deeper than 6 levels the prefix is replaced by `<depth>›`.

- [ ] **Step 1:** Tests over four surfaces: `draws main, two children and a grandchild with ├─ │ └─ prefixes`; `a workflow run is a node holding its agents with n/m done`; `folding a node hides its descendants and shows ▸`; `pressing an agent row filters the timeline to it`; `pressing a run row folds it`; `an agent whose parent never spawned sits under main`; `depth 8 at bodyColumns 24 keeps every Text within 24`; `only main: one row and the empty-state line`. FAIL → implement → PASS.
- [ ] **Step 2:** validate, `tsc`, commit.

---

### Task 8: Timeline, detail and pins

**Files:**
- Create: `mod/hooks/views/timeline.tsx`, `mod/hooks/views/detail.tsx`, `mod/hooks/model/window.ts`; Modify: `shell.tsx`, `register.tsx`
- Test: `mod/hooks/views/timeline.test.tsx`, `mod/hooks/views/detail.test.tsx`, `test/window.test.ts`

**Interfaces:**
- Consumes: `stepGroups`, `StepFilter` (Task 2); `readBody`, `apply` (Task 3); `View` (Task 5).
- Produces: `export const timelineView: View`, `export const detailView: View`, and
  `export function windowRows(count: number, offset: number, bodyRows: number, pad?: number): { from: number; to: number }` — which rows to draw for a scroll position, `pad` (default 20) extra on each side.

Behaviour (see `docs/mocks/Timeline.dc.html`, `Detail.dc.html`):
- A filter row of `Button`s: `All`, `★ Pinned <n>`, `✖ Errors <n>`, plus a chip `<agent> ✕` when an agent filter is on (pressing it returns to All).
- Groups newest first; header = the turn's prompt (`fit`), dim time. The newest turn is open; older turns are folded to a header plus a dim `<n> steps · <m> agents` line, and pressing a header toggles it (kept in a `ui` field `openTurns: string[]` — add it to the contract and bump the `ui` shape tag to `ui-2`). Each step is one `Button` (`plain`, key `step-<id>`): status glyph (`·` running, `✔`, `✖` error, `⊘` denied, `◌` interrupted), `★` when pinned, label, dim agent type when not `main`, dim duration; a pinned step with a note shows the note on a dim second line. Only the rows `windowRows` selects are drawn (from `e.props.scroll`), with `Box` spacers of the skipped height above and below.
- Pressing a step: write `ui.detail = { stepId }`, then `readBody` and write the body (or `missing: true`). The shell draws `detailView` instead of the tab when `ui.detail` is set.
- Detail: header lines (tool, agent, start time, duration, status, pin note); `Input` as a `Code` block of the JSON; for `Edit`/`Write` inputs holding `old_string`/`new_string`, a `Change` section as `Code format="diff"` built as a single-hunk unified diff; `Result` as `Code`; a dim line `… <cut> more characters not kept` when `cut > 0`; `Result not kept on disk.` when missing. Buttons: `Back` (hotkey `b`, `role="dismiss"`, clears `ui.detail`), `Pin`/`Unpin` (hotkey `p`), `Copy result` (hotkey `c`, `$.ui.copy({ text, surface: e.surface })`).
- `/mc pin <note…>` pins the newest step of the main loop with the note; `/mc pin` with none pins it with `''`. Answers `{ text: 'Pinned: <label>' }` or `{ text: 'Nothing to pin yet.' }`.

- [ ] **Step 1:** `test/window.test.ts`: `windowRows(2000, 500, 30)` → `{ from: 480, to: 550 }`; offset 0 → `from: 0`; offset past the end clamps to the last window; `windowRows(0, 0, 30)` → `{ from: 0, to: 0 }`. Implement. PASS.
- [ ] **Step 2:** `timeline.test.tsx` over four surfaces: `the newest turn is open and older turns are folded with a step count`; `pressing a folded turn opens it`; `the Errors filter shows only error steps`; `an agent filter shows its chip and clearing it returns to All`; `2,000 steps draw fewer than 200 Buttons`; `pressing a step opens its detail`; `/mc pin note pins the newest main step and it shows ★ and the note`; `/mc pin with no steps says Nothing to pin yet.`; `a ui value stored as ui-1 is read as the initial value`; `narrow: no Text longer than 24`; `empty state: No steps yet.`. FAIL → implement → PASS.
- [ ] **Step 3:** `detail.test.tsx`: `shows input and result`; `an Edit shows a diff Code`; `a cut body says how much is not kept`; `a missing body says so`; `Pin toggles to Unpin and writes the pin`; `Back clears detail`; `Copy calls ui.copy with the result text`. FAIL → implement → PASS.
- [ ] **Step 4:** validate, `tsc`, `npm test`; commit.

---

### Task 9: Artifacts view, docs and CI

**Files:**
- Create: `mod/hooks/views/artifacts.tsx`; Modify: `shell.tsx`, `README.md`
- Test: `mod/hooks/views/artifacts.test.tsx`

**Interfaces:**
- Consumes: `Timeline.artifacts`, `Timeline.changed`, `View`, `fit`, `fitLeft`, `elapsed`.
- Produces: `export const artifactsView: View`.

Behaviour (see `docs/mocks/Artifacts.dc.html`): rows newest first, each a `Button` (`plain`, key `art-<index>`) of two lines: glyph by kind (`↗` page, `▤` document, `◆` result, `⎇` link), bold title, dim `<kind> · <elapsed>`; then dim `summary`, else `ref` (`fitLeft` for a path), plus `· ×<count>` when `count > 1`. Pressing a row with a `stepId` still in the timeline opens that step's detail; otherwise it copies `ref ?? title` with `$.ui.copy` and toasts `Copied.` A footer: the legend line, then `Code edits are not listed here; they are steps in the Timeline (<changed> files changed).` Empty state: `No artifacts yet. Pages Claude publishes, documents it writes and results it reports are listed here.`

- [ ] **Step 1:** Tests over four surfaces: `lists a page, a document, a result and a link with their glyphs`; `a document written three times shows ×3`; `pressing a document opens the step that wrote it`; `pressing a link with no step copies its ref`; `the footer counts changed files`; `a long path is cut from the left and fits 24 columns`; `empty state`. FAIL → implement → PASS.
- [ ] **Step 2:** Finish `README.md`: what it shows, `/mc` commands, keys (Ctrl+X Tab to focus, 1–5 tabs, Esc back to prompt, Ctrl+X X close), the three options (`guide`, `autoOpen`, `probe`), the dev loop, the `CLAUDE_CODE_PLUGIN_DIRS` line for always-on use, what the guide adds to the system prompt (quote `GUIDE_TEXT`), where the journal lives and how to delete it.
- [ ] **Step 3:** Full check: `claude plugin validate ./mod --strict`, `claude plugin test ./mod`, `tsc -p mod`, `npm test`. All clean. Commit.

**→ Opus review of Tasks 5–9**, then **one adversarial whole-branch pass (Opus)** against Review Focus and the spec's anti-goals, then open the PR.

---

## Findings (filled in by Task 1, added to by Task 4)

Probed on Claude Code 2.1.325, Windows 11, main model `--model haiku` (the
model gave Explore, general-purpose and workflow agents `sonnet`). Evidence is
in `test/fixtures/probe-*.jsonl` (one line per event, `at` monotonic). Exact
command lines (Git Bash, from the repo root; `MSYS_NO_PATHCONV=1` stops Git
Bash rewriting `/mc` into a Windows path):

```sh
P='{"pluginConfigs":{"mission-control":{"options":{"probe":true}}}}'
claude -p "Use the Explore agent to count the .json files in this folder, then tell me the number." --plugin-dir ./mod --model haiku --settings "$P"   # probe-subagent (a file with the same JSON was passed)
claude -p "Create a task list with three tasks named A, B, C, mark A in progress then completed, then stop." --plugin-dir ./mod --model haiku --settings "$P" --tools "Read,Bash,TaskCreate,TaskUpdate,TaskList,TaskGet,TodoWrite"   # probe-tasks
claude -p "Run a workflow with two agents that each read package.json and report its name field." --plugin-dir ./mod --model haiku --settings "$P"   # probe-workflow (real run, not synthetic)
claude -p "Use the Explore agent to read README.md and summarise it in one line." --plugin-dir ./mod --model haiku --settings "$P"   # probe-guide
```

No `--permission-mode` was needed (the user's settings already run `auto`).

**Fixture lines beyond the event input.** `tool.call` and `agent.spawn` lines
are written before `next(e)` and carry `e` only. Their results are separate
lines: `tool.result` with `e = { tool, tool_use_id, agentId }` and
`r` = what `next(e)` resolved to; `agent.spawned` with
`e = { tool_use_id, parentAgentId }` and `r = { model, agentId }`.
`turn.start`, `turn.complete` and `session.receive` lines are written after
`next(e)` and carry `e` and `r`. There is no `tool.result` or `agent.spawned`
event in the engine: those two names are the probe's own.
`session.receive` never fired in any run (it is for deliveries such as Remote
Control and peer messages); a subagent's hand-back reaches the main loop as a
new main `turn.start` whose `text` begins `<agent-message from="<agentId>">`,
and a finished workflow as one whose text begins `<task-notification>`.

**(a) Subagent tool calls reach `tool.call` with `agentId`: yes.** In
probe-subagent the Explore agent's `PowerShell` and `SubagentHandback` calls
carry `agentId: "a41a5036f06e55d2f"`, the same id `agent.spawned` resolved
(`r.agentId`). Main-loop calls carry no `agentId` key at all. The subagent's
own `turn.start`/`turn.complete` carry the same `agentId`. The Agent call can
run in the foreground (`background: false`; its `tool.result` arrives after
the subagent's run, `result.status: "completed"`, with
`result.handbackReport.text`) or in the background (`background: true`;
`tool.result` comes back at once with `result.status: "async_launched"`, the
main turn ends, and the subagent's calls arrive afterwards). Both happened
with the same prompt (probe-subagent is foreground, probe-guide background).

**(b) Workflow agents' tool calls: yes.** In probe-workflow both agents'
`Read` and `StructuredOutput` calls carry `agentId`
(`aceff99dd3da32c85`, `a7eba813391b91f8e`). Their `agent.spawn` has
`subagentType: "workflow-subagent"`, `description: "read:agent-1"`,
`workflow: { runId: "wf_18950403-0bb", agentIndex: 1 }` (then 2), and
`tool_use_id` = the `Workflow` call's id, shared by both agents. The
`Workflow` tool's `tool.result` arrives *before* the agents spawn, with
`result: { status: "async_launched", taskId, taskType: "local_workflow",
workflowName, runId, summary, transcriptDir, scriptPath }`.

**(c) Task tools.** A `claude -p` session offers no task tools by default
(the first tasks run had none and the model answered in text); with
`--tools` naming them it used `TaskCreate` ×3 then `TaskUpdate` ×2.
`TodoWrite` was offered and not chosen. `TaskCreate`'s result does carry the
id: `r.result.task = { id: "1", subject: "Task A", description: "Task A" }`
(id a string; `r.text` is `"Task #1 created successfully: Task A"`).
`TaskUpdate`'s result: `{ success: true, taskId: "1", updatedFields:
["status"], statusChange: { from: "pending", to: "in_progress" } }`.

**(d) `turn.complete` carries the subagent's answer: yes, with one gap.** For
Explore and general-purpose agents, `e.answer` on the `turn.complete` with
their `agentId` is the hand-back report (probe-subagent, probe-guide). For
workflow agents that answer through `StructuredOutput`, `e.answer` is `""`
(probe-workflow); their result is the input of their `StructuredOutput`
tool call.

**(e) `e.tool_use_id`** looks like `toolu_01UYdhYZeh3yVfzeBAqZcPDt`:
`toolu_` plus 24 letters and digits, 30 characters. It was unique per call
across all 21 `tool.call` lines of the four fixtures, main and agents alike.
It is not unique per `agent.spawn`: workflow agents share their `Workflow`
call's id.

**(f) `userConfig` options for a `--plugin-dir` mod** are read from settings
under `pluginConfigs["mission-control"].options` (the plain plugin name
worked; the debug log names the plugin `mission-control@inline`). For a
one-off run, `--settings '<json>'` (inline JSON or a file path) set
`probe: true` without touching `~/.claude/settings.json`.

**(g) `$.state` size:** 64 KB, 512 KB and 2 MB strings each round-tripped
(`isSet: true`, read back equal), in a real session and in
`claude plugin test`. 8 MB was refused: `$.state.set: the value is 8388610
characters, over the 4194304 limit`. The limit is 4,194,304 characters of
the value as JSON (4 MiB). The `Timeline` must stay well under this; the
step bounds alone do not guarantee it if inputs are large, so keep stored
inputs and labels short.

**(h) `$.fs.write('~/.claude/mission-control/x.json')` succeeds but `~` is
not expanded**: it created a literal folder named `~` inside the working
directory (`<cwd>/~/.claude/mission-control/probe-x.json`;
`$.fs.exists` of the home path said `false`). An absolute path built from
`await $.env.get('USERPROFILE') ?? await $.env.get('HOME')`
(`C:\Users\<name>` here; `$.env.get` names must be string literals) wrote
`<home>/.claude/mission-control/…` fine, creating the folders. Journal paths
must be built from that, never with `~`.

**(i) The model called the probe tool because the section told it to: yes,**
in every run (8 of 8 sessions with the section: the four fixtures, a first
subagent run, a tasks run without task tools, a guide run before README.md
existed and a general-purpose run), as its first call, with a
five-word-ish focus (`{"focus": "Counting JSON files in folder"}`), and only
once per session. Exact shapes that worked:
`await $.tool.register({ name: 'probe_update', description, inputSchema:
{ type: 'object', properties: { focus: { type: 'string' } }, required:
['focus'] }, isDeferred: false })` resolved `{ tool:
'mcp__mission-control__probe_update' }` (the engine serves it over a local
MCP HTTP server; registering it from `session.start`, before `next(e)`,
worked). `on('tool.call', { tool: 'mcp__mission-control__probe_update' },
() => ({ result: 'ok' }))` answered it; the outer hook saw `{ result: 'ok' }`.
`prompt.compose`: `(await next(e)).sections` is a list of
`{ id, text, scope }`; under `-p` the input's `traits` were
`['lean', 'print', 'skills']` and the ids `lean_body` (shared), then
`pronouns`, `action_caution`, `user_privacy`, `session_guidance`, `memory`,
`env_info_simple`, `context_management`, `act_dont_rederive`,
`heron_brook`, `total_tokens` (session). Returning
`{ sections: [...sections, { id: 'mission-control:probe', text, scope:
'session' }] }` was accepted. The hook ran once per main-loop prompt render
(again when the tool list changed, 237 → 416 tools once MCP servers
connected).

**(j) Subagents did not see the section and did not call the tool.** No
`probe_update` call has an `agentId` in any fixture. `prompt.compose` ran
only for the main loop (every recorded compose has `model:
claude-haiku-5-5`; none for the Sonnet subagents), confirmed in the debug
log of the first subagent run (two `prompt.compose settled` lines, both
main turns) and in an extra foreground general-purpose run (one compose, no
agent call to the tool). This holds for Explore, general-purpose and
workflow agents.

**(k) One `tool.call` hook with a `{ tool }` matcher and one without: both
run, nested in registration order, the first registered outermost.** A
matcher gives no priority. Pinned by `mod/hooks/hook-order.test.ts`
(`claude plugin test ./mod`), and seen in the real runs: the probe's plain
hook (registered first) recorded the `probe_update` call, then the matched
hook (registered second) answered it beneath, and the plain hook recorded
its `{ result: 'ok' }`. A hook that answers without `next` hides the call
from every hook registered after it.

**Other things the engine settled**

- **A module may hook an event only once without a matcher.** `claude plugin
  validate` refuses `on("session.start") is registered twice without a
  matcher` (checked for `session.start` and `tool.call`, across files of one
  module). Hooks with matchers may repeat.
- **A state contract exports types only.** `export {}` in
  `mod/types/index.d.ts` fails validate: "a contract exports types and
  nothing else". The probe's temporary contract was removed again.
- **Types for `tsc -p mod`.** A plain `claude -p "/mc" --plugin-dir ./mod`
  printed `mission-control: Mission Control: not built yet.` and laid no
  types. With `CLAUDE_CODE_PLUGIN_DIR_WATCH=1` set the same run laid
  `mod/.claude-plugin/types/` *and wrote `mod/tsconfig.json` itself*
  (`{ "extends": "./.claude-plugin/types/tsconfig.json" }`); that file is
  committed as written. `tsc -p mod` then passes.
- **Inline plugins in `claude plugin test`** run as modules of their own:
  each hook must be a function literal using no outside names.
- **Tooling.** TypeScript is pinned to `~5.9.3` (npm's `latest` is 7.0.2, a
  different compiler; the type file asks for 5.4+). vitest is `^5.1.0`
  because vitest 3 has open critical advisories and `npm install` of vitest
  4.1.12 crashes npm 10.9.9 (`Cannot read properties of null (reading
  'edgesOut')`); vitest 5 needs Node ≥ 22.12, so **CI runs Node 22, not 20**.
  `vitest.config.ts` sets `passWithNoTests` until Task 2 adds tests.

**Plan change: one hook per event per module.** Task 3's capture hooks
(`tool.call`, `agent.spawn`, `turn.start`, `turn.complete`, all without a
matcher) clash with the probe's identical hooks in `probe.ts`, and every
`session.start` the plan adds (Task 3 Step 4, Task 4's tool registration,
Task 5's auto-open and clock) must live in the one `session.start` hook in
`register.tsx`, which calls helpers. Suggested: Task 3 folds the probe into
capture (capture's hooks call a probe recorder when `options.probe`), or
deletes `probe.ts` once its fixtures exist; `registerGuide` and
`registerShell` export session-start helpers instead of registering their
own `session.start`. `prompt.compose` is hooked only by the guide, so it is
unaffected. Task 3's `tool.call` rule for `UPDATE_TOOL` works as written in
either order (per (k)); registering the guide's matched hook first would
make the capture check unnecessary.

**Plan change: subagents never get the guide.** The spec's "Subagents get
the same section and tool, so their notes land too" does not hold on this
build: `prompt.compose` is not raised for subagent or workflow-agent system
prompts (j). Task 4's `a subagent's focus sets its doing` still passes in
the test kit but will not happen in real use. A subagent's `doing` will come
only from its step labels and its `turn.complete` answer (empty for
workflow agents). The way to reach subagents would be rewriting the Agent
prompt in `agent.spawn` (`next({ ...e, prompt })`), which changes the
conversation and needs Aaron's decision.

**Plan change (minor): headless runs have no task tools.** Task 4 Step 3's
three runs count focus updates only, so they are unaffected, but any
headless check of the task list needs `--tools` naming `TaskCreate`,
`TaskUpdate` (and the rest it uses).

**Task 4: does the guide get Claude to set a focus?** Three runs of
`claude -p "Use the Explore agent to read README.md, then tell me in one
line what this repo is." --model haiku --plugin-dir ./mod` (guide on by
default), counted in `<home>/.claude/mission-control/<session-id>/timeline.json`:

- With the brief's text, **0 of 3** set `now.focus`. A `--debug-file` run
  showed the wiring is sound: `$.tool.register` served
  `mcp__mission-control__update` before the first prompt ("visible after
  43ms"), and the model, asked, named the tool and the "Mission Control"
  section. Haiku simply read "whenever what you are working on changes" as
  optional on a one-shot request.
- One change to the second bullet, which now reads: "Call
  mcp__mission-control__update with `focus` (and `next` when you know it)
  as your first tool call on a new request, and again whenever what you are
  working on changes. One short line each." With it, **3 of 3** set
  `now.focus` and `now.next` (e.g. focus "Reading README.md via Explore
  agent to summarise the repo in one line", next "Report the one-line
  summary"). One run also added a note ("Explore agent is reading
  README.md; result pending."), which is status rather than something to
  find again later. No reply mentioned the panel or the updates.
- Fix round 1 (review I4): "as your first tool call on a new request" would
  add an update call, and a second model request, to replies that need no
  tools. The bullet now reads: "When a request needs tools, include a
  mcp__mission-control__update call with `focus` (and `next` when you know
  it) alongside your first tool call(s), and again whenever what you are
  working on changes; skip it for replies that need no tools. One short
  line each." The rest of the text is unchanged. First attempt, no further
  iteration needed, on `--model haiku`, one session at a time:
  - The same README prompt, three runs: **3 of 3** set `now.focus` and
    `now.next` (e.g. "Reading README.md via Explore agent to summarise the
    repo" / "Report one-line description of the repo"). Haiku still sends
    the update in its own message before the `Agent` call rather than
    alongside it: one extra round trip on tool-using requests remains.
  - `claude -p "In one sentence, what does the word idempotent mean?"
    --model haiku --plugin-dir ./mod`: **no update call** (stream-json shows
    no tool use at all); `now` is unset.
  - Each run's `timeline.json` carried `journal` equal to its session id
    (review I3's stamp, seen live).

**Task 4: `ToolUse` has no `bodyColumns`.** The type file gives
`bodyColumns` to `Pane`, `AbovePrompt` and `AbovePromptList` only. The
update tool's row is cut to `e.viewport.columns` (80 when no surface has
measured). The row and `ToolResult` hooks pass to `next(e)` when
`isExpanded` is true, as the type file asks of a compact row, so ctrl+o
still shows the full call. The empty `ToolResult` answer is an empty `Box`
(the kit accepts it and finds no `Text` in it).
