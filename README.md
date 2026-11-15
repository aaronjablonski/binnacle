# Mission Control

A Claude Code mod that keeps a persistent, navigable record of the session
beside the chat. The transcript itself stays as it is. It needs Claude Code
2.1.325 or newer.

## What it shows

A pane next to the transcript, with five tabs, and a one-line band above the
prompt.

| Tab | Shows |
| --- | --- |
| Overview | What Claude is on now and what is next, tasks, running agents, the latest steps, notes and artifacts. |
| Tasks | The task list, with the agents working on each task. |
| Agents | Main and every subagent or workflow agent, as a list or a tree, with what each is doing now. |
| Timeline | Every step of the session, filterable. Open a step to see its input, result and any code change. Pin a step to keep it. |
| Artifacts | Pages Claude published, documents it wrote, results it reported and links, newest first. |

## Commands

All of these work in the middle of a turn.

| Command | Does |
| --- | --- |
| `/mc` | Opens the pane. |
| `/mc close` | Closes it. |
| `/mc pin [note]` | Pins the newest step, with an optional note. |
| `/mc 1` to `/mc 5` | Switches to that tab. |
| `/mc overview`, `tasks`, `agents`, `timeline`, `artifacts` | Switches to that tab by name. A 3-letter prefix also works (`/mc art`). |

## Keys

- Ctrl+X Tab focuses the pane. The default chord can be remapped with the
  `abovePrompt:focus` action in `~/.claude/keybindings.json`.
- With the pane focused: 1 to 5 switch tabs, Tab moves between rows, Enter
  opens a row, Esc returns to the prompt, and Ctrl+X X closes the pane.
- Hotkeys work in the terminal and the desktop app, not in VS Code. Every
  button has a label that works without its key.

## Options

Set under `pluginConfigs["mission-control"].options` in a settings file, or
from the config menu:

| Option | Default | What it does |
| --- | --- | --- |
| `guide` | `true` | Give Claude the update tool and one system-prompt section so it keeps the panel current. |
| `autoOpen` | `false` | Open the pane when a session starts. In a narrow terminal the pane waits for more room. |

For a one-off headless run, pass them with `--settings`:

```sh
claude -p "..." --plugin-dir ./mod --settings '{"pluginConfigs":{"mission-control":{"options":{"guide":false}}}}'
```

## What the guide adds to the system prompt

With `guide` on, the mod registers one tool, `mcp__mission-control__update`,
and adds this section to the main conversation's system prompt:

```text
# Mission Control
The person follows this session in a side panel called Mission Control. Keep it current:
- Keep the task list up to date with the task tools as work starts and finishes.
- When a request needs tools, include a mcp__mission-control__update call with `focus` (and `next` when you know it) alongside your first tool call(s), and again whenever what you are working on changes; skip it for replies that need no tools. One short line each.
- Add `note` when you learn something the person would want to find again later: a decision, a root cause, a surprising fact. One line.
- Add `artifact` when you produce a result or a link worth keeping (review findings, a report, a pull request).
Batch these into one call, at most once per step, and never call it only to say nothing changed. Do not mention the panel or these updates in your replies.
```

That is all the mod adds to a conversation. Everything else only observes.

Limit: subagents never see this section. Claude Code 2.1.325 does not raise
the system-prompt event for subagent or workflow-agent prompts, so a
subagent's "doing" line comes from its steps, not from notes it writes.

## Where the journal lives

Step bodies and a copy of the timeline are written to
`<home>/.claude/mission-control/<session-id>/`. The folder holds
`timeline.json`, a `steps/` folder and maybe `journal.json`. The newest 20
sessions are kept; older ones are pruned, and a folder less than 24 hours old
is never pruned. To delete the journal, remove the folder.

## Always-on use

Put the absolute path of `mod/` in `CLAUDE_CODE_PLUGIN_DIRS` under `env` in
`~/.claude/settings.json`, for example:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/mission-control-claude-mod/mod" } }
```

## Developing and testing locally

- Run: `claude --plugin-dir ./mod` in the repo. The folder is watched; saving
  a file reloads the mod (state kept). `claude --debug-file mod-debug.log
  --plugin-dir ./mod` for the reasons a hook was skipped.
- Static check: `claude plugin validate ./mod`.
- Type check: `tsc -p mod` (the engine lays the types in
  `mod/.claude-plugin/types/` on first load; that folder is git-ignored).
  Run it as `npx tsc -p mod` or `npm run typecheck`. A headless
  `claude -p ... --plugin-dir ./mod` run lays the types only with
  `CLAUDE_CODE_PLUGIN_DIR_WATCH=1` set.
- Hook and drawing tests: `claude plugin test ./mod` runs `mod/**/*.test.ts`
  and `mod/**/*.test.tsx` against the engine with no session, sign-in or
  network.
- Model tests: `npm test` (vitest, `test/`), which CI runs.
