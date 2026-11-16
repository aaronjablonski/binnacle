# Mission Control — a Claude Code mod (design)

Date: 2026-11-15. Status: draft, awaiting Aaron's approval.

## Intent

Working in the Claude Code CLI, important intermediate steps scroll away: long
file dumps bury them, and scrolling back to find "that step from ten minutes
ago" is slow. Tasks and sub-tasks are barely visible, and it is hard to tell
what each subagent or workflow agent is doing right now.

Mission Control is a mod (a plugin with a hooks module) that keeps a
**persistent, navigable record of the session beside the chat**: tasks and
sub-tasks, running agents and workflows with a one-line "doing now", a
timeline of steps that can be reopened in detail, and the files and pages the
session produced. The normal transcript stays exactly as it is.

This replaces the VS Code extension (`../claude-code-workflow-visualizer`) as
the focus for now. This repo is the mod's own; the extension repo is left as
it is and is a source of ideas only.

## Goals

1. A task list with sub-tasks that is always visible while working.
2. A live list of agents (subagents, teammates, workflow agents grouped by
   run) with status and a one-line summary of what each is doing.
3. A timeline of every tool step that survives scrolling, with a detail view
   (input, result, diff) reachable in two key presses.
4. Pins: mark a step as important so it can be found again instantly.
5. A list of artifacts: what the session produced for a person to read or
   keep (published pages, documents, results, links). Not every edited file.
6a. An Overview, the first tab: a condensed, always-current view of all the
   others, including a "Now" line and notes that Claude itself keeps current
   because the mod tells it to.
6. The record survives a mod reload, `/clear`, and `--resume` of the session.
7. A local dev loop that needs no publishing: edit, save, see it reload.

## Non-goals (v1)

- Changing how the transcript itself is drawn (collapsing long tool output in
  place). Worth doing later; it touches every row and is the riskiest site.
- Model-written summaries of agents. v1 summaries are derived from the last
  tool call and cost nothing. A model summary is a later opt-in.
- A drawn node-and-edge graph, waterfall, cost analytics, cross-session
  compare. (A text tree of agents is in; see Agents.)
- Desktop, VS Code and mobile polish. The trees must validate there (tests
  mount on every surface) but only the terminal is tuned.
- Publishing to a marketplace.

## Anti-goals

- The mod never blocks or rewrites Claude's work: every capture hook observes
  and returns `next(e)` unchanged. No denies, no rewritten tool calls or
  prompts.
- The one thing it adds to the conversation is deliberate and small (Aaron's
  ask, 2026-11-15): one system-prompt section and one tool, through which
  Claude keeps the Overview current. It can be switched off (`guide: false`).
- The mod makes no model calls of its own. The guide costs Claude a short
  tool call now and then; nothing else.
- No unbounded growth: state held in the session is capped.

## Constraints (verified against Claude Code 2.1.325's type file and docs)

- A mod is `.claude-plugin/plugin.json` + `hooks/hooks.json` +
  one hooks module; no build step, no Node APIs, no `setTimeout`, relative
  imports only, no dynamic `import()`. Everything external goes through `$`.
- Drawing: a `Pane` docks beside the transcript in a fullscreen terminal
  (width request up to 45% of columns), otherwise sits inline above the
  prompt. A pane opened unasked appears only at ≥144 columns (≥110 once the
  person has opened it); opened by a command it shows at any width. A band
  row above the prompt is always available. Elements: `Box`, `Text`,
  `Button`, `Markdown`, `Code` (incl. `format: 'diff'`), `Select`, `Input`,
  `Progress`. Keys reach a pane only when it has focus (Ctrl+X Tab, click, or
  opened with `focus`); Tab/arrows walk buttons, hotkeys press them.
- Events available: `turn.start` / `turn.complete` (carry `agentId` for
  subagent loops), `tool.call` (carries `agentId`, `tool_use_id`, the tool's
  input; `await next(e)` gives the result incl. `text`, `isError`),
  `agent.spawn` (carries `description`, `subagentType`, `parentAgentId`, and
  for workflow agents `workflow: { runId, agentIndex }`), `session.receive`
  (background-task notifications). `$.agent.list()` lists subagents and
  teammates but **not** workflow agents.
- Tasks are tool calls: `TaskCreate` (result has the new `id`), `TaskUpdate`
  (`taskId`, `status`), and the older `TodoWrite` (whole list each call).
  There is no parent field: the task tools have no native sub-tasks.
- There is no workflow-run event. A run is known by the `Workflow` tool call
  (result: `workflowName`, run id) and by its agents' `agent.spawn`.
- Limits: a hook has 10 s; `$.state` lives for the session and outlives a
  reload; `$.store` is 4 MiB for all sessions; `$.fs` reads/writes ≤4 MiB per
  file; a tree draws ≤100,000 characters and ≤20,000 elements.
- The API is early access and moves between releases; the generated type file
  is the authority.

Not yet verified, settled by the spike in plan Task 1: that subagent and
workflow-agent tool calls really reach a user mod's `tool.call` hook with
`agentId`; how large a `$.state` value may be; where `$.fs` may write.

## Approaches

**A. Pure mod, new code in `mod/` (chosen).** Capture with observing hooks,
reduce into one small model, draw a pane and a band. Lives in this repo, runs
with `claude --plugin-dir ./mod`. One process, no install, hot reload.

**B. Mod as a thin feeder for the existing webview.** The mod forwards events
to the VS Code extension's listener and the rich React UI draws them. Reuses
the most code, but it is the VS Code app Aaron asked to set aside, and it
leaves the terminal itself no better.

**C. Settings hooks + a separate TUI in a second terminal.** Works on any
version and has no drawing limits, but it is not native, needs a second
window, and duplicates what the mods API now gives directly.

A is chosen because the ask is a native interface in the CLI. What is reused
from the extension is ideas, not code: granularity bundling from the Activity
view, the repeat-failure signature from Problems. The webview modules depend
on React and the JSONL-shaped model, and a mod can import only its own files.

## Design

### Shape

- Mod name `mission-control`, folder `mod/` at the repo root. The mod sits in
  a subfolder so `node_modules`, tests and docs stay outside the folder the
  engine watches and loads.
- Slash command `/mc` opens (and focuses) the pane; `/mc pin [note]` pins the
  latest step; `/mc close` closes it.
- A band row above the prompt, always on:
  `▣ 3/7 tasks · ▶ Wiring capture hooks · 2 agents · /mc`
- The pane, with five tabs and a detail view. Mocks:
  https://claude.ai/artifact/L51pHiKbjfBac7eQEVUUnF

```
 [1 Overview] [2 Tasks] [3 Agents] [4 Timeline] [5 Artifacts]
 ─────────────────────────────────────────────
 NOW                          from Claude · 20s ago
 Wiring the limiter into the chain
 Next  Return 429 with Retry-After

 TASKS 2/6  ━━━━━━──────────────
 ▶ Wiring limiter into chain                 2m
 ☐ Return 429 with Retry-After
 AGENTS 2 running · 1 done
 ▶ Explore · find callers    Grep "upload\("
 LATEST 14 steps · 1 error · 4 files changed
 ✖ Bash npm test -- rateLimit
 NOTES                              from Claude
 • upload() is reached from 3 routes
 ARTIFACTS 2
 ↗ Rate limit design               page · 9m
```

  - **Overview** (default tab): one short section per other tab, live.
    *Now* (focus and next, written by Claude), *Tasks* (progress bar, the task
    in progress, the next one), *Agents* (running ones with "doing now"),
    *Latest* (last few steps, any error, pins, count of files changed),
    *Notes* (key findings written by Claude), *Artifacts* (newest few). Each
    heading opens its tab; each row opens what it names. If Claude has sent
    no update, *Now* falls back to the in-progress task and the latest step.
  - **Tasks**: the task list. Under the task in progress, the agents spawned
    while it was in progress, each with its "doing now" line; under an agent,
    any tasks that agent itself created. This is how sub-tasks appear, since
    the task tools have no parent field. (My call — see Calls.)
  - **Agents**: every agent, running first; workflow agents grouped under
    their run (`wf_…`, workflow name, `n/m done`). Each row: type,
    description, status, elapsed, step count, "doing now". Pressing a row
    opens the Timeline filtered to that agent. A `List | Tree` switch
    (hotkeys `l` / `t`, remembered) offers a **tree** like the extension's
    topology view, in text: `main` at the root, each agent under the agent
    that spawned it, a workflow run as a node holding its agents, drawn with
    `├─ └─ │`, branches foldable. The tree is optional; List is the default.
  - **Timeline**: steps newest first, grouped by turn (the prompt's first
    line as the group header). Filters: All · Pinned · Errors · one agent.
    Pressing a step opens its detail.
  - **Artifacts**: what the session produced, newest first, four kinds:
    *page* (published with the Artifact tool), *document* (a written file
    that is not code: `.md`, `.html`, `.pdf`, `.docx`, `.pptx`, `.xlsx`,
    `.csv`, images), *result* (something Claude declares: a review's
    findings, a report), *link* (a PR or URL Claude declares). Pressing one
    opens the step that made it. Code edits are not listed: a Files tab would
    blow up; they stay steps in the Timeline, counted in the Overview.
  - **Detail**: tool, agent, time, duration, status; the input; the result
    text (first 20,000 characters); for Edit/Write a diff. Buttons: Pin /
    Unpin, Copy result, Back.

### Parts

1. **Model** (`mod/hooks/model/`): plain TypeScript with no `claude-code`
   runtime import. A `Timeline` value and a pure `reduce(timeline, event)`.
   Bounded: at most 2,000 steps and 200 turns are kept (oldest unpinned
   dropped first; pinned steps are never dropped). Tested with vitest in CI.
2. **Capture** (`mod/hooks/capture.ts`): observing hooks that turn engine
   events into model events and apply them to `$.state`.
3. **Journal** (`mod/hooks/journal.ts`): step bodies (input, result text) are
   too big for state, so each is written to a file under
   `~/.claude/mission-control/<session-id>/steps/<step-id>.json`, and the
   model is snapshotted to `…/timeline.json` at each `turn.complete`. Detail
   reads a step file on demand. On `session.start` and on
   `classic.SessionStart` (clear/resume/fork) the snapshot is loaded back.
4. **Views** (`mod/hooks/views/`): one file per tab, plus band and detail.
   Each is a function from the model (and pane props) to a tree.
5. **Guide** (`mod/hooks/guide.ts`): how Claude keeps the Overview current.
   - A tool `mcp__mission-control__update`, listed from the start (not behind
     tool search), with optional fields `focus` (what is being done now, one
     line), `next` (one line), `note` (a finding worth keeping), `artifact`
     (`{ title, kind: 'result' | 'link', ref?, summary? }`). The mod answers
     it itself with a short "ok"; nothing else runs.
   - One system-prompt section (via `prompt.compose`, fixed text so the
     prompt cache holds) telling Claude: keep the task list current with the
     task tools; call the update tool when the focus changes, when it learns
     something the person would want to find again, and when it produces a
     result; one short line each; never more than once per step.
   - The tool's row in the transcript is drawn as one dim line
     (`◆ Mission Control updated: …`) so it adds no noise, and it is not
     listed as a step in the Timeline.
   - The band's "current" text is `focus` when Claude has set one.

### What "doing now" means

The label of the agent's most recent step: tool name plus its most telling
argument (`Edit src/foo.ts`, `Bash npm test`, `Grep "on\("`), cut to fit.
When the agent's turn completes, the first line of its answer replaces it.

## Developing and testing locally

- Run: `claude --plugin-dir ./mod` in the repo. The folder is watched; saving
  a file reloads the mod (state kept). `claude --debug-file mod-debug.log
  --plugin-dir ./mod` for the reasons a hook was skipped.
- Static check: `claude plugin validate ./mod`.
- Type check: `tsc -p mod` (the engine lays the types in
  `mod/.claude-plugin/types/` on first load; that folder is git-ignored).
- Hook and drawing tests: `claude plugin test ./mod` runs `mod/**/*.test.tsx`
  against the engine with no session, sign-in or network.
- Model tests: `npm test` (vitest, `test/`), which CI runs.
- Use it everywhere while developing: add the absolute path of `mod/` to
  `CLAUDE_CODE_PLUGIN_DIRS` under `env` in `~/.claude/settings.json`.
- Publishing later is one `marketplace.json`; not part of this work.

## Calls I made (Aaron: correct any of these)

- Name `mission-control`, command `/mc`, folder `mod/`.
- Sub-tasks are derived (agents under the in-progress task, an agent's own
  tasks under the agent) because no parent field exists.
- The pane opens on `/mc`, not by itself at session start; the band is the
  always-on part. Auto-open is a `userConfig` option, default off.
- Step bodies go to `~/.claude/mission-control/`, pruned to the newest 20
  sessions at session start.
- No transcript restyling (beyond the update tool's own row) and no model
  summaries in v1.
- Claude updates the Overview through a tool plus a system-prompt section,
  not by the mod asking a model itself. Subagents get the same section and
  tool, so their notes land too, tagged with the agent.
- "Artifact" means page, document, result or link as defined above.

## Left to the builder

Exact glyphs, colors, column widths, truncation points, and the label rule
for tools not named above (default: tool name plus the first string
argument).
