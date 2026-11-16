# Mission Control

A Claude Code mod that keeps a persistent, navigable record of the session
beside the chat. The transcript itself stays as it is. It needs Claude Code
2.1.325 or newer.

## What it shows

A pane next to the transcript with five tabs, and a band above the prompt.
The pane draws on a character grid: the tab bar, the readouts and the table
columns line up from column 2, with a metric at column 38 and a time at
column 50 when the pane is 62 columns wide. Crew members are small pictures
(Critters) drawn from the same cells; the `look` option can turn them off.

| Tab | Shows |
| --- | --- |
| Now | The header first: a pill (WORKING, WAITING FOR YOU, STOPPED, ALL DONE or IDLE) with the time this turn and any quiet time, the request's goal, the context figure and two gauges. Under it Needs you (a dialog is waiting on you) and Watch (worth a glance, asks nothing), then To do, This turn once the request has ended, Agents, and Notes and decisions. Now holds no log of steps. |
| Tasks | How many tasks are done, the pace, Effort so far, then Doing now (with its agents), Up next and Done, and Earlier for the lists of earlier requests. |
| Agents | Main and every subagent or workflow agent, as a list of cards or as a map, with tokens and time, the failures with their reasons, and the workflow runs. |
| Steps | Every step of the session, filterable (All, Kept, Errors, In view) and searchable. A step opens in place; a second press opens its page with the input, result and any code change. |
| Artifacts | Pages Claude published, documents it wrote, results it reported and links, newest first, with the newest opened. Then Files changed, Kept, and Handoff with the export button. |

**Needs you** lists only what blocks the session on a dialog: a permission, a
question, a plan to approve or an MCP input request. It has no dismiss key; it
clears when the dialog is answered. **Watch** lists a step that has run much
longer than usual, an agent that has gone quiet, a long run, a repeated
failure and a loop. Watch is never amber and never takes the keyboard; `x`
dismisses a row.

Amber is used for a dialog and nothing else. The gauges turn bold at 70 % and
red at 90 %. A turn that failed ends in the STOPPED pill with its reason in
red; a request that ends with tasks open reads IDLE, not ALL DONE.

The band is one row above the prompt: a small picture of the lead (or of the
agent that is asking), the request's goal, the context and week figures, and
`/mc` at the right edge. While a dialog is up it leads with "Needs you" and
the ask in amber; after a failed turn it leads with "Stopped". A second row
holds the to-do bar and its words when the band is wide enough. When every
task is done it is one dim row. A narrow band drops the gauges first and only
then cuts the goal at a word.

On the desktop app the Now header and the band are drawn as Svg pictures in
the pane's words and colours (day or night to match the theme), with the same
text as their alt. Elsewhere they draw as character cells.

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
| `/mc options` | Opens the Options page. |

## Keys

- Ctrl+X Tab focuses the pane. The default chord can be remapped with the
  `abovePrompt:focus` action in `~/.claude/keybindings.json`.
- With the pane focused: Tab moves between rows, Enter opens a row, Esc
  returns to the prompt, and Ctrl+X X closes the pane.
- Hotkeys, while the pane is focused. A key acts on the thing in view: the
  opened step, agent or artifact, or the row a footer hint names. The footer
  shows only the hints that apply, and only while the pane is focused.

| Key | Does |
| --- | --- |
| `0` | Open the Options page. |
| `1` to `5` | Switch tabs. |
| `↵` | Open the row; again for the full page. |
| `b` | Back from a page or from the budget view; on Now, open the budget view. |
| `n` / `p` | Next or previous ask, flagged agent, error or search hit. |
| `f` | Find in the steps. |
| `g` | Show the opened step, agent or artifact in the chat. |
| `k` | Keep the opened step (or unkeep it). |
| `c` | Copy the opened step as Markdown, an artifact's link, or a file's path. |
| `q` | Quote the full step into the prompt. |
| `l` / `t` | Agents: list, map. |
| `r` | Agents: working only. |
| `d` | Tasks: all done tasks. Agents: unfold or fold the finished ones. |
| `v` | An agent's transcript, from a Watch row or a failed agent. |
| `o` | An opened artifact: the step that wrote it. An opened file or step: open it in the editor. |
| `e` | Export the digest (Artifacts, and Now at rest). In the budget view: export the ledger as CSV. |
| `x` | Dismiss the first Watch row. In the Options page: set an option off. |

- On Artifacts the keys `o`, `c` and `g` belong to the one opened artifact or,
  once a file is selected, to that file; never to both at once.
- Hotkeys work in the terminal and the desktop app, not in VS Code. Every
  button has a label that works without its key.

## Keep

Keep marks a step you do not want to lose. Press `k` on an opened step, or
run `/mc keep <note>` for the newest step of the main conversation. The step
shows a `★`, appears under the Kept chip on the Steps tab, in Kept on
Artifacts and in Notes and decisions on Now, is never trimmed from the
timeline, and goes into the export with its stored input and result (up to
20,000 characters each). Press `k` again to unkeep it.

## Slim mode

Under 32 columns the pane is slim: no tab bar, one stacked summary. From top
to bottom it shows the compact header, Needs you, To do, Agents, Budget and
Notes. Each title opens that tab's list; `/mc 1` to `/mc 5` still work.
When rows run short, whole parts go from the bottom: Needs you is kept
longest, then To do. `/mc slim` asks for a 28-column pane and, run again,
restores 62. A pane you resize yourself keeps the width you give it, and the
layout follows it. On the desktop app the widget placement is always slim.

## Strip mode

From 96 columns the pane draws Now as a strip: the header at its full 62
columns on the left, To do and Agents on the right.

`/mc strip` closes the pane and draws the same strip in the band above the
prompt instead, with the band's compact line under it. The band may take at
most half the terminal's height, the prompt's rows included; in a short
terminal the lists are cut first, then the deck from the bottom, and the
compact line always stays. Text is cut only at a word, with `…`.

Each strip row opens what it names, as it does in the pane: pressing it (a
click, or Ctrl+X Tab to focus the band and then Enter) turns the strip off and
opens the pane there. The strip has no hotkeys, because a bare digit typed in
an empty prompt can press a band button.

`/mc`, `/mc 1` to `/mc 5`, `/mc slim` and `/mc options` open the pane and so
turn the strip off. `/mc strip` and `/mc slim` do not fight: whichever ran
last wins, and `/mc slim` run from the strip always gives the slim pane.
`/mc close` leaves the strip as it is. A `/clear` turns it off.

## Options

Set under `pluginConfigs["mission-control"].options` in a settings file, or
from the config menu:

| Option | Default | What it does |
| --- | --- | --- |
| `guide` | `true` | Give Claude the update tool and one system-prompt section so it keeps the panel current. |
| `autoOpen` | `false` | Open the pane when a session starts. In a narrow terminal the pane waits for more room. |
| `look` | `auto` | How the pane and band are drawn: `auto` (rich, except text on an ANSI or daltonized theme or where the terminal cannot draw pictures), `rich` (pictures where the terminal can draw them) or `text` (letters and box lines only). Choose `text` if the terminal draws the pictures badly, or for a screen reader. Applies at once; the Options page (`0`) switches it too. |
| `ground` | `auto` | The background the crew pictures and the desktop Svg are drawn for: `auto` (day on a light theme, night on the rest), `night` or `day`. |
| `motion` | `on` | Let the crew blink now and then and play the short sweep when a request finishes cleanly, or keep everything still (`off`). |
| `accent` | `iris` | The colour of headings, the marker and the filled button: `iris` (violet-blue), `sky` (light blue) or `slate` (grey-blue). |
| `notify` | `waits` | Native notifications: `waits`, `done` (also when a turn over 60 seconds finishes), `all` (also when a turn fails) or `off`. With `notify: waits` the mod notifies when Claude has waited on you: after a minute for a question, a plan or an input request; after 20 seconds for an ask to start an agent or workflow; and after a minute for any other permission, but only while the Mission Control pane is open and sees its dialog (in auto mode, only once the dialog is on screen). Claude Code notifies for its own dialogs either way. |
| `watchNotify` | `false` | Also notify, once, when something has stood under Watch for 10 minutes. Off by default: Watch asks nothing of you. |
| `showCost` | `false` | Show the session's dollar cost in the budget view. |
| `editor` | `code` | The editor `o` opens a file in, run as `<editor> -r -g <path>:<line>`. When it cannot run, the path is copied. |
| `doneSound` | `false` | Also play a short sound when the done notification is raised (macOS only). |
| `agentLimitMin` | `60` | Show a subagent still working after this many minutes, once, as a long run under Watch. It only reports. `0` turns it off. |
| `turnLimitMin` | `120` | Show a main turn still running after this many minutes, once, as a long run under Watch. `0` turns it off. |

The Options page (`0`, or `/mc options`) changes the look options at once and
shows a preview of the crew.

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
