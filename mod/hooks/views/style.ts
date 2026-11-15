import type { AgentRow, StepStatus, TaskItem } from '../../types'

/**
 * The palette: theme keys only, so the pane follows the person's theme.
 * Views never write a colour literal.
 *
 * HUD v2 roles (spec "Type, colour, spacing"):
 * - `live` / `accent` (`suggestion`): structure and live things: `▍ ┌ ▸ ◂`,
 *   hotkeys, the open tab, its track, a bar's fill, find hits.
 * - `wait` (`warning`): waiting on the person: `?`, `▲`, the NEEDS YOU corner,
 *   a rate bar at 70 % or more.
 * - `fail` / `error` (`error`): `✖`, `!`, a FAILED value, a rate bar at 90 % or more.
 * - `model` / `doc` (`merged`): model share bars and documents.
 * - `result` (`success`): artifact results only.
 * - `subtle` / `rule` (`subtle`): a bar's rest, the tab track, tree guides.
 * - Meta is `dimColor`, not a key.
 */
export const C = {
  accent: 'suggestion',
  live: 'suggestion',
  wait: 'warning',
  error: 'error',
  fail: 'error',
  model: 'merged',
  doc: 'merged',
  result: 'success',
  rule: 'subtle',
  subtle: 'subtle',
  /** @deprecated HUD v1: running is `live` (the accent) in v2. Kept until wave 2 replaces its callers. */
  running: 'warning',
  /** @deprecated HUD v1: done is dim in v2. Kept until wave 2 replaces its callers. */
  done: 'success',
  /** @deprecated HUD v1: the filled tab. v2 draws the open tab bold in the accent. */
  tabFg: 'inverseText',
} as const

/**
 * The character grid. One column is one character; a cell is 12 columns,
 * 10 of content and 2 of gap. Column 0 is the gutter, column 1 is blank,
 * content starts at `margin` (2).
 */
export const GRID = { margin: 2, cell: 12, content: 10 } as const

/**
 * The fixed start columns at 62 columns (spec "Grid"). A table row narrower
 * than 62 takes its metric and time columns from `tableCols`.
 * - `gutter` 0: `▍`, `┌`, the row flags `◂` and `!`
 * - `glyph` 2: a row's glyph, a section label (the first cell)
 * - `name` 4: a row's name (6 and 8 at tree depth 1 and 2)
 * - `detailKey` 6: an opened row's dim key; `action` 6: its action line
 * - `arg` 10: a step's argument after its 5-wide tool name at 4
 * - `detailValue` 14: an opened row's value (the second cell)
 * - `nameEnd` 36: a name ends by here (exclusive) when a metric follows
 * - `metric` 38: a table row's one metric, at most 10 wide
 * - `time` 50: a table row's time, at most 10 wide
 */
export const COL = {
  gutter: 0,
  glyph: 2,
  name: 4,
  detailKey: 6,
  action: 6,
  arg: 10,
  detailValue: 14,
  nameEnd: 36,
  metric: 38,
  time: 50,
} as const

/** The start column of cell `i` (0-based): 2, 14, 26, 38, 50, … */
export function cellCol(i: number): number {
  return GRID.margin + i * GRID.cell
}

/** How many readout cells fit `cols`: min(5, floor((cols − 2) / 12)), never negative. */
export function cellsFor(cols: number): number {
  return Math.max(0, Math.min(5, Math.floor((cols - GRID.margin) / GRID.cell)))
}

/** The width tier of a pane body: wide ≥ 62, mid 38 to 61, icon 32 to 37, slim under 32. */
export type Tier = 'wide' | 'mid' | 'icon' | 'slim'

/** The tier of `cols` (spec "Widths"). */
export function tier(cols: number): Tier {
  if (cols >= 62) return 'wide'
  if (cols >= 38) return 'mid'
  if (cols >= 32) return 'icon'
  return 'slim'
}

/** The width of one tab cell per tier: `1: Now` … in 12, `1: Tsk` in 7, `1: ◆` in 5. Slim draws no tabs. */
export const TAB_CELL = { wide: 12, mid: 7, icon: 5 } as const

/**
 * Where a table row's columns fall at `cols`:
 * - 5 cells (≥ 62): metric at 38, time at 50, the name ends by 36
 * - 3 or 4 cells (38 to 61): time on the last cell (38 or 26), no metric
 * - fewer (under 38): the name only, to the edge
 * `nameEnd` is exclusive: the name's last character sits at `nameEnd − 1`.
 */
export function tableCols(cols: number): { nameEnd: number; metric?: number; time?: number } {
  const cells = cellsFor(cols)
  if (cells >= 5) return { nameEnd: COL.nameEnd, metric: COL.metric, time: COL.time }
  if (cells >= 3) {
    const time = cellCol(cells - 1)
    return { nameEnd: time - 2, time }
  }
  return { nameEnd: cols }
}

/** The colour of a rate or context bar at `pct`: the accent, `warning` from 70, `error` from 90. */
export function rateColor(pct: number): string {
  if (pct >= 90) return C.fail
  if (pct >= 70) return C.wait
  return C.live
}

/**
 * The HUD v2 colour of a status glyph: live in the accent, a failure in
 * `error`; undefined means dim (done, pending, interrupted).
 */
export function statusColor(status: StepStatus | AgentRow['status'] | TaskItem['status']): string | undefined {
  switch (status) {
    case 'running':
    case 'in_progress':
      return C.live
    case 'error':
    case 'denied':
      return C.fail
    default:
      return undefined
  }
}

/**
 * The theme key of a status glyph; undefined means a dim glyph (pending, interrupted).
 * @deprecated HUD v1 colours (running in warning, done in success). Use `statusColor`.
 */
export function glyphColor(status: StepStatus | AgentRow['status'] | TaskItem['status']): string | undefined {
  switch (status) {
    case 'running':
    case 'in_progress':
      return C.running
    case 'done':
    case 'completed':
      return C.done
    case 'error':
    case 'denied':
      return C.error
    default:
      return undefined
  }
}
