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
- R42 amended (re-check, 2026-11-16): five short words need 43 columns, so icons show under 43, not under 38. Mock deviation for the owner.
- R37 clarified: growth fills every free row at every height, including the mocks' 46 rows; "+ n more" only when the list is longer than the rows left.
- Pace estimate rounds to the nearest minute (nearest 5 min past 10 min), never down; where the mock's words differ, real data wins.
- R2 amended (final fix wave, 2026-11-16): hooks get no signal that a permission was settled (a `classic.PermissionRequest` hook's `next(e)` resolves before the dialog opens). (a) While the pane watches, an auto-mode permission is "Checking a permission" until the prompt is covered, then a need at once; the clock clears any ask the pane watched uncovered for 20 s (a waiting dialog always covers the prompt). (b) With no pane, a permission is amber in the band for its first minute (auto mode: "Checking a permission" for 20 s), then dim "asked to run a command · running", never amber again. Questions, plans, MCP input and asks to start an agent or workflow stay amber while they last. Permission notifications need the pane open; Claude Code notifies for its own dialogs. Mock deviation for the owner.

## Amendment 2026-11-16: Mini mascot critters (owner pick)

The owner picked the "Mini mascot" direction from the critter redesign mocks. It replaces family A at both sizes.

- R19 amended: the face shows the state in place of the lamp (queued and working open eyes, waiting looks aside, stalled and done shut, failed sad; the second working frame is the blink face). A sprite has no lamp. Red stays only in the `!` badge, and amber only in the `?` badge.
- R20 amended: the crew palette gains `sky` (night 0x6fb6f2, day 0x2f8fd8), "Raster only, crew art", for the new general role. Queued mixes 60 % toward the ground. Stalled and failed mix 55 % toward `mute`, not toward the ground. Done is `mix(mute, hue, 0.12)`. Roles: lead ember with a crown, builder iris with a hard hat, explorer (`scout`) teal with an antenna and a raised arm, reviewer (`check`) orchid with glasses, general sky and plain.
- R23 changed: general-purpose and unknown agent types draw the plain general mascot, not the builder hat. A type whose name says it builds (build, implement, develop, engineer) and a planning agent still draw the hard hat; the lead stays `main` only (R43).
- The stalled `z` badge is `dim` on `rule` (it was `mute` on `rule`).
- R22 is unchanged: the text form is as before, with the role word `agent` for the new role (`general` is 7 letters and does not fit the 5-column micro box).

## Amendment 2026-11-16: Motion 1–10 (owner pick, 2026-11-16)

The owner approved motion sketches 1 to 10. Sketches 11 (a warm light at rest) and 12 (a look around at rest) were declined and are not built.

- R24 holds: the blink stays the only loop; the band's critter never moves; nothing loops at idle, and the only moves at rest are the gauge fill on opening and the finish sweep. Every move below plays once and ends, as a bounded chain of `$.clock.after` (no second standing clock), so the 1 s clock still stops when nothing is live.
- New one-shot moves, body and eyes only, drawn on the mascot's own rows (each pose keeps two colours to a cell; the crown, the hard hat, the antenna and the glasses stay drawn):
  - 1: a to-do lands: the done segment flashes, settles, and the next lights in two steps (3 × 160 ms, blits). In the band the new count is in the accent for one 1 s beat (one redraw ends it).
  - 2: an agent starts: squash, then hop (2 × 120 ms). The same move wakes the lead on a new prompt after rest.
  - 3: an agent finishes: a nod with eyes shut and a fade to grey in two steps (2 × 150 ms), a 700 ms rest, then one redraw folds the card. The agent-finished toast waits until its newest finish is 1.5 s old, so finishes that land together fold into one toast.
  - 4: Needs you arrives: the block at half strength (dim amber), full amber one frame later (one redraw at 140 ms); the asker glances toward its badge and hops once (2 × 140 ms), then holds still.
  - 5: a step lands: the new Steps row carries an accent `▍` for one beat (it rides the 1 s redraw); its activity-map column grows in (2 × 120 ms, blits).
  - 6: gauges fill: the arcs travel from empty when the pane opens on Now, or from where they were when a gauge jumps 10 points or more (5 × 80 ms, blits). The figures are true from the first frame.
  - 8: stalled: eyes shut, then the body sinks and dims (2 × 300 ms), then the dim critter with its `z`.
  - 9: failed: one squash with eyes shut, then dim without the badge (2 × 130 ms), then the red `!`.
  - 10: all done: the lead squashes, hops and fades to grey on the finish sweep's own frames (no timer of its own).
- 7 (the tab track slides) is not built: the tab tests read the track row as `━` and `─` text on the terminal, which a Raster track would not draw.
- R22 narrowed: in the rich look Now's to-do bar is a 1-row Raster of the same `━` cells (where the mock put it), so 1 is a blit; its text form is still `━` runs in `Text`.
- `motion: off` and the text look show only the end states, except the text cues of 1 (the band count), 4 (one dim-amber frame) and 5 (the row mark). The desktop Svg stays still (R32). Amber stays the dialog colour (R9).


## The developer pass (2026-11-17)

Asked for by Aaron: Now spends its rows on what a developer reads all day.

R44. **Slim header by default.** Now's header is 4 rows with no lintel or sill: the pill, its meta and the gauges as figures (`context 71%   this week 45%`, bold at 70 %, red at 90 %) on row 1; the lead's critter beside the goal (2 lines) and the budget line. Option `header: full` brings back the 9-row header. The compact form (under 30 rows or 40 columns) and the desktop Svg deck are unchanged.

R45. **Watch leaves Now.** Now draws nothing for Watch: no block, no hint row (Aaron, after trying a one-line hint: "the loop line can go"). The alert model, `watchNotify`, slim's Watch line and the strip's Watch row are unchanged; the Steps tab still shows the steps.

R46. **Pull request and stack.** When the branch has a PR, Now shows a Pull request block after Needs you: the head (`#123 open · ✓ checks · approved`), the title, and on a GitHub stack (gh-stack) a row of every member from the trunk up, the cursor `▸` on the current branch. A press or `o` opens the PR in the browser; `h` and `l` move the cursor (a Button hotkey takes only a digit or a lowercase letter, so not `[` and `]`). The band's second row carries a chip (`#123 ✓ stack 3/4`) when 40 columns stay for the to-do words; slim and the strip show it too. No PR, no `gh`, offline: nothing is drawn.

R47. **Lists before the crew.** Now's order is header, Needs you, Pull request, To do, Notes and decisions, Artifacts (the newest 3, one row each, a press opens the artifact), This turn, Agents. The blocks are measured as drawn, not estimated. Spare rows go to To do first (every task, up to 14 rows), then to spacing (R50), then Notes (up to 8), Artifacts (up to 3) and agent cards.

R48. **No calm line.** "✓ Nothing needs you" is not drawn on Now; its slot is empty until something needs the person. Stopped, idle with tasks open and an unanswered permission keep their line. Slim and the strip keep the calm line.

R49. **Tab order and the command.** Artifacts is tab 4 and Steps tab 5 (`/binnacle 4` opens Artifacts). The band's hint reads `/binnacle`; the `/mc` alias is gone with the old name.

R50. **Relaxed spacing, Agents at the foot.** When To do has every row it wants and rows are left, the blocks stand two blank rows apart instead of one. Whatever is still left goes above Agents, so the Agents block sits at the foot of the pane.

R51. **Options is a tab, and the ring always lands.** The tab bar draws `0: Options` at the right end of its row wherever it fits (the tabs give up the 12-wide cells, then the space after the colon, `1:Now`, to make room; under 38 columns it stays armed and unseen). Its hotkey is `0` only: a Button takes a digit or a lowercase letter, and `o` already opens the thing in view on Now, Artifacts and Steps. Opening or closing any page (Options, a task, an agent, a step, an artifact) moves the focus ring onto the first row of what is now drawn, as a tab switch does, so the arrows walk rows instead of scrolling the pane.

R52. **Options change in place.** An option is one row; Enter changes its value right there (a switch flips, a choice steps to the next value and wraps, a time limit steps through 30, 45, 60, 90, 120, 180, 240 min and off), and the ring is put back on that row after the write. No choices open under a row, so the ring never jumps. The page has no frame or critter preview: the title, then the options from the first rows, so they fit the pane without scrolling. The row's right column says what Enter sets next (`↵ rich`, `↵ 90 min`), or when the change applies when that is not now (`next start`, `new thread`).

R44 amended (same day). **The full header is the default again.** Aaron tried both and prefers the 9-row header with the ring gauges; `header: slim` keeps the 4-row form for those who want the room.

R53. **Show as.** A new option, `showAs`: `pane` (the default: the pane and a one-row band), `band` (no pane; the band's two minimal rows above the prompt, the to-do bar and the PR chip) or `strip` (Now on its side above the prompt, what `/binnacle strip` draws). It holds in every session; choosing it on the Options tab previews it at once above the prompt (the strip on or off; under `band` the two rows stand even beside the open pane) while the pane and the Options page stay open, so the person can step through all three; leaving Options (`0`, `b`) under `band` or `strip` closes the pane, and `/binnacle options` opens it on Options again. `/binnacle`, `/binnacle close` and `/binnacle strip` still switch for the moment. `autoOpen` never opens the pane under `band` or `strip`.

R54. **The arrows always walk rows.** In the pane, Up and Down move the focus ring one row and never scroll the window: the engine turns an arrow into a one-row scroll while it has rows to scroll, and the pane answers that scroll by moving the ring to the next or previous content row (held at the ends) and bringing it into view. Page Up, Page Down, Home, End and the wheel still scroll.

R53 amended. **The styles are exclusive.** `pane`, `band` and `strip` are three viewing styles, one at a time: the pane with its one-row band; no pane and the band's two rows; no pane and the strip. Under `band` or `strip` the pane opens only for Options (`/binnacle options`), where Enter previews each style; leaving Options under `band` or `strip` closes the pane. Focus moves after a press are never awaited (an element is drawn only after the press returns, so the wait held the press, about 10 s).

R55. **Try the styles where they land.** Enter on Show as switches at once: the option is written, and `band` or `strip` closes the pane and leaves Options. The band or the strip then carries one row on top, `Show as  1: pane  2: band  3: strip  0: keep`, its Buttons pressed by a bare digit typed in the empty prompt (the engine's rule for band hotkeys; the band cannot take the keys itself), so the person goes on trying styles from where they landed. `1` opens the pane on Options with the ring on Show as, where Enter goes on cycling; `0` keeps the style and the row goes. The row is drawn only while trying (`ui.showAsTry`), the one exception to the strip having no hotkeys.
