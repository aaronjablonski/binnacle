# Mission Control: distilled features plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Build all eight distilled features (Aaron: "I take all distillations", 2026-11-15) on the Neo views: Pace, Cache line, Task meter, Long run (with Roles), Done signal, Options card, Ledger, Quiet delights and Accent; plus the two unranked upgrades (Session cost, Roles).

**Spec:** superseded; the features were built in the Neo Rich and cockpit plans.

## Rulings

- **Ledger:** Aaron took all eight, which overrides the spec's "no cost analytics / cross-session compare" non-goal for this one feature. Scope stays as the distillation describes: our own rows in `$.store` (≤ 400), tokens by model per day, cost only with `showCost`, CSV only on a press.
- **Anti-goals otherwise unchanged:** nothing sends requests (Cache line reports, never warms), nothing changes Claude's behaviour, side effects only on press or command, hooks observe.
- **Sound:** off by default; `$.audio.play` only where supported (it plays nothing on Windows/Linux; say so in the option's description).
- **Starts after Neo** (N1–N5 reviewed), because every item draws in Neo's decks.

## Global Constraints

Everything in the HUD v2 and Neo plans' Global Constraints. Bounds: the worst-case Timeline test stays < 2,500,000 with the new fields (the margin is thin; lower caps where needed and say which). New `userConfig` options are documented in README.

## Tasks and waves

| Task | Scope | Model | Wave |
|---|---|---|---|
| D1 | Data: measure-sample ring (≤ 30), `usage` grows cache read/creation/input + output tokens + durationMs, per-task token/time attribution, `long-run` problem kind + options `agentLimitMin` (20) / `turnLimitMin` (60), done-turn detection + `notify` gains `done`, ledger rows in `$.store` (≤ 400) on `session.measure`/`session.end`, selectors `pace(t, now)`, `cacheLine(t)`, `taskMeter(t)`, `roles(t)`, `thisTurn(t)` | Opus | 1 |
| D2 | Budget view + Now: PACE, CACHE, WARM countdown readout, THIS WEEK ledger + CSV on a press, session cost (with `showCost`), Now `THIS TURN`: `budget.tsx`, `overview.tsx` | Sonnet | 2 |
| D3 | Tasks PLAN strip + task tokens/time, Agents ROLES section, Long run rows in NEEDS YOU, done notification + sound option: `tasks.tsx`, `agents.tsx`, `needs.tsx` | Sonnet | 2 |
| D4 | Options card: spike whether `$.config.set` reloads options; `,` opens Options (rows, toggles, choice values, the `┌ NEVER` section): new `options.tsx`, `shell.tsx` | Opus | 2 |
| D5 | Quiet delights + Accent: clean-run track sweep (once, never while NEEDS YOU has rows), round-number toasts, `accent` option mapping structural colour to a theme key: `style.ts`, `band.tsx`, and the track via a hook D4 leaves in `shell.tsx` | Sonnet | 3 |

Then one Opus review of D1–D5 and the final adversarial whole-branch pass.

Each task's tests follow the spec item's "Sees" and "Risks" lines (e.g. Pace shows nothing until a window moved 2 points over 5 minutes; Long run flags once and 0 switches it off; Done is quiet for turns < 60 s and interrupted turns; Options rows answer `{ deny }` gracefully; the sweep runs once per session).
