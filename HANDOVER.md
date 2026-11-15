# Handover — Mission Control mod

Written 2026-11-15 at the end of the planning session, which ran in
`../claude-code-workflow-visualizer`. Nothing is built yet. This repo holds
the design, the plan, the mock sources and this note. Nothing is committed.

## What this is

Aaron wants a native interface inside the Claude Code CLI that shows what a
session is doing and keeps it findable: tasks and sub-tasks, running agents
and workflows with a one-line "doing now", a timeline of steps that can be
reopened after they scroll away, and the artifacts the session produced. The
trigger: in the plain CLI, long file dumps bury important intermediate steps
and scrolling back to find them is slow.

It is built as a **Claude Code mod**: a plugin with a hooks module that draws
a pane beside the chat and a band above the prompt. It replaces the VS Code
extension in `../claude-code-workflow-visualizer` as the focus; that repo is
left alone.

## Where things are

| What | Where |
|---|---|
| Design (read first) | `docs/superpowers/specs/2026-11-15-mission-control-mod-design.md` |
| Implementation plan, 9 tasks | `docs/superpowers/plans/2026-11-15-mission-control-mod.md` |
| Mocks (8 boards) | https://claude.ai/artifact/L51pHiKbjfBac7eQEVUUnF — private to Aaron |
| Mock sources | `docs/mocks/*.dc.html` + `canvas.json` (copies; the plan's view tasks point at them) |
| Working rules | `CLAUDE.md`; local-only rules in `CLAUDE.local.md` (git-ignored: no Claude attribution on commits or PRs) |
| The mod itself | `mod/` — does not exist yet; Task 1 creates it |

## Decisions Aaron made

- A CLI mod, not a VS Code extension, for now.
- Its own repo: this folder.
- **Overview is the first tab**: a condensed, always-current view of all the
  other tabs.
- **The mod instructs Claude to keep the Overview updated as it works.** This
  is the one place the mod adds to a conversation.
- **An Artifacts tab instead of a Files tab** — a list of every edited file
  would blow up.
- An optional **tree view of agents and subagents**, like the extension's
  topology view.
- Planning on Fable in that session; **execution on Opus and/or Sonnet**.

## Calls made for Aaron, not yet confirmed

He saw these and moved on without objecting; treat them as defaults he can
overturn, and ask before building on any that looks shaky.

1. Name `mission-control`, command `/mc`, mod in `mod/`.
2. Tabs: 1 Overview · 2 Tasks · 3 Agents · 4 Timeline · 5 Artifacts.
3. "Artifact" means four kinds: page (published with the Artifact tool),
   document (a written non-code file), result and link (declared by Claude).
4. Claude updates the Overview through one tool
   (`mcp__mission-control__update`: focus, next, note, artifact) plus one
   fixed system-prompt section; subagents get both too. Option `guide: false`
   turns it off.
5. Overview sections, in order: Now, Tasks, Agents, Latest, Notes, Artifacts.
6. Sub-tasks are derived, because the task tools have no parent field: agents
   sit under the task that was in progress when they spawned, and an agent's
   own tasks sit under that agent.
7. The pane opens on `/mc`, not by itself (`autoOpen` option, default off);
   the band is the always-on part.
8. The agent tree is a text tree inside the Agents tab (`List | Tree`), List
   being the default. No drawn graph.
9. In the Timeline, older turns are folded and pin notes show inline.
10. Step bodies are kept under `~/.claude/mission-control/<session-id>/`,
    pruned to the newest 20 sessions.
11. Not in v1: restyling the transcript (collapsing long output in place),
    model-written agent summaries, graph or waterfall views, cost analytics.

Three questions were asked and not answered: whether the four artifact kinds
are what he means; whether subagents should get the update instruction or
only the main conversation; whether the Overview's sections and order are
right.

## What is known about the mods API

Checked against Claude Code **2.1.325**'s generated type file and the docs at
https://code.claude.com/docs/en/plugins/mods/overview (also `create`,
`interface`, `events`, `api`, `reference`, `troubleshoot`, `test` under the
same path).

- A mod is `.claude-plugin/plugin.json` + `hooks/hooks.json`
  (`{ "modules": ["./register.tsx"] }`) + the hooks module exporting
  `register(on, options)`. No build step, no Node APIs, relative imports
  only. Every hook is `($, e, next)`.
- **The type file is the authority and the API is early access.** Load the
  `plugin-authoring` skill at the start of any session that touches the mod:
  it writes this build's `claude-code.d.ts` and names its path, and ships
  worked examples (`pane.tsx`, `pane.test.tsx`, `pane-state.d.ts`,
  `band.tsx`, `tool-call.ts`). Once the mod has loaded, the same types are in
  `mod/.claude-plugin/types/`.
- Events the design relies on: `tool.call` (carries `agentId`,
  `tool_use_id`; `await next(e)` gives the result), `agent.spawn` (carries
  `parentAgentId`, `subagentType`, `description`, and for workflow agents
  `workflow: { runId, agentIndex }`), `turn.start` / `turn.complete`
  (carry `agentId`), `prompt.compose`, `ui.render`, `command.run`,
  `session.start`, `classic.SessionStart`.
- Tasks are tool calls (`TaskCreate`, `TaskUpdate`, `TodoWrite`). There is no
  workflow-run event, and `$.agent.list()` leaves workflow agents out.
- Drawing: a `Pane` docks beside the transcript in a fullscreen terminal, at
  most 45% of the columns, otherwise sits inline above the prompt. A pane
  opened unasked shows only at ≥144 columns (≥110 once the person has opened
  it); opened by a command it shows at any width. Keys reach a pane only
  while it has focus (Ctrl+X Tab, a click, or opened with `focus`).
- Limits: 10 s per hook; `$.state` lasts the session and survives a reload;
  `$.store` is 4 MiB across all sessions; `$.fs` handles ≤4 MiB per file; a
  tree draws ≤100,000 characters and ≤20,000 elements.
- The state contract (`mod/types/index.d.ts`) must be one self-contained
  `.d.ts` with no imports.

**Not verified — Task 1 is a probe that settles these before anything is
built on them:** whether subagent and workflow-agent tool calls reach a
mod's `tool.call` hook; how large a `$.state` value may be; where `$.fs` may
write; the exact shapes of `$.tool.register` and a `prompt.compose` section;
whether Claude actually calls the update tool when told to; hook order when
two `tool.call` hooks match. If workflow-agent calls are invisible, the
Agents and Timeline views lose detail for workflows and the plan changes.

## Developing and testing locally

- `claude --plugin-dir ./mod` loads the mod for that session and reloads it
  on every save. Add `--debug-file mod-debug.log` to see why a hook was
  skipped.
- `claude plugin validate ./mod` — static check, no session.
- `claude plugin test ./mod` — hook and drawing tests against the engine, no
  sign-in or network.
- `tsc -p mod` — type check. `npm test` — the pure model, with vitest.
- Always-on while developing: the absolute path of `mod/` in
  `CLAUDE_CODE_PLUGIN_DIRS` under `env` in `~/.claude/settings.json`.
- Publishing later needs one `.claude-plugin/marketplace.json`; out of scope.

## How to start

1. Read the design, then the plan. Look at the mocks.
2. Settle the three open questions with Aaron if he wants to; otherwise the
   defaults above stand.
3. Run the plan with subagent-driven development, **one subagent at a time**:
   Tasks 1–4 on Opus, 5–9 on Sonnet; Opus reviews after Task 4 and after
   Task 9, then one adversarial whole-branch pass. The plan stops after Task
   5 for Aaron to look at the real pane before the other views are built.
4. Task 1 creates `package.json`, CI and `mod/`, records probe fixtures and
   fills in the plan's Findings. If a finding contradicts a later task, stop
   and re-plan that task before going on.

## Ideas worth carrying over from the extension

Code is not reusable (React, a JSONL-shaped model, and a mod may import only
its own files), but these were validated there:

- **Granularity bundling** in the Activity view
  (`../claude-code-workflow-visualizer/src/webview/activity.ts`): show
  bundles first, expand on demand. The folded turns in the Timeline and the
  Overview follow it.
- **Repeat-failure and loop detection** (`src/webview/problems.ts`): group
  steps by a signature; ≥2 errors is a repeat failure, ≥3 repeats a loop. A
  candidate for the Overview's Latest section after v1.
- **The self-contained diff** (`src/webview/diff.ts`), if `Code
  format="diff"` proves too limited for the step detail.
- The agent-topology view is what the Agents tree stands in for.
