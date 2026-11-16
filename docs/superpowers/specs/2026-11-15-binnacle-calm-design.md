# Mission Control: calm redesign (buildable design)

Date: 2026-11-15. Status: design only, for Aaron's review. Nothing is built. Mocks: `Calm*.dc.html` in the mock canvas
folder (`…/scratchpad/mcstyles/project/`), listed at the end. `CalmInline.dc.html` there is an older mock and is not
part of this.

## Principles

1. **The Now tab answers three questions and stops:** what is happening, is anything waiting on me, how far along are
   we. Everything else is one press away.
2. **Three weights only.** Bold for the one headline of a screen, normal for rows, dim for labels, meta and anything
   secondary. No caps, no rule lines.
3. **Colour means something.** Accent = open or live (open tab, a running `▸`). Warning = waiting on the person. Error
   = failed. Nothing else is coloured; done is a dim `✓` or no glyph at all.
4. **Space separates, not lines.** One blank row between groups, a 2-column indent under a label. No section rules, no
   boxes, no full-width bars.
5. **One row per thing.** A second line appears only for a running agent (what it is doing) or a row the person
   opened.
6. **Quiet states are quiet.** A group with nothing in it is not drawn. Zero counts are not written (`Errors 0`
   becomes `Errors`, dim).
7. **Lists show a few, then `+n …`.** Raw answers, raw JSON and long outputs live only in an opened row or the step
   detail.
8. **Show less instead of cutting more.** Meta gives way before the name is cut; the headline wraps to two lines
   before it is cut.
9. **The same thing sits in the same place** on every tab: tab bar, blank row, a dim label line, rows. A sub-page
   starts with its `b: Back` row.

## Navigation decision

**Four tabs: `1: Now 2: Tasks 3: Agents 4: Steps`** (37 columns; plain hotkeyed Buttons, `columnGap={2}`, no `│`, no
fill, no rule under the bar; the open tab is a bold accent `Text` child, the others `dimColor`).

- Why four: five labels need 63 columns and wrap in a 62-column pane. Artifacts are few and are "things the session
  made", so they become the fourth filter of Steps (`All Pinned 2 Errors 1 Artifacts 3`) and, when the session is
  idle, rows on Now.
- Why rename: `Overview` and `Timeline` are the two longest labels. Only the labels change; the `Tab` ids stay
  (`overview`, `timeline`, `artifacts`). `artifacts` stays a `Tab` value that the bar draws as Steps being open.
- Tasks stays its own tab: Now shows one Tasks line; the list of 14 is detail.
- `/mc 1`-`4`, `/mc now|tasks|agents|steps`, and the old words `overview`, `timeline`, `artifacts`, `5` all keep
  working (`5` and `artifacts` open the Artifacts filter).
- Under 38 columns only the open tab keeps its name: `1: Now 2: T 3: A 4: S` (at most 24 columns with any tab open),
  `columnGap={1}`.

## Type, colour and glyph scale

| Role | Drawn as | Theme key |
|---|---|---|
| Headline (one per screen) | bold | none |
| Row | normal | none |
| Label, meta, tool name, tree lines, second lines | `dimColor` | none |
| Open tab, running `▸`, the active filter chip, a running block | bold or plain | `suggestion` |
| `Needs you`, `?` asking, a budget window at 70 % or more | | `warning` |
| `✖` failed, `!` problem in the tree, `n errors`, budget at 90 % or more | | `error` |
| The `✓` of "All n tasks done" (the only green) | | `success` |
| The unfilled part of the short bar | | `subtle` |
| An action word with no hotkey (`show`, `Steps`, `×`, `Export digest`) | dim, `underline` | none |

- Accent budget per screen: the open tab, running glyphs, one active chip. Never a label.
- Glyphs: `▸` running, `✖` failed, `?` asking, `!` problem, `○` pending, `✓` done (dim), `★` pinned (plain), `◂` on
  screen (dim), `≡` a workflow run (dim). A finished row has two spaces where its glyph would be. Artifact kind glyphs
  `↗ ▤ ◆ ⎇` are all dim; the kind word on the right says the rest, so the legend row goes.
- `style.ts`: `C.done` is used only by the all-done headline; `C.doc` and `C.tabFg` go; `glyphColor('running')`
  returns the accent, `done` returns undefined (dim).

## Spacing rules

- Tab bar, one blank row, then the body. Body groups in a `Box` with `rowGap={1}`.
- A group is a dim label line at column 0 (labels on Now padded to 8: `Tasks `, `Agents `), its rows indented 2, a
  row's own second line indented 4.
- List rows reserve a 2-column glyph gutter, so names line up whether or not a row has a glyph.
- Right meta sits in a `space-between` row (never glued: the Tasks elapsed bug), at least 2 columns from the name.
  Two-line rows (artifacts, run agents) get a blank row between them; one-line rows do not.
- The short bar is 12 cells of `━` (8 under 48 columns, none under 32), fill in the default text colour, rest
  `subtle`, always followed by the count in words (`9 of 14`).
- Key hints are one dim last line, only while `e.props.isFocused`: `tab move · enter open · esc back to the prompt`.

## Screens

### Now (`overview.tsx`)

Default, top to bottom, each group only when it has content:
1. **Needs you** (warning, bold), one row per problem: glyph, text, dim age, `×`.
2. **Headline**: Claude's focus, else the task in progress, else the running step; bold; wraps to 2 lines. Its age is
   shown (dim, right) only when over 2 minutes old. `next <text>` under it. Idle after work: `✓ All 14 tasks done` and
   a dim `finished 4m ago · 1h23 · 39 steps`. Nothing yet: one dim `Nothing running yet.`
3. **Tasks** one line: label, short bar, `9 of 14`. Not drawn when all are done.
4. **Agents** `2 running`, then one row per running agent: description, dim `type · elapsed`. Not drawn with none
   running.
5. **Notes**: the newest 2, plain rows, `+n more`.
6. **Artifacts**: the newest 2, only while nothing is running.
7. **Footer** (dim, `space-between`): left `ctx 31% · 5h 44%`; right `27 steps · 2 artifacts`, with `n errors` in the
   error colour when there are any. Idle: the right side is `Export digest`.

One press away: each label line opens its tab; an agent row opens Agents with that row open; the footer's left opens
Budget in place (`ui.more: 'budget'`): one line per window with the short bar, percentage and reset time, then the
per-model totals; the footer's right opens Steps; `+n more` under Notes opens all notes in place.

Removed: caps headers and rules, the full-width task bar, the task rows (they repeat the headline), `0 running · 6
done`, the BUDGET section and its two bars, LATEST (four `Task 14 updated` rows), the `from Claude` meta, the
two-column wide layout's `↓ notes 2` line (replaced by the footer).

### Tasks (`tasks.tsx`)

Default: the `Tasks ━━━ 9 of 14` line; one dim `✓ 9 done` row with `show`; the task in progress (accent `▸`, bold,
elapsed right) with one dim line per agent working on it (`Explore · find every caller of stepRow`); a blank row; the
next 5 pending (`○`, dim glyph), `+n more`. Plan order is kept.

One press away: `show` lists the done tasks in order, dim (`ui.showDone`); an agent line opens Agents with that row
open.

Removed: the header rule, the yellow `▶` and the agent's raw `doing` output line under each task, the agents' own
nested task lists (they live in the agent's opened row), agents under finished tasks.

### Agents (`agents.tsx`, `tree.tsx`, `runboard.tsx`, `agentmeta.ts`)

List, default: `Agents 2 running · 6 done` with `l: List t: Tree` on the same row (wraps under it when narrow; the
open mode bold, the other dim). `main` first, then a blank row; running agents (accent `▸`, a dim `doing` line under
each); then the newest 5 finished as one-line rows, `+n finished`; then each workflow run as **one row** (`≡
review-branch workflow 4 of 6 · 1 failed · 6m`); a last dim line of per-model totals (`opus 993k · sonnet 253k · haiku
310k`).

Row: `<glyph> <description>` left, dim `<type> · <model tokens> · <elapsed>` right. Meta gives way in this order:
model and tokens (under 56 columns), type (under 48), then the description is cut.

One press away: a row opens in place (`ui.agentOpen`, one at a time; the name turns bold): the first 3 lines of its
answer, a dim `2 steps · started 13:25`, and `Steps` (Steps filtered to it) and `View transcript`. A run row opens the
run board.

Tree: the same row, with dim branch lines; fold glyphs `▾ ▸` dim; `!` in the error colour on a problem node and its
folded ancestors; a folded branch shows `4 agents · 1 running`; `○ running only` under the header. A node opens in
place as in the list. Meta in the tree is `type · elapsed` (tokens when the node is opened).

Run board: `b: Back`; the run's name bold; a dim `workflow · 4 of 6 done · 1 failed · 6m`; per agent a row (`index`,
glyph, description, elapsed), its step strip, its dim result line; a blank row between agents. Strip blocks are dim, a
failed one error, a running one accent.

Removed: the AGENTS and BY MODEL headers, the answer line under every agent (`└ 17`), `View` on its own line under
every row and node, the step count in row meta, a run's agents in the list (they are in its board and the tree), green
on finished rows.

### Steps (`timeline.tsx`, `detail.tsx`, `artifacts.tsx`, `find.ts`)

List, default: the find `Input`; the chips (the active one accent and bold, the rest dim, zero counts unwritten); a
blank row; the newest turn as a bold title with its time, then its newest 8 steps and `+n earlier`; a blank row; older
turns as one line each (`▸ title 13:02 · 12`).

- Turn title: the first line of the prompt, with every path shortened to `…/<last segment>` (new `shortPaths` in
  `fit.ts`); never a raw `C:\…` path.
- Step row: glyph gutter, dim tool name, the argument, dim right meta. The right meta is the agent type for a
  subagent's step, the elapsed time only from 2 s up, and `◂` when the row is on screen. A done step has no glyph.
- Step labels never show raw JSON: `SubagentHandback` and `StructuredOutput` rows are labelled `<type> answered`,
  `TaskUpdate` rows `Task <n> <status>`; their bodies are in the detail.

One press away: a step opens the detail; a folded turn opens; `+n earlier` shows the whole turn (`ui.openTurns`
already holds this for older turns; add the newest).

Step detail: row 1 `b: Back p: Pin g: Show in chat`. Then the step: glyph, bold label, a dim `agent · time · elapsed ·
status`, the pin note. Then, in this order, **Change** (a diff, when there is one), **Result**, **Input**. The Result
label row carries `c: Copy Markdown Quote` on its right (under it when narrow). Input with up to 4 scalar keys is
drawn as dim-key rows, otherwise as JSON `Code`.

Artifacts filter: one two-line row per artifact (dim glyph, title, dim `kind · age`; second line the summary or the
ref cut from the left, `×n` when rewritten), a blank row between; a last dim line `Code edits are steps, not
artifacts. 4 files changed.` Pressing opens the step, else copies the ref. The find field filters titles too.

Removed: the MATCHES header (the count goes to the right of the chip row), the `↗ Show in chat` line under every row
while finding (it is `g` in the detail), the words `on screen`, the bracketed button row of six, the STEP / INPUT /
CHANGE / RESULT headers, the artifact legend and kind colours, bold artifact titles.

### Band (`band.tsx`)

`◆ 9/14 · Grouping timeline steps by agent · 2 agents` and a right-aligned dim `/mc`. One accent glyph; the focus in
normal weight; counts and dots dim. With problems the row starts with `! 2 need you` in the warning colour. All done:
one fully dim `◆ 14/14 done · 2 artifacts`. Nothing to say: `next(e)`. Narrow: `/mc` goes, then the agents, then the
focus is cut. No `│`, no `▣ ▶ ●`.

## Narrow behaviour

| Seat | What changes |
|---|---|
| Docked, 48-61 | model and tokens leave agent meta; the mode row wraps under the header |
| Docked, 38-47 | bar is 8 cells; agent meta is elapsed only; the footer is two lines; detail actions wrap |
| Docked, 24-37 | tabs are `1: Now 2: T 3: A 4: S`; no bar; Notes and Artifacts groups go (counts stay in the footer); no meta on agent rows |
| Inline strip (under 110 terminal columns, `rows: 14`) | Now in two columns when `bodyColumns ≥ 80`: left the headline, `next`, Tasks; right Needs you, else Agents. Budget moves to the right of the tab row; one dim counts line last. About 9 rows used; the frame fits the tree. Other tabs draw as docked and scroll. |

## Where each feature lives

- **Needs-you**: first group on Now, one row each; the band's first part; `!` in the tree; the notification and toast
  rules are unchanged.
- **Find and jump**: the find field tops Steps; `/mc find <text>` from the prompt; `g: Show in chat` in the detail;
  `View transcript` in an opened agent; `◂` marks rows on screen.
- **Budget**: the dim left half of the Now footer, coloured only from 70 %; opens in place to bars and per-model
  totals; model and tokens in agent meta; the totals line under the Agents list; toasts unchanged.
- **Handoff**: `Export digest` on the idle Now and `/mc export`; `c: Copy`, `Markdown` and `Quote` on the detail's
  Result row.
- **Keyboard**: `1`-`4`, `l`, `t`, `b`, `p`, `g`, `c`; `/mc <tab>`, `/mc find`, `/mc pin`, `/mc export`, `/mc close`;
  the focused-only hint line; `autoFocus` on the first Needs-you row, else the headline's group.
- **Run board**: behind the one run row in the Agents list and the run node in the tree.
- **Tree**: `t` on Agents; same row and opened-row design as the list.

## Changes to the current code

State (`mod/types/index.d.ts`, `state.ts`): add to `UiState` `agentOpen?: string`, `showDone: boolean`, `more?:
'budget' | 'notes'`; defaults wherever `ui` is restored.

- `style.ts`: palette as in the scale above.
- `fit.ts`: `shortPaths(text)`; `blockBar` takes a fixed width and draws `━`.
- `parts.tsx`: replace `sectionHeader` with `label(text, value?)` (dim label, optional value, no rule); keep
  `splitLine`, give it the 2-column gutter and a 2-column minimum gap; add `action(text)` for underlined dim Buttons.
- `shell.tsx`: `TABS` to four with the new labels; drop the separators, the fill and the rule; a blank row after the
  bar; under 38 columns the short form; `tabFor` accepts old and new words and `5`; the bar marks Steps open for
  `artifacts`; the focused-only hint line after the body.
- `overview.tsx`: rebuild as the seven groups above; delete `tasksSection`'s rows, `latestSection`, the `WIDE`
  two-column docked layout (keep two columns for the inline seat only, read from `placement`).
- `needs.tsx`: one row per problem with `×` on the right; header is a warning label.
- `budget.tsx`: `budgetSection` becomes the footer line plus the opened block (short bars); `modelsSection` becomes
  one dim line; `fillColor` returns undefined under 70.
- `tasks.tsx`: the done fold, the pending cap, one dim line per agent, no nested tasks.
- `agents.tsx`, `agentmeta.ts`: one-line row with the meta order above; opened row; finished cap; a run as one row;
  mode buttons on the header row; no `View` line.
- `tree.tsx`: dim fold glyphs; no `View` line; opened node; run header as a plain row.
- `runboard.tsx`: bold name, dim stats line, `rowGap={1}` between agents, dim blocks.
- `timeline.tsx`: chips without zero counts plus the Artifacts chip; turn title through `shortPaths`; step row as
  above; per-turn cap of 8; no per-row `Show in chat`; draws `artifactsView` when `tab === 'artifacts'`.
- `detail.tsx`: two plain hotkeyed action rows as above; order Change, Result, Input; dim labels; key-value Input.
- `artifacts.tsx`: dim glyphs, plain titles, a blank row between rows, no legend.
- `band.tsx`: the new parts and drop order; dots for bars.
- Capture or model (`capture.ts`, `model/`): humane labels for `SubagentHandback`, `StructuredOutput`, `TaskUpdate`
  steps.
- Tests: every view test asserts the old headers and glyph colours; they change with the views. The 24-column and
  four-surface rules stay as they are.

## Artboards

- `CalmNowBusy.dc.html`: Now during a busy session: headline, Tasks line, two running agents, notes, footer.
- `CalmNowIdle.dc.html`: Now when the work is done: the all-done headline, notes, artifacts, `Export digest`.
- `CalmNowWaiting.dc.html`: Now with two Needs-you rows, a budget window past 70 %, and the band's warning part.
- `CalmTasks.dc.html`: Tasks: done folded to one row, the task in progress with its agents, the next five.
- `CalmAgents.dc.html`: Agents list: running rows, one finished row opened, a failed row, a run as one row, model
  totals.
- `CalmAgentsTree.dc.html`: Agents tree: branch lines, an open run, a folded branch with a problem mark.
- `CalmRun.dc.html`: one workflow run: six agents with step strips and result lines.
- `CalmSteps.dc.html`: Steps list: find field, chips, the newest turn, folded older turns, the focus hint line.
- `CalmStepOpen.dc.html`: a failed step opened: action row, header, Result with its handoff actions, Input.
- `CalmArtifacts.dc.html`: Steps with the Artifacts filter: three two-line artifact rows.
- `CalmBand.dc.html`: the band in five states: working, waiting, all done, 40 columns, nothing to say.
- `CalmStrip.dc.html`: a narrow terminal: the inline strip in two columns above the band and prompt.
- `CalmNarrow.dc.html`: docked at 40 columns (Now and Agents) and at the 24-column floor (Now).
