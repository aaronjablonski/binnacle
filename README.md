# Mission Control

A Claude Code mod that keeps a persistent, navigable record of the session
beside the chat: the task list, the running subagents and workflow agents
with what each is doing now, a timeline of steps you can reopen, and the
files, pages and links the session produced. It shows in a pane next to the
transcript and a one-line band above the prompt; the transcript itself stays
as it is. Type `/mc` to open it.

Status: early work in progress. It needs Claude Code 2.1.325 or newer.

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
- Use it everywhere while developing: add the absolute path of `mod/` to
  `CLAUDE_CODE_PLUGIN_DIRS` under `env` in `~/.claude/settings.json`.

## Options

Set under `pluginConfigs["mission-control"].options` in a settings file, or
from the config menu:

| Option | Default | What it does |
| --- | --- | --- |
| `autoOpen` | `false` | Open the pane when a session starts. |
| `guide` | `true` | Give Claude the update tool and one system-prompt section so it keeps the panel current. |

For a one-off headless run, pass them with `--settings`:

```sh
claude -p "..." --plugin-dir ./mod --settings '{"pluginConfigs":{"mission-control":{"options":{"guide":false}}}}'
```
