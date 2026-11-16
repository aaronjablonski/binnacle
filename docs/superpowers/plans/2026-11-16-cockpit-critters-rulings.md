# Cockpit + Critters: rulings sheet (binding for every task)

Source: the independent DX review, round 1 (`.superpowers/sdd/2026-11-16-cockpit-critters/fable-round1.md`; read the section a ruling cites when you need detail). The controller made these rulings on 2026-11-16 while the owner was away. Each one overrides the specs where they differ. Where a ruling changes what a mock shows, the change is listed under "Mock deviations" at the end, so the owner can reverse it.

## Alerts (C2 data, C3/C6 views)

R1. **Needs you = the session is blocked on a dialog.** Permission, question (`AskUserQuestion`), plan approval (`ExitPlanMode`) and MCP input (elicitation), each with its own sentence: "Builder asks to run a command", "Claude asks you a question", "Claude has a plan for you to approve", "<server> asks for input". Verify against the type file which of these raise `classic.PermissionRequest` or another event, and wire each one that can be observed. Report any that can't.
R2. **The green tick is never a lie.** When the pane and band props say `isPromptCovered`, an ask shows at once. The 20 s `ASK_MS` delay stays only while the permission mode is `auto` and the prompt is not covered. In that gap draw neither line: no tick, and a dim "Checking a permission".
R3. **`↵ go to prompt` only while the pane holds the keyboard** (`isFocused`). Otherwise draw plain words: "answer in the prompt ↓". If the type file has no call that hands focus back to the prompt, the control is the words "esc: back to the prompt" and nothing pretends to be a button. Test it.
R4. **Two running steps with the same tool and input signature:** don't name the asker in bold; say "An agent asks…".
R5. **"Paused" only when the asker is the lead or nothing else is running.** Otherwise the current task keeps `now`.
R6. **Stuck detection.**
- *Stalled*: one step has run longer than 5 min and longer than 3 × the median for that tool in this session. "Builder: `npm test` has run 14 min".
- *Quiet*: no step running and none started for 10 min, for the lead or a subagent. "Explorer: no activity for 10 min, may be thinking".
- *Long run*: past the limit (60 agent / 120 turn; 0 disables). "Explorer has run 64 min (limit 60), usually 4 min" when the median exists.
- All three are Watch rows. `limits.ts` loses its `near` amber, and the long runner's time on its card goes bold.
R7. **Quiet in the header.** After 2 min with no activity, the header reads "41 min this turn · quiet 6 min". Dim, bold past 5 min. Not a log line.
R8. **A failed turn is not Watch.** The header takes it: pill `STOPPED`, kicker "Stopped by an error", the reason in red. `notify: all` keeps notifying for it.
R9. **Amber is the dialog colour only.** Gauges go bold ink at 70 % and red at 90 %.
R10. **New option `watchNotify`** (off by default): notify once when a Watch row has stood for 10 min.

## To-do block (C2 data, C3/C5 views)

R11. **The header count is the lead's list only.** A subagent's own list shows on its card ("3 of 5").
R12. **A list belongs to one request.**
- When a new prompt starts and every task is complete, the old list folds away (Tasks tab: "Earlier").
- No list: the To do head, then one dim row, "No to-do list for this request".
- Turn ended with tasks open: no `ALL DONE`. The pill reads `IDLE`, the kicker "Stopped with 3 to do open", and the bar shows the open part.
R13. **More tasks than bar cells:** the bar is proportional (done, current, open runs), never one segment per task past the width.
R14. **The headline is the request's goal, set once a request.** The current step comes from the list. One done row above the current task, not two.

## Guide and the `tasks` field (C2)

R15. **Wording:** adopt variants A (TaskCreate/TaskUpdate), B (TodoWrite) and C (neither, `tasks` field) and the new tool description, verbatim from round 1 §4 "Exact wording". Each variant is a fixed string, picked from `e.tools`. A deferred task tool counts as not offered.
    Amended 2026-11-16: one fixed text, see review-C1C2 I-1.
R16. **`tasks` shape:** the whole list each time, `[{ title ≤ 60, state: todo|doing|done }]`, ≤ 12 items. It replaces only the caller's own list (`ev.agent`). If that owner uses the task tools, they win and `tasks` is ignored. Never merge.
R17. **Subagents:** if `prompt.compose` can tell a subagent's request from the lead's, subagents get no section. Their cards come from `doing(step)`. If it can't, keep one section for all and report it.
R18. **Check it:** one real haiku headless run with a 4-step prompt and a 1-step prompt. Report whether a list appeared before the second tool call, and whether any appeared on the 1-step prompt.

## Crew art (C1, used everywhere)

R19. Waiting: role-hue body, amber lamp and `?` badge. Stalled: `z` badge in mute on rule grey (no amber). Done: grey body, lamp off (no mint). Failed: red `!` badge and red lamp. No other amber, mint or red inside a sprite.
R20. Palette gains teal and orchid as "Raster only, crew art", with night and day hex from `gen-crew.js`. The state mixes (62 %, 42 %, 50 % towards the ground) are named constants in `raster.ts`. Ember means "the lead"; the kept `★` is iris.
R21. **The ground comes from the theme** (the `theme` row of `$.config.list()`: light themes give day, the rest night). `ground: auto|night|day` is an option, auto by default. On ANSI or daltonized themes, use the text look by default.
R22. **Text form of a critter:** one state glyph in the state colour, then the role word, at the same cell size as the sprite. A gauge is the percentage and the word. Bars are `━` runs in `Text`, which need no Raster on any surface.
R23. **Role word never lies.** The name column shows the agent's real type in friendly case ("General", "Explorer", "Code reviewer"); the hat is only a hint. Unknown types draw the builder hat.
R24. **Blink:** one frame about every 4 s, agents staggered. Never in the band, never at idle. New option `motion` (on/off) covers the blink and the sweep.
R25. **Card geometry:** sprite at columns 2–6, badge at 7 (always reserved), name at 9. Cockpit card everywhere: crew deck layouts 1, 2, 4 and 5 are not built. The band shows one critter: the lead, or the asker while an ask is up.
R26. **Map:** cockpit words and order ("Doing now", "Up next", "Done"); dim sentence-case column heads; "working", never "live". Columns end at 59 (time) and 49 (tokens), with state before them. `?` and `!` are allowed in column 0 on the map only. Pips keep role hues on the map only. Queued critters are drawn only under "Up next". Failed agents get a micro critter with a red `!` in the list and on the map.

## Words and formats (all views)

R27. **Durations:** `45s`; `2m 14s` only under 10 min, on Steps; `12 min`; `1 h 12 min`; `m:ss` only for a countdown. Seconds show on agent cards only in the first minute.
R28. **Hotkeys:** one notation everywhere, `v transcript`, with the key in iris and no colon. The comma key is drawn as a key.
R29. **Cache:** the countdown shows at idle only: "cache stays warm 4:48".
R30. **Words:** "The digest will contain" (not "It will hold"); "saved to this session and copied" (not "journal"); "1 working · 1 waiting" in slim; "waiting 40s" once, in the block.
R31. **Short tool names** (owner: short, then drop below 40):
- `Edit Read Write Bash Grep Glob Web Fetch Agent Skill Todo Task+` (TaskCreate), `Task✓` (TaskUpdate), `Back` (Handoff/background), `Cell` (NotebookEdit).
- An MCP tool takes the last part of `mcp__server__tool`, cut at a word.
- Never an empty cell in a column other rows fill.

## Surfaces

R32. **Desktop Svg** is restyled in C6 (cockpit palette, small Critters, no animation). Presses stay as Buttons beside it. The desktop `widget` placement gets the slim view.
R33. **Filled button:** `Button variant="primary"` (terminal `[ label ]` in the accent, native on desktop). It must stay pressable.
R34. **Inline strip** (unmocked; it is the default below 110 columns): Now's header on the left, To do and Agents on the right, built from the same cockpit parts and following the same column rules. C3 includes its rendered text in the report. Slim height rule: Needs you, then To do (current + next), then the rest, in that order.
R35. **Accent choices:** iris (default), sky, slate. None of them is a state or role hue.

## Delights (C7)

R36. Clean-run sweep: once per finished request, under 1 s, never in the band, never while Needs you has rows, off with `motion: off`. Round-number toasts only when the number means something (all to-dos done, context at 80 %). Agent-finished toasts fold into one ("5 agents finished").

## Mock deviations (for the owner to check)

R7 quiet, R8 STOPPED header, R9 gauges bold or red instead of amber, R12 empty and ended states, R14 one done row, R27 to R30 word and format changes, R29 no cache countdown while working.

## Amendments after the screens review (review-C3C6, 2026-11-16)

- R28 amended (merges review-C3C6 I-1/I-2 with Fable round 2 I8):
  - The footer is plain Text hints in the mock's notation (key bold in the accent, no colon), with exactly the mock's hints for each screen.
  - Each key is armed on the visible body Button that already shows it (`f: Find a step`, `d: show all`, `e: Export digest`); those labels keep the engine's colon, as the mocks do.
  - Keys with no body Button (`n`, `p`, `0`) are armed by one hidden Button each, in one place in `shell.tsx`. This is flagged for the owner's live check.
  - `0 options` is drawn only where the mock draws it (Now).
- R39: Needs you ends in an amber filled chip that is plain Text, ` esc  back to the prompt ` when focused and ` answer in the prompt ↓ ` when not. The Artifacts button reads `e: Export digest` (Fable round 2 I9).
- R40: the idle budget line is "644k of 1M used · cache warm 2 min", in whole minutes. This is a mock deviation (the mock ticks m:ss); the band uses the same words.
- R41: "Stalled" needs earlier runs of the same signature (3 × their median, floor 5 min). With no history the row is "Long step", which never notifies.
- R42: tabs show full names from 54 columns, whole short words below that (`Now Tasks Crew Steps Files`), and icons only under 38.
- R43: only `main` is the lead (wears the crown). The text form drops the role word where the name stands beside it.
- R37: lists grow with the pane height (`scroll.bodyRows`) on Tasks, Steps and Artifacts. This is the owner's earlier binding rule 2, and it overrides the mocks' `+ n more` at 46 rows. Now keeps its height rule.
- R38: the Options page takes the cockpit look like the other pages.
