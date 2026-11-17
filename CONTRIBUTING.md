# Contributing to Binnacle

Thanks for helping. Binnacle is a Claude Code mod: a plugin whose hooks
module draws a pane and a band beside the chat. The mods API is early
access, so expect it to move under us. Read `README.md` for what the mod
does and `HANDOVER.md` for how it is put together.

Be kind, assume good faith and keep discussion on the work. Everyone here
follows the [Code of Conduct](CODE_OF_CONDUCT.md). Report security problems
privately as described in [SECURITY.md](SECURITY.md), not in an issue.

## Before you start

- **Bugs:** open an issue with the bug form. Include your Claude Code
  version, the surface (terminal, desktop app, VS Code) and a screenshot of
  the pane or band if you can.
- **Features and anything that changes what the pane shows:** open a
  feature request first and wait for a yes before writing code. The look is
  governed by written rulings (see [Design decisions](#design-decisions)),
  and a pull request that contradicts one will be asked to change.
- **Small fixes** (typos, a failing test, a clear bug with a test) can go
  straight to a pull request.

## Setup

You need:

- **Node 22** (what CI uses; see `.nvmrc`).
- **Claude Code 2.1.325 or newer** for the mod checks and for running it.

```sh
git clone https://github.com/aaronjablonski/binnacle-claude-mod.git
cd binnacle-claude-mod
npm install
claude --plugin-dir ./mod        # run Claude Code with the mod; it reloads on save
```

Add `--debug-file mod-debug.log` to see why a hook was skipped (the log is
git-ignored). The first time the mod loads, Claude Code writes its type file
to `mod/.claude-plugin/types/` (git-ignored). That file is the authority on
the mods API, and `tsc -p mod` needs it.

## Checks a pull request must pass

| Check | Command | In CI |
|---|---|---|
| Model tests (vitest) | `npm test` | yes |
| Secret scan | gitleaks | yes |
| Type check | `npx tsc -p mod --noEmit` | no, needs the engine's type file |
| Manifest check | `claude plugin validate ./mod` | no, needs Claude Code |
| Hook and drawing tests | `claude plugin test ./mod` | no, needs Claude Code |

CI cannot run the last three because they need the Claude Code binary, so
run them locally and say in the pull request that you did. Some
`claude plugin test` tests (journal, export, deep search) fail on newer
Claude Code builds; if your change does not touch those, say which ones
failed before your change as well as after.

### Testing on a small machine

- `claude plugin test ./mod` starts one child process per test file (about
  50 files). Run it on its own, not alongside a build or a dev session.
- For vitest, run the files you touched first, then the suite with fewer
  workers: `npx vitest run test/alerts.test.ts`, then
  `npx vitest run --maxWorkers=2`.

## Code rules

- The mod has no build step and no Node APIs, and imports only its own files
  by relative path. Every hook is `($, e, next)`.
- **Capture hooks only observe:** they return what `next(e)` resolved to.
  The only things the mod adds to a conversation are the update tool and one
  system-prompt section (`mod/hooks/guide.tsx`). A change that adds more
  needs an issue and a ruling first.
- Session logic belongs in the pure model (`mod/hooks/model/`), tested with
  vitest from `test/`. Views (`mod/hooks/views/`) are tested with
  `claude plugin test`.
- Add or update a test with every behaviour change.

## Design decisions

Specs live in `docs/superpowers/specs/` and plans in
`docs/superpowers/plans/`. Binding decisions are numbered rulings in
`docs/superpowers/plans/2026-11-16-cockpit-critters-rulings.md` (R1 onward);
they override the specs where they differ. If your change alters words,
colours, alert rules or layout, add a ruling (a new number, or a dated
"Amendment" section at the end) in the same pull request, saying what
changed and why.

## README and pictures

Every picture in the README is drawn from the real views. When a change
alters what the pane or band shows, redraw them and update the text that
describes them:

```sh
node docs/readme/tools/make.mjs
```

It needs headless Chrome or Edge. Commit the changed PNGs with the change.

## Branches, commits and pull requests

- Branch from `main` with a prefix: `feat/`, `fix/`, `docs/`, `chore/`,
  `test/`.
- Commit subjects name the area, then say what is now true, in plain words:
  `Toast: cap the finish settle hold at the fold limit`,
  `README: critter sheet redrawn for the mini mascot`. Keep the subject
  under about 72 characters and use the body for the why.
- One logical change per commit; keep pull requests focused. Open a draft
  early if you want feedback.
- Fill in the pull request template, link the issue (`Fixes #12`) and add
  before and after screenshots for anything visible.
- Pull requests are merged with a merge commit once CI is green and a
  maintainer has approved.

## Licence

By contributing you agree that your contribution is licensed under the
[MIT licence](LICENSE).
