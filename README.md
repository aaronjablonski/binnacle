# Mission Control

A Claude Code mod that keeps a persistent, navigable record of the session
beside the chat. The transcript itself stays as it is. It needs Claude Code
2.1.325 or newer.

## What it shows

A pane next to the transcript with five tabs, and a one-line band above the
prompt. The pane draws on a character grid: the tab bar, the readouts and the
table columns line up from column 2, with a metric at column 38 and a time at
column 50 when the pane is 62 columns wide.

| Tab | Shows |
| --- | --- |
| Now | What Claude is on and what is next. NEEDS YOU first when anything waits on you, then readouts (tasks, agents, steps, context, the 5-hour or 7-day limit), the live agents, the latest step and newest error, kept steps and notes. |
| Tasks | Readouts for done, active, queued and elapsed on one scale. ACTIVE (one task, which opens to the agents working on it), QUEUED (up to 5) and DONE (the newest 3). |
| Agents | Main and every subagent or workflow agent, as a list or a tree, with tokens and time, and the workflow runs. |
| Steps | Every step of the session, filterable and searchable. A step opens in place; a second press opens the full step with its input, result and any code change. |
| Artifacts | Pages Claude published, documents it wrote, results it reported and links, newest first, with the newest opened. Then FILES CHANGED and HANDOFF. |

The band shows `▍ done/total`, the focus, the live agents, the errors, the
context and the 5-hour or 7-day limit, with `/mc` at the right edge. When
something waits on you, `▲ n need you` leads it. When every task is done it is
one dim row. A narrow band drops the budget first, then the words `live` and
`error`, then `/mc`, and only then cuts the focus at a word.

## Commands

All of these work in the middle of a turn. These are the only commands.

| Command | Does |
| --- | --- |
| `/mc` | Opens the pane. |
| `/mc 1` to `/mc 5` | Opens the pane on that tab: 1 Now, 2 Tasks, 3 Agents, 4 Steps, 5 Artifacts. |
| `/mc keep <note>` | Keeps the newest step of the main conversation, with the note. |
| `/mc export` | Writes the digest to the journal and copies it. |
| `/mc close` | Closes the pane. |
| `/mc slim` | Switches between the slim pane (28 columns) and the full one (62). |
| `/mc strip` | Closes the pane and draws the strip in the band above the prompt; run again, it restores the band and reopens the pane. |

## Keys

- Ctrl+X Tab focuses the pane. The default chord can be remapped with the
  `abovePrompt:focus` action in `~/.claude/keybindings.json`.
- With the pane focused: Tab moves between rows, Enter opens a row, Esc
  returns to the prompt, and Ctrl+X X closes the pane.
- Hotkeys, while the pane is focused:

| Key | Does |
| --- | --- |
| `1` to `5` | Switch tabs. |
| `n` / `p` | Next or previous error, search hit or problem. |
| `f` | Find in the steps. |
| `g` | Show the opened step, agent or artifact in the chat. |
| `k` | Keep the opened step (or unkeep it). |
| `c` | Copy the opened step as Markdown, or copy an artifact's link. |
| `q` | Quote the full step. |
| `l` / `t` / `r` | Agents: list, tree, running only. |
| `s` / `v` | An opened agent's steps, or its transcript. |
| `d` | Tasks: all done tasks. |
| `e` | Export the digest. |
| `o` | An opened artifact: open the step that wrote it. |
| `x` | Dismiss a NEEDS YOU item. |

- The footer shows at most 3 hints and only while the pane is focused.
- Hotkeys work in the terminal and the desktop app, not in VS Code. Every
  button has a label that works without its key.

## Keep

Keep marks a step you do not want to lose. Press `k` on an opened step, or
run `/mc keep <note>` for the newest step of the main conversation. The step
shows a `★`, appears under the Kept filter on the Steps tab and in KEPT on
Now, is never trimmed from the timeline, and goes into the export with its stored
input and result (up to 20,000 characters each). Press `k` again to unkeep
it.

## Slim mode

Under 32 columns the pane is slim: no tab bar, one stacked summary. From top
to bottom it shows the focus, NEEDS YOU, tasks, agents, budget and the latest
step and kept step. Each label opens that tab's list; `/mc 1` to `/mc 5` still
work. `/mc slim` asks for a 28-column pane and, run again, restores 62. A pane
you resize yourself keeps the width you give it, and the layout follows it.

## Strip mode

`/mc strip` closes the pane and draws the strip in the band above the prompt
instead: the Now deck (focus, next, crew, tasks, steps, budget) beside AGENTS
and LATEST, with the band's one-row summary under it. From 96 columns the two
halves sit side by side in 7 rows; narrower, they stack in 14. The band may
take at most half the terminal's height, the prompt's rows included, so in a
short terminal AGENTS and LATEST are cut first, then the deck from the
bottom; the summary row always stays.

Each strip row opens what it names, as it does in the pane: pressing it (a
click, or Ctrl+X Tab to focus the band and then Enter) turns the strip off and
opens the pane there. The strip has no hotkeys, because a bare digit typed in
an empty prompt can press a band button.

`/mc`, `/mc 1` to `/mc 5` and `/mc slim` open the pane and so turn the strip
off. `/mc strip` and `/mc slim` do not fight: whichever ran last wins, and
`/mc slim` run from the strip always gives the slim pane. `/mc close` leaves
the strip as it is. A `/clear` turns it off.

## Options

Set under `pluginConfigs["mission-control"].options` in a settings file, or
from the config menu:

| Option | Default | What it does |
| --- | --- | --- |
| `guide` | `true` | Give Claude the update tool and one system-prompt section so it keeps the panel current. |
| `autoOpen` | `false` | Open the pane when a session starts. In a narrow terminal the pane waits for more room. |
| `notify` | `waits` | Raise a native notification when Claude has waited on you for 20 seconds (`waits`), also when a turn fails (`all`), or never (`off`). |
| `showCost` | `false` | Show the session's dollar cost in the budget view. |

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
