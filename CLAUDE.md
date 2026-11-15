# Mission Control (Claude Code mod)

A Claude Code mod that keeps tasks, agents, a step timeline and artifacts in
a pane and band beside the chat. Start with `HANDOVER.md`.

## Working rules

- Model roles follow the global rules: Opus plans, reviews and implements
  core logic; Sonnet implements well-specified UI; no Fable without explicit
  approval in the conversation. Set `model` on every dispatch.
- The mod lives in `mod/`. Load the `plugin-authoring` skill before touching
  it: it names this build's type file, which is the API authority.
- Capture hooks only observe: they return what `next(e)` resolved to. The
  only things the mod adds to a conversation are the update tool and one
  system-prompt section (`mod/hooks/guide.tsx`).

## Commands

- Run with the mod: `claude --plugin-dir ./mod` (hot-reloads on save)
- Static check: `claude plugin validate ./mod`
- Hook and drawing tests: `claude plugin test ./mod`
- Type check: `tsc -p mod`
- Model tests: `npm test`
