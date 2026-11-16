# Mission Control — restyle (short design)

Date: 2026-11-15. Status: approved by Aaron ("A is good", "let's build it").
Mocks: https://claude.ai/artifact/R4JHk79nyTdVVFszFwfKsb (column A).

## Intent

Aaron's look at the real pane: the tab row reads as one run of text (`1:` sits as
close to the previous title as to its own), and the views use only bold and dim.
He wants a clearer, more modern look.

## Approaches

- **A · Calm accent (chosen).** One accent colour, rule-line section headers,
  coloured status glyphs, a block progress bar. No extra rows or columns, so it
  holds at 24 columns and in the 14-row inline seat.
- B · Cards: a bordered box per section. Rejected: borders cost 2 rows and
  2 columns per section; NOTES and ARTIFACTS fall off a docked pane.
- C · Dashboard: header bar, background chips, two columns. Rejected as the
  default: busiest; two columns cramp a 62-column pane.

## Design

- **Colours are theme keys**, so the pane follows the person's theme:
  accent `suggestion`; running `warning`; done `success`; error `error`;
  document glyph `merged`; rules and inactive separators `subtle`; secondary
  text `dimColor`; the open tab `backgroundColor: 'suggestion'` with
  `color: 'inverseText'`. One module (`mod/hooks/views/style.ts`) names them;
  views never write a colour literal.
- **Tab bar:** number and title together, a dim `│` between groups, the open tab
  filled: ` 1 Overview │ 2 Tasks │ 3 Agents │ 4 Timeline │ 5 Artifacts`. The
  number is drawn in the accent colour. If a plain hotkeyed Button cannot drop
  the engine's `1:` prefix, `1: Overview` with the separators and fill is the
  accepted fallback. Narrow (< 56 cols): first three letters, as today.
  A dim rule line under the bar.
- **Section header:** `LABEL ──────── meta`: label in accent, bold; a rule in
  `subtle` filling the row to `cols`; meta dim, right-aligned.
- **Rows:** status glyph coloured (`▶` warning, `✔` success, `✖` error, `·`
  running step in warning, `★` warning, pending task `○` dim); meta (elapsed,
  counts, agent type) dim and right-aligned in a `space-between` row; a two-line
  row's second line dim with `└ `.
- **Progress:** a block bar `█…░`, filled part `success`, rest `subtle`, sized
  to `cols`; the count `2/6` sits in the TASKS header's meta.
- **Band:** `▣ 2/6 tasks │ ▶ <focus> │ ● 2 agents │ /mc`, glyphs coloured, `│`
  dim.
- **Overview in a wide, short seat:** when `bodyColumns ≥ 96`, NOW + TASKS in a
  left column and AGENTS + LATEST in a right column; NOTES and ARTIFACTS
  summarised in one dim line (`↓ notes 2 · artifacts 2`).
- **Every tab** (Overview, Tasks, Agents list and tree, Timeline, Detail, and
  Task 9's Artifacts) uses these helpers.
- **`/mc <tab>`** (Claude's call, recommended in the keys research): `/mc 1`–`/mc 5`
  and `/mc overview|tasks|agents|timeline|artifacts` open the pane on that tab
  from the prompt, mid-turn. The argument hint lists them.

## Constraints kept

24-column floor (every line fits), the 14-row inline seat, no Box inside a
Button, identity keys, no state writes in render, four-surface tests (band:
three). VS Code draws plainer; tests assert structure and props, not pixels.

## Left to the builder

Exact rule glyph, spacing, and where the one-line NOTES/ARTIFACTS summary goes.
