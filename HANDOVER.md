# Handover: Binnacle mod

A Claude Code mod that keeps tasks, agents, a step timeline and artifacts in
a pane and band beside the chat. The mod is built and lives in `mod/`. This
note says what it is, how it is put together and where to read more.

## What it is

The trigger: in the plain CLI, long file dumps bury the intermediate steps
and scrolling back to find them is slow. Binnacle draws a pane next to
the transcript and a band above the prompt, and keeps a record of the
session that can be reopened after it scrolls away. The transcript itself is
left alone.

It is a **Claude Code mod**: a plugin whose hooks module draws the pane and
the band. `README.md` is the user-facing description; this file is for the
next developer.

## The cockpit and the Critters

The current design is the cockpit (spec
`docs/superpowers/specs/2026-11-15-mission-control-cockpit-design.md`), with
the crew drawn as small pictures called Critters. The rulings that override
the specs where they differ are in
`docs/superpowers/plans/2026-11-16-cockpit-critters-rulings.md` (R1 to R43);
read them before changing words, colours or the alert rules.

- **Tabs:** Now, Tasks, Agents, Steps, Artifacts (keys `1` to `5`), plus an
  Options page (`0`, `/binnacle options`).
- **Now** is the header (a pill, the time this turn and any quiet time, the
  request's goal, the budget line and two gauges), then Needs you, Watch, To
  do, This turn, Agents, and Notes and decisions. It holds no step log.
- **Needs you** holds only what blocks the session on a dialog: a permission,
  a question, a plan to approve or an MCP input request. It has no dismiss
  key. **Watch** holds what is worth a glance and asks nothing: a stalled
  step, a quiet agent, a long run (limits 60 minutes for an agent and 120 for
  a turn), a repeat and a loop. `x` dismisses a Watch row.
- **Colour:** amber is for a dialog only; gauges go bold at 70 % and red at
  90 %; a failed turn is the STOPPED pill with its reason in red.
- **Alert model:** `mod/hooks/model/alerts.ts` is the one place that decides
  what needs the person (`needs`), what to watch (`watch`), the header's
  state (`headerState`) and which notifications to raise.
  Hooks get no signal that a permission was settled, so a permission is a
  need only while the pane sees the prompt covered; the clock clears an ask
  the pane watched uncovered for 20 s. With no pane, the band shows a
  permission amber for its first minute (20 s "Checking a permission" in auto
  mode), then dim "asked to run a command · running". Questions, plans and
  MCP input stay amber while they last. Permission notifications need the
  pane open; Claude Code notifies for its own dialogs either way.
- **Band:** one row above the prompt (the lead's or the asker's Critter, the
  goal, the context and week figures, `/mc`), a second row with the to-do bar
  when wide, one dim row when everything is done.
- **Surfaces:** the terminal draws Rasters (cell pictures) and text; the
  desktop app draws the Now header and the band as Svg
  (`mod/hooks/views/svg.ts`), from the same model as the terminal's header
  (`headWords`, `headline`, `nowGauges`, `budgetWords`), on the pane's ground
  (day on a light theme), with an alt that says the same words. VS Code and
  mobile take the text form.
- **Widths:** the pane draws the inline strip from 96 columns, the full tabs
  at 62 and the slim pane under 32. `/binnacle strip`
  moves the strip into the band.
- **Options:** `guide`, `autoOpen`, `look` (`auto`, `rich`, `text`),
  `ground` (`auto`, `night`, `day`), `motion` (`on`, `off`), `accent`
  (`iris`, `sky`, `slate`), `notify`, `watchNotify`, `showCost`, `editor`,
  `doneSound`, `agentLimitMin` (60) and `turnLimitMin` (120).
- **Commands:** `/binnacle`, `/binnacle 1` to `/binnacle 5`, `/binnacle keep <note>`, `/binnacle export`,
  `/binnacle close`, `/binnacle slim`, `/binnacle strip`, `/binnacle options`.

## Where things are

| What | Where |
|---|---|
| The mod | `mod/` (manifest `mod/.claude-plugin/plugin.json`, hooks `mod/hooks/`) |
| The pure session model | `mod/hooks/model/` (reducer, alerts, meter, todo, ledger, digest), tested by vitest from `test/` |
| The views | `mod/hooks/views/`: the shell and tabs, the band, the Svg forms, the Rasters and Critters (`raster.ts`), the parts the screens share (`parts.tsx`) |
| Capture and journal | `mod/hooks/capture.ts`, `mod/hooks/journal.ts` |
| The guide (the one system-prompt section and the update tool) | `mod/hooks/guide.tsx` |
| Design and plans | `docs/superpowers/specs/`, `docs/superpowers/plans/`, `docs/superpowers/TASKS.md` |
| Mocks | `docs/mocks/*.dc.html` and `canvas.json` |
| README images | `docs/readme/`, drawn from the real views by `node docs/readme/tools/make.mjs` (rerun after view changes) |
| Working rules | `CLAUDE.md`; local-only rules in `CLAUDE.local.md` (git-ignored) |

## What is known about the mods API

Checked against Claude Code 2.1.325's generated type file. The API is early
access, and the type file is the authority: load the `plugin-authoring` skill
at the start of any session that touches the mod. It writes this build's
`claude-code.d.ts`; once the mod has loaded, the same types are in
`mod/.claude-plugin/types/`.

- A mod is `.claude-plugin/plugin.json`, `hooks/hooks.json`
  (`{ "modules": ["./register.tsx"] }`) and the hooks module exporting
  `register(on, options)`. No build step, no Node APIs, relative imports
  only. Every hook is `($, e, next)`.
- Capture hooks only observe: they return what `next(e)` resolved to. The
  only things the mod adds to a conversation are the update tool and one
  system-prompt section.
- Drawing: a `Pane` docks beside the transcript in a fullscreen terminal, at
  most 45 % of the columns, otherwise sits inline above the prompt. A pane
  opened unasked shows only from 144 columns (110 once the person has opened
  it); opened by a command it shows at any width. Keys reach a pane only
  while it has focus.
- A render hook may not write `$.state` or read options, so view state that
  needs either lives in module variables set at register time or by a press.
- Limits: 10 s per hook; `$.state` lasts the session and survives a reload;
  `$.store` is 4 MiB across all sessions; `$.fs` handles up to 4 MiB per
  file; a tree draws at most 100,000 characters and 20,000 elements; an Svg
  `source` is at most 131,072 characters.
- Subagents never see the guide: Claude Code 2.1.325 does not raise the
  system-prompt event for subagent or workflow-agent prompts.
- The state contract (`mod/types/index.d.ts`) is one self-contained `.d.ts`
  with no imports.

## Developing and testing locally

- `claude --plugin-dir ./mod` loads the mod for that session and reloads it
  on every save. Add `--debug-file mod-debug.log` to see why a hook was
  skipped.
- `claude plugin validate ./mod`: static check, no session.
- `claude plugin test ./mod`: hook and drawing tests against the engine, no
  sign-in or network.
- `tsc -p mod`: type check. `npm test`: the pure model, with vitest.
- Always-on while developing: the absolute path of `mod/` in
  `CLAUDE_CODE_PLUGIN_DIRS` under `env` in `~/.claude/settings.json`.
- A local marketplace manifest exists for a live install with `/plugin`;
  publishing publicly is not done.

## Ideas from the VS Code extension

The extension in `../claude-code-workflow-visualizer` is left alone; its code
is not reusable (React, a JSONL-shaped model, and a mod may import only its
own files), but these ideas carried over:

- **Granularity bundling:** show bundles first, expand on demand (the folded
  turns in the Steps tab).
- **Repeat-failure and loop detection:** group steps by a signature; two
  errors are a repeat failure, three repeats a loop (the Watch rows).
- **The self-contained diff**, if `Code format="diff"` proves too limited for
  the step page.

## Open items

- Not built: restyling the transcript, model-written agent summaries, graph
  or waterfall views, cost analytics.
