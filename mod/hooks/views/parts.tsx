import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'

import { debug, errText } from '../state'
import { sweepCells, sweepFrame, sweepShows } from './delights'
import { at, bar10, DIAGRAM, fit, fitRuns, headerParts, keepCells, line, nameFit, pillRun, placed, spark10, stack10, tether, toolCell, wordFit, wrapWords } from './fit'
import { closePage } from './pagenav'
import { track } from './paint'
import { frameFoot, frameTop, GAUGE_PAIR, GAUGE_RING, gaugeFigure, gaugePair, lintel, lintelRoom, sill } from './raster'
import type { Grid, Ground, Hue } from './raster'
import type { ViewCtx } from './shell'
import { accentName, C, cellsFor, CK, COCKPIT, COL, DECK, edges, gaugeStyle, GRID, palette, RAIL, tableCols, toneKey } from './style'
import type { CritterArgs, Run, Tone4 } from './style'

const MIN_SPLIT = 8

/**
 * `LABEL ─── meta` as one Text of three runs (so a Button may hold it): the
 * label in the accent, bold; the rule in `subtle`; the meta dim. The runs sum
 * to `cols`; the meta gives way first, then the rule.
 * @deprecated HUD v1. Use `section`; the spec removes this once wave 2 lands.
 */
export function sectionHeader(label: string, meta: string, cols: number, e: RenderInput, $: EngineInterface): RenderElement {
  const { Text } = $.ui.resolve(e)
  const p = headerParts(label, meta, cols)
  return (
    <Text>
      <Text color={C.accent} bold>
        {p.label}
      </Text>
      {p.rule !== '' ? <Text color={C.rule}>{p.rule}</Text> : null}
      {p.meta !== '' ? <Text dimColor>{p.meta}</Text> : null}
    </Text>
  )
}

/**
 * A glyph in its status colour (dim when it has none), a space and the text;
 * the whole fits `ctx.cols`. `indent` is plain spaces before the glyph.
 * @deprecated HUD v1. Use `row`.
 */
export function glyphLine(
  ctx: ViewCtx,
  $: EngineInterface,
  glyph: string,
  color: string | undefined,
  text: string,
  bold = false,
  indent = '',
): RenderElement {
  const { Text } = $.ui.resolve(ctx.e)
  const body = wordFit(text, Math.max(0, ctx.cols - indent.length - glyph.length - 1))
  return (
    <Text>
      {indent !== '' ? indent : null}
      {color !== undefined ? <Text color={color}>{glyph}</Text> : <Text dimColor>{glyph}</Text>}
      {bold ? <Text bold>{` ${body}`}</Text> : ` ${body}`}
    </Text>
  )
}

/**
 * The dim gap and right text that push `right` to the edge of `cols` after `used` cells; ' right' when it cannot be flush.
 * @deprecated HUD v1: v2 puts the time on a grid column, not flush right.
 */
export function flushRight(used: number, right: string, cols: number): string {
  return `${' '.repeat(Math.max(1, cols - used - right.length))}${right}`
}

/** A press only: the engine refuses `$.ui.view` outside one. A refusal is toasted. */
export async function viewAgent($: EngineInterface, agentId: string): Promise<void> {
  try {
    const shown = await $.ui.view({ agentId })
    if (shown.deny !== undefined && shown.deny !== '') $.ui.toast(shown.deny)
  } catch (err) {
    debug($, `view failed: ${errText(err)}`)
    $.ui.toast(errText(err))
  }
}

// ---------- HUD v2 primitives ----------
//
// Every primitive draws whole rows on the character grid (style.ts `COL`,
// `tableCols`, `cellsFor`) and takes `(ctx, $, …)`: `$` is its own argument
// because the engine's scan refuses `$` held in an object. A row never runs
// past `ctx.cols`: names are cut by word (`wordFit`), cells and heads to 10.
//
// Rhythm is the caller's (spec "Rhythm"): `blank` between sections and
// never two; a `blank` above an opened row (unless it is first in its section)
// and after its action line; at most 6 rows in a list, then `more`.

/** A styled piece of one line (defined in style.ts, so the pure gauges in fit.ts can return it). */
export type { Run }

/** A Run as one Text. `key` is its address in a list. */
export function runText(r: Run, e: RenderInput, $: EngineInterface, key?: string): RenderElement {
  const { Text } = $.ui.resolve(e)
  return (
    <Text
      key={key}
      color={r.color}
      bold={r.bold === true ? true : undefined}
      dimColor={r.dim === true ? true : undefined}
      backgroundColor={r.bg}
      underline={r.underline === true ? true : undefined}
    >
      {r.text}
    </Text>
  )
}

/** A string as one plain run, or the runs as they are. */
const asRuns = (v: string | Run[], style: Omit<Run, 'text'> = {}): Run[] => (typeof v === 'string' ? [{ text: v, ...style }] : v)

/** The runs, each after its gap, laid at their columns from `start`. */
function laidOut(segs: (Run & { col: number })[], start: number, e: RenderInput, $: EngineInterface, prefix: string): (RenderElement | string)[] {
  const out: (RenderElement | string)[] = []
  placed(segs, start).forEach((p, i) => {
    if (p.gap !== '') out.push(p.gap)
    out.push(runText(p.seg, e, $, `${prefix}${i}`))
  })
  return out
}

/** The gutter flags: `◂` (in view in the chat) in the accent, `!` (a problem here or below) in error, `?` (waiting on the person) and `z` (stalled) in warning. */
export type Flag = 'inView' | 'problem' | 'waiting' | 'stalled'

const FLAG: Record<Flag, Run> = {
  inView: { text: '◂', color: C.live },
  problem: { text: '!', color: C.fail },
  waiting: { text: '?', color: C.wait },
  stalled: { text: 'z', color: C.wait },
}

/** What `row` draws. */
export type RowSpec = {
  /** The row's address: the Button's key (and its press target). Unique in the pane. */
  key: string
  /** Column 0: `◂`, `!`, `?` or `z`; absent, blank. */
  flag?: Flag
  /** Column 2 (+2 per depth): the status glyph. */
  glyph: string
  /** The glyph's theme key (`statusColor`); absent, dim. */
  glyphColor?: string
  /** Column 4 (+2 per depth): a dim tool name cut to 5; the name then starts 6 further on (10). */
  tool?: string
  /** The name: plain, cut by word to end by `tableCols(cols).nameEnd` (36 at 62). Runs keep their styles (find hits underlined). */
  name: string | Run[]
  /** The opened or focused row: the name bold. */
  bold?: boolean
  /** A done task: the whole row dim. */
  dim?: boolean
  /** Column 38 (62 up only), dim unless a Run says otherwise; cut to 10. */
  metric?: string | Run
  /** Column 50 (62 up), the last cell's column at 38 to 61, dropped under 38; dim unless a Run says otherwise; cut to 10. */
  time?: string | Run
  /** Tree depth 0 to 2: glyph at 2/4/6, name at 4/6/8. */
  depth?: 0 | 1 | 2
  /** Tree guide drawn in `subtle` from column 2, at most `depth × 2` wide. */
  guide?: string
  /**
   * Neo's tether prefix (in place of `guide`), drawn in `subtle` (fit.ts
   * `tether`): at depth 1 `├╌` (or `╰╌` when `last`) on columns 2 to 3 and the
   * hull at 4; at depth 2 `┆` at 2 when `outer` (the parent has siblings
   * below), the tether on 4 to 5 and the hull at 6. Ignored at depth 0.
   */
  tether?: { last?: boolean; outer?: boolean }
  /** Absent, the row is a Text (not pressable). */
  onPress?: () => void | Promise<void>
  /** The pane's focus ring starts here (the first NEEDS YOU row). */
  autoFocus?: boolean
}

/** The room a cell at `col` has: 10, or less at the edge. */
const cellRoom = (cols: number, col: number): number => Math.min(GRID.content, cols - col)

const cellText = (v: string | Run, room: number): Run =>
  typeof v === 'string' ? { text: wordFit(v, room), dim: true } : { ...v, text: wordFit(v.text, room) }

/**
 * A table row: `flag` at 0, `glyph` at 2, `tool` at 4 and the name at 10 (or
 * the name at 4), `metric` at 38, `time` at 50 (columns from `tableCols`).
 * Drawn as a row Box of the gutter (a Text of width 2) and one plain Button
 * keyed `key` holding the padded runs: no Box inside the Button.
 *
 * @example row(ctx, $, { key: `agent-${a.id}`, glyph: '▸', glyphColor: statusColor(a.status), name: a.description, metric: '72k', time: '1m', onPress: () => open(a.id) })
 */
export function row(ctx: ViewCtx, $: EngineInterface, r: RowSpec): RenderElement {
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  const cols = ctx.cols
  const tc = tableCols(cols)
  const indent = 2 * (r.depth ?? 0)
  const glyphCol = COL.glyph + indent
  const toolCol = COL.name + indent
  const nameCol = r.tool !== undefined ? toolCol + 6 : toolCol
  const nameEnd = Math.min(tc.nameEnd, cols)
  const dim = r.dim === true ? { dim: true } : {}
  const segs: (Run & { col: number })[] = []
  const guide = r.tether !== undefined ? tether(r.depth ?? 0, r.tether.last === true, r.tether.outer === true) : r.guide
  if (guide !== undefined && indent > 0) {
    const text = fit(guide, indent)
    const lead = text.length - text.trimStart().length
    segs.push({ col: COL.glyph + lead, text: text.trimStart(), color: C.subtle })
  }
  segs.push({ col: glyphCol, text: r.glyph, ...(r.glyphColor !== undefined ? { color: r.glyphColor } : { dim: true }) })
  if (r.tool !== undefined) segs.push({ col: toolCol, text: toolCell(r.tool, 5), dim: true })
  const nameStyle: Omit<Run, 'text'> = { ...(r.bold === true ? { bold: true } : {}), ...dim }
  const name = fitRuns(asRuns(r.name, nameStyle), Math.max(0, nameEnd - nameCol))
  let col = nameCol
  for (const n of name) {
    segs.push({ ...nameStyle, ...n, col })
    col += n.text.length
  }
  if (r.metric !== undefined && tc.metric !== undefined) {
    segs.push({ ...cellText(r.metric, cellRoom(cols, tc.metric)), ...dim, col: tc.metric })
  }
  if (r.time !== undefined && tc.time !== undefined) {
    segs.push({ ...cellText(r.time, cellRoom(cols, tc.time)), ...dim, col: tc.time })
  }
  const body = laidOut(segs.filter(s => s.text !== ''), COL.glyph, ctx.e, $, `${r.key}-`)
  const flag = r.flag !== undefined ? FLAG[r.flag] : undefined
  return (
    <Box key={`row-${r.key}`} flexDirection="row">
      <Text color={flag?.color}>{flag !== undefined ? `${flag.text} ` : '  '}</Text>
      {r.onPress !== undefined ? (
        <Button key={r.key} plain onPress={r.onPress} autoFocus={r.autoFocus === true ? true : undefined}>
          {body}
        </Button>
      ) : (
        <Text key={r.key} wrap="truncate-end">
          {body}
        </Text>
      )}
    </Box>
  )
}

/** One detail line of an opened row: a dim key at 6, the value at 14. */
export type Detail = { key: string; value: string | Run[] }

/** One action of an opened row, drawn by the engine as `g: chat`. */
export type Action = { hotkey: string; label: string; key: string; onPress: () => void | Promise<void> }

/** The columns `hotkey: label` takes as a plain hotkeyed Button. */
const actionWidth = (a: { hotkey: string; label: string }): number => a.hotkey.length + 2 + a.label.length

/**
 * The detail of an opened row, drawn under it: 1 to 3 lines with a dim key at
 * 6 (cut to 7) and the value at 14 (cut by word to the edge), then one line of
 * 2 or 3 plain hotkeyed Buttons from column 6, 3 columns apart. Lines past 3
 * and actions past 3 are left out, and actions that do not fit the width are
 * left off from the end. The opened row itself is a `row` with `bold`.
 *
 * @example opened(ctx, $, [{ key: 'status', value: 'failed after 4s' }], [{ hotkey: 'g', label: 'chat', key: `chat-${s.id}`, onPress: () => showInChat(s) }])
 */
export function opened(ctx: ViewCtx, $: EngineInterface, details: Detail[], actions: Action[]): RenderElement {
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  const cols = ctx.cols
  const lines = details.slice(0, 3).map((d, i) => {
    const value = fitRuns(asRuns(d.value), Math.max(0, cols - COL.detailValue))
    const segs: (Run & { col: number })[] = [
      { col: COL.detailKey, text: wordFit(d.key, COL.detailValue - COL.detailKey - 1), dim: true },
    ]
    let col = COL.detailValue
    for (const v of value) {
      segs.push({ ...v, col })
      col += v.text.length
    }
    return (
      <Text key={`detail-${i}`} wrap="truncate-end">
        {laidOut(segs.filter(s => s.text !== ''), 0, ctx.e, $, `d${i}-`)}
      </Text>
    )
  })
  const shown: Action[] = []
  let used = COL.action
  for (const a of actions.slice(0, 3)) {
    const w = (shown.length > 0 ? 3 : 0) + actionWidth(a)
    if (used + w > cols) break
    shown.push(a)
    used += w
  }
  return (
    <Box flexDirection="column">
      {lines}
      {shown.length > 0 ? (
        <Box key="actions" flexDirection="row" paddingLeft={COL.action} columnGap={3}>
          {shown.map(a => (
            <Button key={a.key} hotkey={a.hotkey} plain onPress={a.onPress}>
              {a.label}
            </Button>
          ))}
        </Box>
      ) : null}
    </Box>
  )
}

/** One readout cell: a dim caps label, a bold value, a 10-wide diagram. */
export type ReadoutCell = {
  /** Dim caps, cut to 10. */
  label: string
  /** A string is drawn bold; runs keep their own styles. At most 10 wide. */
  value: string | Run[]
  /** Exactly 10 wide: `barCell`, `stackCell` or `sparkCell`. */
  gfx: Run[]
  /** Which cell goes first when the width holds fewer: rank 1 before 2; unranked cells go last, from the end. */
  drop?: number
  /** With `onPress`, the label is a plain dim Button keyed `key`. */
  key?: string
  onPress?: () => void | Promise<void>
}

/**
 * The readout: three rows (labels, values, diagrams) of cells, each a Box of
 * width 12 on the cell columns 2, 14, 26, 38, 50. As many cells as
 * `cellsFor(cols)` allows, dropped by `drop` rank (`keepCells`). Nothing
 * when not one fits.
 * @deprecated Neo draws a `deck`; the spec removes this once every view uses one.
 *
 * @example readout(ctx, $, [{ label: 'TASKS', value: [{ text: '9', bold: true }, { text: '/14', dim: true }], gfx: barCell(9, 14) }, { label: '7D', value: '22%', gfx: barCell(22, 100, rateColor(22)), drop: 1 }])
 */
export function readout(ctx: ViewCtx, $: EngineInterface, cells: ReadoutCell[]): RenderElement | null {
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  const kept = keepCells(cells, cellsFor(ctx.cols))
  if (kept.length === 0) return null
  const cellRow = (name: string, draw: (c: ReadoutCell, i: number) => RenderElement): RenderElement => (
    <Box key={`readout-${name}`} flexDirection="row">
      <Text>{'  '}</Text>
      {kept.map((c, i) => (
        <Box key={`${name}-${c.key ?? c.label}`} width={GRID.cell}>
          {draw(c, i)}
        </Box>
      ))}
    </Box>
  )
  const clip = (rs: Run[]): Run[] => fitRuns(rs, GRID.content) as Run[]
  return (
    <Box flexDirection="column">
      {cellRow('label', c =>
        c.onPress !== undefined ? (
          <Button key={c.key ?? `cell-${c.label}`} plain dimColor onPress={c.onPress}>
            {wordFit(c.label, GRID.content)}
          </Button>
        ) : (
          <Text dimColor>{wordFit(c.label, GRID.content)}</Text>
        ),
      )}
      {cellRow('value', (c, i) => <Text>{clip(asRuns(c.value, { bold: true })).map((r, j) => runText(r, ctx.e, $, `v${i}-${j}`))}</Text>)}
      {cellRow('gfx', (c, i) => <Text>{c.gfx.map((r, j) => runText(r, ctx.e, $, `g${i}-${j}`))}</Text>)}
    </Box>
  )
}

/**
 * A 10-wide bar for `value` of `total`: the fill in `color` (default the accent), the rest in `subtle` (`bar10`).
 * @deprecated HUD v2 (`━ ─`). Neo draws `bar(value, total, 10)` from fit.ts (`▮ ▯`).
 */
export function barCell(value: number, total: number, color: string = C.live): Run[] {
  const b = bar10(value, total)
  return [
    { text: b.fill, color },
    { text: b.rest, color: C.subtle },
  ].filter(r => r.text !== '')
}

/** A 10-wide stacked bar: one `━` run per part by largest remainder (`stack10`), each in its colour (absent, dim); all zero, the rest. */
export function stackCell(parts: { count: number; color?: string }[]): Run[] {
  const widths = stack10(parts.map(p => p.count))
  if (widths.every(w => w === 0)) return [{ text: '─'.repeat(DIAGRAM), color: C.subtle }]
  return parts
    .map((p, i): Run => ({ text: '━'.repeat(widths[i] ?? 0), ...(p.color !== undefined ? { color: p.color } : { dim: true }) }))
    .filter(r => r.text !== '')
}

/**
 * A 10-wide sparkline of `buckets` (`spark10`) in `color` (default the accent).
 * @deprecated Use `spark(buckets, 10)` (or 22 in a deck) from fit.ts.
 */
export function sparkCell(buckets: number[], color: string = C.live): Run[] {
  return [{ text: spark10(buckets), color }]
}

/** One footer hint: a hotkeyed Button (so its key is armed), or an engine key as dim text (`↵ open`, `esc prompt`). */
export type Hint = { hotkey: string; label: string; key: string; onPress: () => void | Promise<void> } | { text: string }

const hintWidth = (h: Hint): number => ('hotkey' in h ? h.hotkey.length + 2 + h.label.length : h.text.length)

/**
 * The hints that fit a footer of `cols`: it draws from column 2 with 3 columns
 * between them, and at most 3. A narrow pane gives up the engine-key text
 * (`↵ open`) first, then hints from the end, so the armed hotkeys stay as long
 * as they can. One hint always stays.
 */
export function fitHints(hints: Hint[], cols: number): Hint[] {
  const kept = hints.slice(0, 3)
  const total = (): number => GRID.margin + kept.reduce((n, h) => n + hintWidth(h), 0) + 3 * Math.max(0, kept.length - 1)
  while (kept.length > 1 && total() > cols) {
    const text = kept.findIndex(h => !('hotkey' in h))
    kept.splice(text >= 0 ? text : kept.length - 1, 1)
  }
  return kept
}

/**
 * The footer: at most 3 dim hints from column 2, 3 apart. Drawn only while
 * the pane has the focus (`ctx.isFocused`); otherwise nothing.
 *
 * @example footer(ctx, $, [{ hotkey: 'n', label: 'next error', key: 'hint-n', onPress: nextError }, { text: 'esc prompt' }])
 */
export function footer(ctx: ViewCtx, $: EngineInterface, hints: Hint[]): RenderElement | null {
  if (ctx.isFocused !== true) return null
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  return (
    <Box key="footer" flexDirection="row" paddingLeft={GRID.margin} columnGap={3}>
      {fitHints(hints, ctx.cols).map((hint, i) =>
        'hotkey' in hint ? (
          <Button key={hint.key} hotkey={hint.hotkey} plain dimColor onPress={hint.onPress}>
            {hint.label}
          </Button>
        ) : (
          <Text key={`hint-${i}`} dimColor>
            {hint.text}
          </Text>
        ),
      )}
    </Box>
  )
}

/**
 * The dim `+ n more` line under a capped list: `+` at 2 and the text at 4,
 * both moved 2 per tree depth. `what` replaces `more` (`more done`, `done`,
 * `more in this turn`).
 *
 * @example more(ctx, $, 6)            // '  + 6 more'
 * @example more(ctx, $, 2, 'done', 1) // '    + 2 done'
 */
export function more(ctx: ViewCtx, $: EngineInterface, n: number, what = 'more', depth: 0 | 1 | 2 = 0): RenderElement {
  const { Text } = $.ui.resolve(ctx.e)
  const indent = 2 * depth
  const text = line([at(COL.glyph + indent, '+'), at(COL.name + indent, wordFit(`${n} ${what}`, ctx.cols - COL.name - indent))])
  return (
    <Text key={`more-${what}-${depth}`} dimColor wrap="truncate-end">
      {text}
    </Text>
  )
}

/** One empty row: the rhythm between sections and around an opened row. */
export function blank(ctx: ViewCtx, $: EngineInterface, key?: string): RenderElement {
  const { Text } = $.ui.resolve(ctx.e)
  return <Text key={key}>{' '}</Text>
}

// ---------- Neo: pill and deck ----------

/**
 * A pill: ` WORD ` as one Text, bold, in `inverseText` on `color`
 * (`backgroundColor`), one space of padding each side (fit.ts `pillRun`).
 * Words: ` WORKING ` (`C.live`), ` WAITING ` / ` NEEDS YOU ` (`C.wait`),
 * ` ALL DONE ` / ` IDLE ` (`C.subtle`), the chosen filter chip (`C.live`).
 * Inside a deck label or cell, pass `[pillRun(word, color)]` as the runs.
 *
 * @example pill('NEEDS YOU', C.wait, ctx.e, $, 'needs-pill')
 */
export function pill(word: string, color: string, e: RenderInput, $: EngineInterface, key?: string): RenderElement {
  return runText(pillRun(word, color), e, $, key)
}

/**
 * One placed cell of a deck row.
 * - `col`: its start column: `DECK.gauge` (14), `cellCol(2)` (26),
 *   `DECK.value` (38), `DECK.aside` (50), or a band's further cells (62, 74, …).
 * - `runs`: a string (plain) or styled runs (`bar`, `pips`, `spark`,
 *   `crewRow`, `meter`, `[pillRun(…)]`, bold text…).
 * - `narrow`: drawn instead when `runs` does not fit its room, e.g. a
 *   10-cell bar or trace for a 22-cell one.
 * - `whole`: never cut: when neither form fits, the cell is left out. Set it
 *   on every gauge; text cells (FOCUS, NEXT) leave it off and are cut at a word.
 */
export type DeckCell = { col: number; runs: string | Run[]; narrow?: Run[]; whole?: boolean }

/**
 * One deck row: a dim caps label at 2 (a string; runs keep their style, e.g.
 * a pill or a bold focus line) and its cells. With `onPress` the label and
 * cells are one plain Button keyed `key` (strings and Texts only: no Box in
 * a Button). `null` in a deck's rows is a rail-only row (the Now deck's
 * blank rail row).
 */
export type DeckRow = {
  key?: string
  label?: string | Run[]
  cells?: DeckCell[]
  onPress?: () => void | Promise<void>
  autoFocus?: boolean
}

/** Options of `deck`. */
export type DeckOpts = {
  /** The deck's address: its Box key and the prefix of its rows' keys. Default `deck`. */
  key?: string
  /** `left`: the left bracket only (the strip and slim); no right rail and no padding. Default `both`. */
  side?: 'both' | 'left'
  /** `warning`: corners and rails in `warning` (something waits on the person). Default: accent corners, `subtle` rails. */
  tone?: 'accent' | 'warning'
  /** The width the deck is laid out for, e.g. 50 for the strip's cells 1 to 4. Default `ctx.cols`. */
  cols?: number
}

const runsWidth = (rs: Run[]): number => rs.reduce((n, r) => n + r.text.length, 0)

/**
 * The cells a deck row keeps at `cols`, with their runs: below 62 columns a
 * cell at the aside (50) or further is dropped; below 50 the value (38) too.
 * Each cell's room ends 2 before the next kept cell, or at the content edge
 * (`cols − 2` with a right rail, so one blank column precedes it; `cols`
 * with the left bracket only). A cell that does not fit takes `narrow`, or
 * is dropped when `whole`, or is cut at a word.
 */
function deckCells(cells: DeckCell[], cols: number, edge: number): (Run & { col: number })[][] {
  const tiered = cells
    .filter(c => c.col > DECK.label && c.col < edge)
    .filter(c => !(cols < 62 && c.col >= DECK.aside) && !(cols < 50 && c.col >= DECK.value))
    .sort((a, b) => a.col - b.col)
  const out: (Run & { col: number })[][] = []
  tiered.forEach((c, i) => {
    const next = tiered[i + 1]
    const room = Math.min(next !== undefined ? next.col - 2 : edge, edge) - c.col
    if (room <= 0) return
    const full = asRuns(c.runs)
    let runs: Run[] | undefined
    if (runsWidth(full) <= room) runs = full
    else if (c.narrow !== undefined && runsWidth(c.narrow) <= room) runs = c.narrow
    else if (c.whole !== true) runs = fitRuns(full, room) as Run[]
    if (runs === undefined || runsWidth(runs) === 0) return
    const placedRuns: (Run & { col: number })[] = []
    let col = c.col
    for (const r of runs) {
      if (r.text === '') continue
      placedRuns.push({ ...r, col })
      col += r.text.length
    }
    out.push(placedRuns)
  })
  return out
}

/**
 * The rows of a deck, each a row Box (see `deck`). Use it where a deck sits
 * beside other content row by row (the strip); otherwise use `deck`.
 */
export function deckRows(ctx: ViewCtx, $: EngineInterface, rows: (DeckRow | null)[], opts: DeckOpts = {}): RenderElement[] {
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  const cols = Math.max(4, opts.cols ?? ctx.cols)
  const side = opts.side ?? 'both'
  const key = opts.key ?? 'deck'
  const corner = opts.tone === 'warning' ? C.wait : C.live
  const rail = opts.tone === 'warning' ? C.wait : C.subtle
  const edge = side === 'both' ? cols - 2 : cols
  const n = rows.length
  return rows.map((r, i) => {
    const one = n === 1
    const first = i === 0
    const last = i === n - 1
    const leftGlyph = one ? RAIL.mid : first ? RAIL.top : last ? RAIL.bottom : RAIL.mid
    const rightGlyph = one ? RAIL.mid : first ? RAIL.topRight : last ? RAIL.bottomRight : RAIL.mid
    const color = one || first || last ? corner : rail
    const cells = deckCells(r?.cells ?? [], cols, edge)
    const segs: (Run & { col: number })[] = []
    if (r?.label !== undefined) {
      const labelEnd = cells.length > 0 ? (cells[0]?.[0]?.col ?? edge) - 2 : edge
      const room = Math.max(0, labelEnd - DECK.label)
      const full = asRuns(r.label, { dim: true })
      // Cut only when it overflows: `fitRuns` collapses spaces, which would strip a pill's padding.
      const label = runsWidth(full) <= room ? full : (fitRuns(full, room) as Run[])
      let col: number = DECK.label
      for (const l of label) {
        if (l.text !== '') segs.push({ ...l, col })
        col += l.text.length
      }
    }
    for (const c of cells) segs.push(...c)
    const rowKey = r?.key ?? `${key}-row-${i}`
    const body: (RenderElement | string)[] = laidOut(segs, DECK.label, ctx.e, $, `${rowKey}-`)
    if (side === 'both') {
      const tail = segs[segs.length - 1]
      const end = tail !== undefined ? tail.col + tail.text.length : DECK.label
      const pad = ' '.repeat(Math.max(0, cols - 1 - end))
      if (pad !== '') body.push(pad)
    }
    return (
      <Box key={`${key}-${r?.key ?? i}`} flexDirection="row">
        <Text color={color}>{`${leftGlyph} `}</Text>
        {r?.onPress !== undefined ? (
          <Button key={rowKey} plain onPress={r.onPress} autoFocus={r.autoFocus === true ? true : undefined}>
            {body}
          </Button>
        ) : (
          <Text key={rowKey} wrap="truncate-end">
            {body}
          </Text>
        )}
        {side === 'both' ? <Text color={color}>{rightGlyph}</Text> : null}
      </Box>
    )
  })
}

/**
 * A deck: an instrument block held by twin brackets (spec "Identity"), no
 * top or bottom edge. Each row is a row Box of a width-2 rail Text (`┏ `,
 * `┃ `, `┗ `), the label and placed cells (one Text, or one plain Button when
 * the row has `onPress`), padded so the right-rail Text (`┓ ┃ ┛`) lands on the
 * last column. Corners take the accent, the rails between them `subtle`;
 * `tone: 'warning'` turns both `warning`. One row folds to `┃ … ┃` in the
 * tone. `side: 'left'` draws the left bracket only.
 *
 * Columns at 62: rail 0, label 2 (dim, cut to 10), gauge 14 (≤ 22, to 35),
 * value 38 (≤ 10), aside 50 (≤ 10, ends by 59), rail 61. Below 62 the aside
 * goes, below 50 the value goes; a gauge that does not fit takes `narrow` or
 * goes (`whole`); text is cut at a word. Nothing for no rows.
 *
 * @example
 * deck(ctx, $, [
 *   { label: 'FOCUS', cells: [{ col: DECK.gauge, runs: [{ text: now.focus, bold: true }] }, { col: DECK.aside, runs: [{ text: '20s', dim: true }] }] },
 *   null,
 *   { key: 'deck-crew', label: 'CREW', onPress: openAgents, cells: [
 *     { col: DECK.gauge, runs: crewRow(pods), whole: true },
 *     { col: DECK.value, runs: [{ text: '2', bold: true }, { text: ' live', dim: true }] },
 *   ] },
 *   { label: 'STEPS', cells: [{ col: DECK.gauge, runs: spark(b22, 22), narrow: spark(b22, 10), whole: true }] },
 * ], { key: 'now' })
 */
export function deck(ctx: ViewCtx, $: EngineInterface, rows: (DeckRow | null)[], opts: DeckOpts = {}): RenderElement | null {
  if (rows.length === 0) return null
  const { Box } = $.ui.resolve(ctx.e)
  return (
    <Box key={opts.key ?? 'deck'} flexDirection="column">
      {deckRows(ctx, $, rows, opts)}
    </Box>
  )
}

// ---------- Neo Rich: instruments, the rich deck, the hero, detail pages ----------

/**
 * One instrument: a Raster on a rich surface, its text form elsewhere, in the
 * same box. `frames` draws it (one frame still, two for a pulse), run only
 * when `sig` changes (paint.ts `track`). `fallback` is its text form, one
 * runs list a row; `inst` pads or cuts each row to `columns` and gives it
 * exactly `rows` rows, so the two forms swap without moving anything.
 * `spriteOf` (style.ts) returns everything but `key`.
 */
export type InstSpec = {
  key: string
  columns: number
  rows: number
  sig: string
  frames: () => Grid[]
  fallback: Run[][]
}

/** The text form of an instrument: `rows` rows, each exactly `columns` wide; a row too long is cut on a word (`fitRuns`). */
function fallbackRows(s: { columns: number; rows: number; fallback: Run[][] }): Run[][] {
  const out: Run[][] = []
  for (let i = 0; i < s.rows; i++) {
    const row: Run[] = []
    let used = 0
    for (const r of fitRuns(s.fallback[i] ?? [], s.columns)) {
      if (r.text === '') continue
      row.push(r as Run)
      used += r.text.length
    }
    if (used < s.columns) row.push({ text: ' '.repeat(s.columns - used) })
    out.push(row)
  }
  return out
}

/**
 * An instrument (spec "inst"): a Raster when `ctx.look` is `rich` and the
 * surface's table has one, else its same-size text fallback. Either way it
 * is a Box of its own, `columns` wide and `rows` tall, so nothing pressable
 * ever shares its cells: put Buttons beside it, never in it. A Raster's
 * cells come from paint.ts (`track` under `ctx.site`), so a pulse blits on
 * the clock without a redraw. Throws when the frames are not `columns` x `rows`.
 *
 * @example inst(ctx, $, { key: 'lead', ...spriteOf(agent, ctx.now) })
 */
export function inst(ctx: ViewCtx, $: EngineInterface, s: InstSpec): RenderElement {
  const table = $.ui.resolve(ctx.e)
  if (ctx.look === 'rich' && 'Raster' in table) {
    const { Box, Raster } = table
    const p = track(ctx.site ?? 'mission-control', s.key, s.sig, s.frames)
    if (p.columns !== s.columns || p.rows !== s.rows) {
      throw new Error(`instrument ${s.key} draws ${p.columns}x${p.rows}, not ${s.columns}x${s.rows}`)
    }
    return (
      <Box key={`inst-${s.key}`} width={s.columns} height={s.rows} flexShrink={0}>
        <Raster key={s.key} columns={p.columns} rows={p.rows} cells={p.cells} />
      </Box>
    )
  }
  const { Box, Text } = table
  return (
    <Box key={`inst-${s.key}`} flexDirection="column" width={s.columns} flexShrink={0}>
      {fallbackRows(s).map((r, i) => (
        <Text key={`${s.key}-text-${i}`}>{r.map((x, j) => runText(x, ctx.e, $, `${s.key}-t${i}-${j}`))}</Text>
      ))}
    </Box>
  )
}

/** The frame's colour: iris, amber while something waits (`tone: 'warning'`). */
export const frameHue = (tone: DeckOpts['tone']): Hue => (tone === 'warning' ? 'amber' : 'iris')

/** What the rich deck's lintel carries: the state pill and one dim readout at the right. */
export type FrameSpec = {
  /** The state pill hanging from the line (` WORKING `); in the text form a Text pill. */
  pill?: string
  /** The pill's colour as a theme key (`C.live`, `C.wait`, …) for the text form; the Raster takes `pillHue`. */
  pillColor?: string
  pillHue?: Hue | 'mute'
  /** The pill's first column: 13 (the gauge column, less its cap) when absent; 2 in a narrow compartment. */
  pillCol?: number
  /** Cells of the clamp after its corner: 3 when absent, 1 in a narrow compartment. */
  clamp?: number
  /** One dim readout at the right (`turn 6 41m`, `agent 3 of 6`). */
  right?: string
  /** The readout in amber rather than dim (the cache about to go cold). */
  rightAmber?: boolean
}

/**
 * The one lintel guard (spec "Frame"): the pill and the readout a lintel of
 * `width` can draw without either touching the other or the clamp. The pill
 * is dropped when it does not fit; the readout is drawn whole in the room
 * `lintelRoom` leaves after the pill, or left out (a readout is never cut).
 * Both forms of `lintelInst` draw exactly what this returns, so a caller
 * passes the whole readout and never guards it itself.
 */
export function frameFit(width: number, f: FrameSpec): { pill?: string; right?: string } {
  const room = lintelRoom(width, f)
  const right = f.right !== undefined && [...f.right].length <= room.right ? f.right : ''
  return { ...(room.pill && f.pill !== undefined ? { pill: f.pill } : {}), ...(right !== '' ? { right } : {}) }
}

/** One line of the hero: a Text, or a plain Button (the running step, the BUDGET line). `lines: 2` wraps it by word onto two rows (the focus). */
export type HeroLine = { key?: string; runs: string | Run[]; onPress?: () => void | Promise<void>; lines?: 1 | 2 }

/** What `hero` draws: the character in the label column, the lines at the gauge, and a right instrument (the rings at 39) when it fits. */
export type HeroSpec = { key: string; who: InstSpec; lines: HeroLine[]; right?: InstSpec }

/**
 * @deprecated Neo Rich. The cockpit's Now header is `header`.
 *
 * The Now hero (spec "Screens: Now"): `who` (the lead's large character,
 * 9 x 4) at column 2, the lines from the gauge column (14), each a Text or a
 * plain Button cut by word to its room, and `right` (three rings, 23 x 4)
 * at `DECK.ring` (39) when the width holds it, else left out and the lines
 * take the width. Each instrument is its own Box beside the lines, so no
 * Button shares a cell with a Raster. In the text look the instruments draw
 * their same-size fallbacks.
 *
 * @example hero(ctx, $, { key: 'hero', who: { key: 'lead', ...spriteOf(main, ctx.now) }, lines: [{ runs: focus, lines: 2 }, { key: 'hero-step', runs: step, onPress }], right: rings })
 */
export function hero(ctx: ViewCtx, $: EngineInterface, spec: HeroSpec): RenderElement {
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  const cols = ctx.cols
  const right = spec.right !== undefined && DECK.ring + spec.right.columns <= cols ? spec.right : undefined
  const room = Math.max(1, (right !== undefined ? DECK.ring - 2 : cols) - DECK.gauge)
  const lines: RenderElement[] = []
  spec.lines.forEach((l, i) => {
    const key = l.key ?? `${spec.key}-line-${i}`
    if (typeof l.runs === 'string' && l.lines === 2 && l.onPress === undefined) {
      wrapWords(l.runs, room, 2).forEach((t, j) => {
        lines.push(
          <Text key={`${key}-${j}`} bold>
            {t}
          </Text>,
        )
      })
      return
    }
    const runs = fitRuns(asRuns(l.runs), room) as Run[]
    const body = runs.map((r, j) => runText(r, ctx.e, $, `${key}-r${j}`))
    lines.push(
      l.onPress !== undefined ? (
        <Button key={key} plain onPress={l.onPress}>
          {body}
        </Button>
      ) : (
        <Text key={key} wrap="truncate-end">
          {body}
        </Text>
      ),
    )
  })
  return (
    <Box key={spec.key} flexDirection="row">
      <Box key={`${spec.key}-who`} width={DECK.gauge} paddingLeft={DECK.label} flexShrink={0}>
        {inst(ctx, $, spec.who)}
      </Box>
      <Box key={`${spec.key}-lines`} flexDirection="column" width={right !== undefined ? DECK.ring - DECK.gauge : room}>
        {lines}
      </Box>
      {right !== undefined ? inst(ctx, $, right) : null}
    </Box>
  )
}

/**
 * One labelled row of a detail page: the dim caps label at 2, the value at
 * 14 wrapped in full (never cut), and up to two cells on its first line at
 * 38 and 50 (`DeckCell`s: `started`, `13:22:08`). With `onPress` the first
 * line is one plain Button keyed `key` (the TASK of an agent, the AGENT of a
 * step).
 */
export type PageField = {
  key?: string
  label: string
  value: string | Run[]
  cells?: DeckCell[]
  onPress?: () => void | Promise<void>
}

/** A block of a detail page under its section label: wrapped text (in full, at 4), a list of rows (the pane scrolls), or prepared lines. */
export type PageBlock = {
  key: string
  label: string
  heads?: { metric?: string; time?: string }
  text?: string
  rows?: RowSpec[]
  lines?: Run[][]
}

/**
 * What a detail page draws (spec "Detail pages"). `frame` names the state
 * (the pill word, drawn in plain words) and the readout; `title` bold and
 * `body` dim, both wrapped in full; `fields` the labelled rows; `blocks` the sections; `actions` the
 * hotkeyed row (`b: back` is added last by `page`).
 */
export type PageSpec = {
  key: string
  frame?: FrameSpec & { tone?: DeckOpts['tone'] }
  title?: string
  body?: string
  fields?: PageField[]
  blocks?: PageBlock[]
  actions?: Action[]
}

/**
 * `text` wrapped in full into lines of at most `room` for a page: by word, each
 * newline kept. A word wider than a line breaks at a `/` (the slash ends the
 * piece) before it breaks anywhere else, so a path never splits mid-name; only
 * a piece with no `/` that is longer than `room` is cut at the room. Never `…`.
 *
 * @example wrapPage('Edit middleware/rateLimit.ts now', 14) // ['Edit', 'middleware/', 'rateLimit.ts', 'now']
 */
export function wrapPage(text: string, room: number): string[] {
  if (room <= 0 || text.trim() === '') return []
  const out: string[] = []
  for (const para of text.replace(/\r\n?/g, '\n').split('\n')) {
    const words = para.replace(/[\t ]+/g, ' ').trim().split(' ').filter(w => w !== '')
    if (words.length === 0) {
      out.push('')
      continue
    }
    let cur = ''
    for (const word of words) {
      if (cur !== '' && cur.length + 1 + word.length <= room) {
        cur = `${cur} ${word}`
        continue
      }
      if (cur !== '') {
        out.push(cur)
        cur = ''
      }
      if (word.length <= room) {
        cur = word
        continue
      }
      let acc = ''
      for (let piece of word.match(/[^/]*\/|[^/]+/g) ?? []) {
        while (piece.length > room) {
          if (acc !== '') out.push(acc)
          acc = ''
          out.push(piece.slice(0, room))
          piece = piece.slice(room)
        }
        if (acc.length + piece.length <= room) acc += piece
        else {
          out.push(acc)
          acc = piece
        }
      }
      cur = acc
    }
    if (cur !== '') out.push(cur)
  }
  return out
}

/** A string, or runs, as whole lines of at most `room`: runs that fit stay one line; longer ones wrap as plain text. Never `…`. */
function fullLines(v: string | Run[], room: number, style: Omit<Run, 'text'> = {}): Run[][] {
  const runs = asRuns(v, style)
  const joined = runs.map(r => r.text).join('')
  if (joined.length <= room && !joined.includes('\n')) return [runs]
  const { text: _text, ...first } = runs[0] ?? { text: '' }
  return wrapPage(joined, room).map(t => [{ ...first, text: t }])
}

/** The actions as rows of hotkeyed Buttons from column 2, three columns apart, wrapping to more rows rather than dropping any. */
function actionRows(cols: number, actions: Action[]): Action[][] {
  const out: Action[][] = []
  let cur: Action[] = []
  let used = GRID.margin
  for (const a of actions) {
    if (cur.length > 0 && used + 3 + actionWidth(a) > cols) {
      out.push(cur)
      cur = []
      used = GRID.margin
    }
    used += (cur.length > 0 ? 3 : 0) + actionWidth(a)
    cur.push(a)
  }
  if (cur.length > 0) out.push(cur)
  return out
}

/** `WAITING FOR YOU` as `Waiting for you`. */
const sentenceCase = (s: string): string => (s === '' ? '' : s[0]!.toUpperCase() + s.slice(1).toLowerCase())

/**
 * A detail page (spec "Detail pages"; binding rule 4; cockpit palette, section
 * heads and plain words): replaces the tab's list while `ui.page` is set.
 * Nothing on it is cut: every value and block wraps in full (`wrapPage`, so no
 * line ends in `…`), a list draws every row and the pane scrolls. A page holds
 * no Raster of its own for a critter: its text form (a state glyph, the type)
 * is what a block draws. Top to bottom:
 * - the frame's top (`frameTopInst`, no pill) and, when `frame` is given, one
 *   row: the state in plain words (`Working`, `Failed`), dim, and the readout
 *   (`task 3 of 14`) flush right
 * - `title` bold and `body` dim, wrapped from column 2
 * - `fields`: a dim sentence-case label at 2, the value from 14 wrapped,
 *   cells at 38 and 50
 * - the frame's foot, then each block after one blank row: a cockpit
 *   `section(label, heads)`, then its text (wrapped at 4), rows or lines
 * - one blank row, then the actions with `b: back` last (keyed `page-back`)
 *
 * @example page(ctx, $, { key: 'agent-page', frame: { pill: 'WORKING', right: 'agent 3 of 6' }, title: a.description, fields: [{ label: 'Agent', value: a.type }], blocks: [{ key: 'steps', label: 'Steps', rows }], actions })
 */
export function page(ctx: ViewCtx, $: EngineInterface, p: PageSpec): RenderElement {
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  const cols = Math.max(DECK.gauge + 8, ctx.cols)
  const { left } = edges(cols)
  const ground = ctx.ground ?? 'night'
  // Amber only for a real permission: the WAITING state.
  const asking = p.frame?.pill === 'WAITING'
  const tone: Tone4 = asking ? 'amber' : 'iris'
  const out: RenderElement[] = []
  const lineText = (key: string, col: number, runs: Run[]): RenderElement => (
    <Text key={key}>
      {' '.repeat(col)}
      {runs.map((r, j) => runText(r, ctx.e, $, `${key}-${j}`))}
    </Text>
  )

  // The frame's top, and the state in plain words with the readout.
  if (p.frame !== undefined) {
    out.push(inst(ctx, $, frameTopInst(`${p.key}-lintel`, cols, tone, ground)))
    const word = p.frame.pill !== undefined ? sentenceCase(p.frame.pill) : ''
    const wordStyle: Omit<Run, 'text'> = asking ? { color: CK.ask } : p.frame.pillColor === C.fail ? { color: CK.fail } : { dim: true }
    const room = cols - 2 * left
    const right: Run[] = p.frame.right !== undefined && p.frame.right.length + word.length + 3 <= room ? [{ text: p.frame.right, dim: true }] : []
    if (word !== '' || right.length > 0) {
      out.push(lineText(`${p.key}-state`, left, spread(word !== '' ? [{ text: word, ...wordStyle }] : [], right, room)))
    }
  }

  // The title and body.
  const textCol = left
  const headDrawn = (p.title ?? '') !== '' || (p.body ?? '') !== '' || p.frame?.pill !== undefined || p.frame?.right !== undefined
  if (p.title !== undefined && p.title !== '') {
    fullLines(p.title, cols - textCol - left, { bold: true }).forEach((l, i) => out.push(lineText(`${p.key}-title-${i}`, textCol, l)))
  }
  if (p.body !== undefined && p.body !== '') {
    fullLines(p.body, cols - textCol - left, { dim: true }).forEach((l, i) => out.push(lineText(`${p.key}-body-${i}`, textCol, l)))
  }
  if (headDrawn && (p.fields ?? []).length > 0) out.push(blank(ctx, $, `${p.key}-gap-fields`))

  // The labelled rows.
  ;(p.fields ?? []).forEach((f, i) => {
    const fk = f.key ?? `${p.key}-field-${i}`
    const cells = deckCells((f.cells ?? []).filter(c => c.col >= DECK.value), cols, cols)
    const valueEnd = cells.length > 0 ? (cells[0]?.[0]?.col ?? cols) - 2 : cols
    const lines = fullLines(f.value, Math.max(1, valueEnd - DECK.gauge))
    const label: Run & { col: number } = { col: left, text: wordFit(f.label, DECK.gauge - 2 - left), dim: true }
    lines.forEach((l, j) => {
      const segs: (Run & { col: number })[] = []
      if (j === 0) segs.push(label)
      let col: number = DECK.gauge
      for (const r of l) {
        if (r.text !== '') segs.push({ ...r, col })
        col += r.text.length
      }
      if (j === 0) for (const c of cells) segs.push(...c)
      const body = laidOut(segs, 0, ctx.e, $, `${fk}-${j}-`)
      out.push(
        j === 0 && f.onPress !== undefined ? (
          <Button key={fk} plain onPress={f.onPress}>
            {body}
          </Button>
        ) : (
          <Text key={j === 0 ? fk : `${fk}-${j}`}>{body}</Text>
        ),
      )
    })
  })

  // The frame's foot.
  if (p.frame !== undefined) out.push(inst(ctx, $, frameFootInst(`${p.key}-sill`, cols, tone, ground)))

  // The blocks.
  for (const b of p.blocks ?? []) {
    out.push(blank(ctx, $, `${p.key}-${b.key}-gap`))
    const sum = [b.heads?.metric, b.heads?.time].filter((x): x is string => x !== undefined && x !== '').join('   ')
    out.push(section(ctx, $, b.label, sum === '' ? undefined : sum, { key: `${p.key}-${b.key}-sec` }))
    if (b.text !== undefined) {
      wrapPage(b.text, cols - COL.name - left).forEach((t, i) => out.push(lineText(`${p.key}-${b.key}-t${i}`, COL.name, [{ text: t }])))
    }
    for (const r of b.rows ?? []) out.push(row(ctx, $, r))
    ;(b.lines ?? []).forEach((l, i) => {
      fullLines(l, cols - COL.name - left).forEach((w, j) => out.push(lineText(`${p.key}-${b.key}-l${i}-${j}`, COL.name, w)))
    })
  }

  // The actions, `b: back` last: hotkeyed Buttons the engine draws as `g: chat`.
  const actions: Action[] = [...(p.actions ?? []), { hotkey: 'b', label: 'back', key: 'page-back', onPress: () => closePage($) }]
  out.push(blank(ctx, $, `${p.key}-actions-gap`))
  actionRows(cols, actions).forEach((as, i) =>
    out.push(
      <Box key={`${p.key}-actions-${i}`} flexDirection="row" paddingLeft={left} columnGap={3}>
        {as.map(a => (
          <Button key={a.key} hotkey={a.hotkey} plain dimColor onPress={a.onPress}>
            {a.label}
          </Button>
        ))}
      </Box>,
    ),
  )
  return (
    <Box key={p.key} flexDirection="column">
      {out}
    </Box>
  )
}

/**
 * The terminal rows a drawn element takes, laid out as the pane lays it: a
 * column Box stacks its children, a row Box (the default) is as tall as its
 * tallest child, a Box with a `height` is that tall, `display: 'none'` takes
 * none, and anything else (a Text, a Button, a Raster by its `rows`) is one
 * row or its own size. A tab measures its deck and fixed parts with it, so
 * its lists get the rest (binding rule 2).
 */
export function heightOf(node: unknown): number {
  if (node === null || node === undefined || typeof node === 'boolean') return 0
  if (typeof node === 'string' || typeof node === 'number') return String(node).split('\n').length
  if (Array.isArray(node)) return node.reduce((n: number, k) => n + heightOf(k), 0)
  const el = node as { type?: unknown; props?: Record<string, unknown>; children?: unknown }
  const props = el.props ?? {}
  if (typeof props.height === 'number') return props.height
  if (typeof props.rows === 'number' && el.type === 'Raster') return props.rows
  if (el.type !== 'Box') return 1
  if (props.display === 'none') return 0
  const raw = el.children ?? props.children
  const kids = (Array.isArray(raw) ? raw.flat(Infinity) : [raw]).filter(k => k !== null && k !== undefined && typeof k !== 'boolean')
  if (props.flexDirection === 'column' || props.flexDirection === 'column-reverse') return kids.reduce((n: number, k) => n + heightOf(k), 0)
  return kids.reduce((n: number, k) => Math.max(n, heightOf(k)), 0)
}

// ---------- the cockpit (cockpit spec "Spacing and type", rulings R9, R22, R25, R33) ----------
//
// The parts every cockpit screen is built from. Each draws whole rows inside
// the content columns (`edges`: 2 to 59 at 62): nothing but a frame Raster
// enters the gutters, which stay for the `▍` marker and `◂`. No caps labels,
// no `┌` corners. Four voices: bold ink (answers), ink (names), dim (labels,
// times), the pill (state).

/** The runs, padded with spaces to exactly `cols` wide (cut on a word when longer). */
function padTo(runs: Run[], cols: number): Run[] {
  const kept = (fitRuns(runs, cols) as Run[]).filter(r => r.text !== '')
  const used = kept.reduce((n, r) => n + r.text.length, 0)
  return used < cols ? [...kept, { text: ' '.repeat(cols - used) }] : kept
}

/** `left` cut to leave `right` (and two spaces) room, then `right` flush at the end of `cols`. */
function spread(left: Run[], right: Run[], cols: number): Run[] {
  const rw = right.reduce((n, r) => n + r.text.length, 0)
  if (rw === 0) return padTo(left, cols)
  if (rw + 2 > cols) return padTo(left, cols)
  const l = (fitRuns(left, cols - rw - 2) as Run[]).filter(r => r.text !== '')
  const lw = l.reduce((n, r) => n + r.text.length, 0)
  return [...l, { text: ' '.repeat(cols - lw - rw) }, ...right]
}

const runsOf = (v: string | Run[] | Run | undefined, style: Omit<Run, 'text'> = {}): Run[] =>
  v === undefined ? [] : typeof v === 'string' ? (v === '' ? [] : [{ text: v, ...style }]) : Array.isArray(v) ? v : [v]

const width = (runs: Run[]): number => runs.reduce((n, r) => n + r.text.length, 0)

/** A section's title tone: `ask` amber (Needs you), `dim` (Watch), `fail` red (Failed); plain bold ink when absent. */
export type SectionTone = 'ask' | 'dim' | 'fail'

/** Options of `section`. */
export type CockpitSectionOpts = {
  tone?: SectionTone
  /**
   * Shorter forms of the sum, the fullest first, for when the sum and the whole title do not fit together
   * ("1 + 1 waiting" for "1 working · 1 waiting"). The leading count alone is always the last resort.
   */
  short?: (string | Run[])[]
  /** The row's key (and with `onPress` the Button's): `sec-<title>` when absent. */
  key?: string
  /** The whole head is one plain Button (the title opens its tab). */
  onPress?: () => void | Promise<void>
  autoFocus?: boolean
}

/**
 * A cockpit section head (cockpit spec "A section head is one row"): the bold
 * sentence-case title at 2, a `─` hairline in `subtle`, the sum flush at the
 * right edge (59 at 62), one space either side of the hairline. A string sum
 * is dim; runs keep their style (`[{ text: '9', bold: true }, { text: ' of 14 done', dim: true }]`).
 * No sum: the hairline runs to the edge. No caps, no `┌`. The title is cut by
 * word only when the width cannot hold it beside the sum.
 *
 * @example section(ctx, $, 'To do', [{ text: '9', bold: true }, { text: ' of 14 done', dim: true }], { onPress: openTasks })
 * @example section(ctx, $, 'Needs you', [{ text: '1', color: CK.ask, bold: true }, { text: ' permission', color: CK.ask }], { tone: 'ask' })
 * @example section(ctx, $, 'Watch', 'no action needed', { tone: 'dim' })
 */
export function section(ctx: ViewCtx, $: EngineInterface, title: string, sum?: string | Run[], opts: CockpitSectionOpts = {}): RenderElement {
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  const { left, right } = edges(ctx.cols)
  const w = Math.max(1, right - left + 1)
  // F I5: the title is never the thing cut. The sum shortens first (its short forms, then its leading count),
  // then the hairline goes, then the sum, and only a title wider than the row is cut.
  const titleFit = nameFit(title, w)
  const forms: Run[][] = [runsOf(sum, { dim: true }), ...(opts.short ?? []).map(s => runsOf(s, { dim: true }))].filter(f => f.length > 0)
  const lead = forms[0]?.[0]
  if (lead !== undefined && /^d+$/.test(lead.text.trim())) forms.push([lead])
  const sumRuns = forms.find(f => titleFit.length + 3 + width(f) <= w) ?? forms.find(f => titleFit.length + 1 + width(f) <= w) ?? []
  const sw = width(sumRuns)
  const titleStyle: Omit<Run, 'text'> =
    opts.tone === 'ask' ? { bold: true, color: CK.ask } : opts.tone === 'fail' ? { bold: true, color: CK.fail } : opts.tone === 'dim' ? { bold: true, dim: true } : { bold: true }
  const t = titleFit
  const hair = w - t.length - (sw > 0 ? sw + 2 : 1)
  const runs: Run[] = [{ text: t, ...titleStyle }]
  if (hair >= 1) runs.push({ text: ' ' }, { text: '─'.repeat(hair), color: C.subtle })
  if (sw > 0) runs.push({ text: hair >= 1 ? ' ' : ' '.repeat(Math.max(1, w - t.length - sw)) }, ...sumRuns)
  const key = opts.key ?? `sec-${title}`
  const body = runs.map((r, i) => runText(r, ctx.e, $, `${key}-${i}`))
  return (
    <Box key={`row-${key}`} flexDirection="row">
      <Text>{' '.repeat(left)}</Text>
      {opts.onPress !== undefined ? (
        <Button key={key} plain onPress={opts.onPress} autoFocus={opts.autoFocus === true ? true : undefined}>
          {body}
        </Button>
      ) : (
        <Text key={key} wrap="truncate-end">
          {body}
        </Text>
      )}
    </Box>
  )
}

/** The cockpit lintel as an instrument: `frameTop` (clamp and hairline, no pill), as text `┏━━` and a `─` hairline. */
export function frameTopInst(key: string, width: number, tone: Tone4 = 'iris', ground: Ground = 'night', sweep?: number): InstSpec {
  // R36: the clean-run sweep lights a window of the hairline in the accent; absent, the plain lintel.
  const [from, to] = sweepCells(sweep, width)
  return {
    key,
    columns: width,
    rows: 1,
    sig: `frameTop:${width}:${tone}:${ground}:${accentName()}${to > from ? `:s${from}` : ''}`,
    frames: () => {
      const g = frameTop(width, { hue: tone, pal: palette(ground) })
      for (let i = from; i < to; i++) g.ht(i, 0, 'iris')
      return [g]
    },
    fallback: [
      to > from
        ? [
            { text: '┏━━'.slice(0, width), color: toneKey(tone) },
            { text: '─'.repeat(Math.max(0, from - 3)), color: C.subtle },
            { text: '━'.repeat(to - from), color: C.accent },
            { text: '─'.repeat(Math.max(0, width - to)), color: C.subtle },
          ]
        : [{ text: '┏━━'.slice(0, width), color: toneKey(tone) }, { text: '─'.repeat(Math.max(0, width - 3)), color: C.subtle }],
    ],
  }
}

/** The cockpit sill as an instrument: `frameFoot`, as text a `─` hairline and `━━┛`. */
export function frameFootInst(key: string, width: number, tone: Tone4 = 'iris', ground: Ground = 'night'): InstSpec {
  return {
    key,
    columns: width,
    rows: 1,
    sig: `frameFoot:${width}:${tone}:${ground}:${accentName()}`,
    frames: () => [frameFoot(width, { hue: tone, pal: palette(ground) })],
    fallback: [[{ text: '─'.repeat(Math.max(0, width - 3)), color: C.subtle }, { text: '━━┛'.slice(Math.max(0, 3 - width)), color: toneKey(tone) }]],
  }
}

/** One header gauge: its percentage and the word under it ("context", "this week", "5 hours"). */
export type Gauge = { pct: number; label: string }

/** A gauge figure's text style: ink, bold from 70 %, red from 90 % (R9). */
const figureStyle = (pct: number): Omit<Run, 'text'> => (pct >= 90 ? { color: CK.fail } : pct >= 70 ? { bold: true } : {})

/**
 * Up to two gauges as one instrument, `GAUGE_PAIR` (20 x 5: rings at 0 and
 * 11). As text (R22): each figure centred in the middle row; the words go
 * under it as Text either way.
 */
export function gaugesInst(key: string, gauges: readonly Gauge[], ground: Ground = 'night'): InstSpec {
  const shown = gauges.slice(0, 2)
  const mid: Run[] = []
  shown.forEach((g, i) => {
    const s = gaugeFigure(g.pct)
    const lead = Math.floor((GAUGE_RING.columns - s.length) / 2)
    const at = i * GAUGE_PAIR.pitch + lead
    const used = width(mid)
    mid.push({ text: ' '.repeat(Math.max(0, at - used)) }, { text: s, ...figureStyle(g.pct) })
  })
  const blank: Run[] = [{ text: ' '.repeat(GAUGE_PAIR.columns) }]
  return {
    key,
    columns: GAUGE_PAIR.columns,
    rows: GAUGE_PAIR.rows,
    sig: `gauges:${ground}:${accentName()}:${shown.map(g => Math.round(g.pct)).join(',')}`,
    frames: () => [gaugePair(shown.map(g => g.pct), palette(ground))],
    fallback: [blank, blank, mid, blank, blank],
  }
}

/** What `header` draws. */
export type HeaderSpec = {
  key: string
  /** The frame's and the pill's tone: iris (working), amber (a dialog waits), mint (all done), red (stopped). */
  tone?: Tone4
  /** The state pill: ` WORKING `, ` WAITING FOR YOU `, ` ALL DONE `, ` IDLE `, ` STOPPED `. */
  pill: string
  /** The pill's background as a theme key when it is not the tone's (` IDLE ` in `subtle`). */
  pillColor?: string
  /** Dim words after the pill: "41 min this turn". Runs keep their style (R7's bold quiet). */
  meta?: string | Run[]
  /** The lead's small critter at column 2 (`critterArgs('lead', state, …)`); none in the compact form. */
  critter?: CritterArgs
  /** The dim line above the headline: "Working on", "Paused on", "Finished". */
  kicker: string
  /** The headline: bold, wrapped at a word, 2 lines (3 in the compact form). */
  title: string
  /** The headline's first line becomes a plain Button. */
  onTitle?: () => void | Promise<void>
  /** The budget line under the critter: "620k of 1M used · cache warm 4:48". */
  budget?: string | Run[]
  onBudget?: () => void | Promise<void>
  /** Up to two gauges at columns 40 and 51 (at 62 columns and up); narrower, they join the budget line as words. */
  gauges?: Gauge[]
  /** The compact form at any width (F M13: a pane under 30 rows): no critter, gauges or budget line. */
  compact?: boolean
  ground?: Ground
}

/** Under this many columns the header is compact: no critter, no gauges, no budget line, the headline on up to 3 lines (slim). */
export const HEADER_COMPACT_UNDER = 40

/**
 * The cockpit header (cockpit spec "Header"; replaces `hero` and the deck rows):
 *
 *     row 0  the lintel (`frameTop`, the full width)
 *     row 1  the pill at 2, the meta 2 after it, dim
 *     row 2  (blank on the left; the gauges start)
 *     row 3  the critter at 2 (5 x 3 and its badge column), the kicker at 9
 *     row 4  the headline at 9, 29 wide, wrapped at a word
 *     row 5  its second line
 *     row 6  (blank on the left; the gauges end)
 *     row 7  the budget line at 2; each gauge's word centred under it
 *     row 8  the sill (`frameFoot`)
 *
 * Gauges are 9 x 5 at columns 40 and 51 and need 62 columns; narrower, the
 * headline takes the width to the right edge and the gauges become words on
 * the budget line where they fit whole ("context 62%"). Under 40 columns the
 * compact form draws the lintel, the pill (the meta flush right), a blank,
 * the kicker, the headline on up to 3 lines and the sill, all from column 1
 * or 2 (`edges`). The caller adds the blank row after the sill.
 *
 * @example header(ctx, $, { key: 'now', pill: 'WORKING', meta: '41 min this turn', critter: critterArgs('lead', 'working', { ground }), kicker: 'Working on', title: focus, budget, gauges: [{ pct: 62, label: 'context' }, { pct: 34, label: 'this week' }] })
 */
export function header(ctx: ViewCtx, $: EngineInterface, spec: HeaderSpec): RenderElement {
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  const cols = ctx.cols
  const { left, right } = edges(cols)
  const tone = spec.tone ?? 'iris'
  const ground = spec.ground ?? 'night'
  const content = right - left + 1
  const pill: Run = { text: ` ${spec.pill} `, color: CK.inverse, bg: spec.pillColor ?? toneKey(tone), bold: true }
  const meta = runsOf(spec.meta, { dim: true })
  const pad = (n: number): Run => ({ text: ' '.repeat(Math.max(0, n)) })
  const line = (k: string, runs: Run[]): RenderElement => (
    <Text key={k} wrap="truncate-end">
      {runs.map((r, i) => runText(r, ctx.e, $, `${k}-${i}`))}
    </Text>
  )
  const top = inst(ctx, $, frameTopInst(`${spec.key}-lintel`, cols, tone, ground, sweepShows(ctx) ? sweepFrame() : undefined))
  const foot = inst(ctx, $, frameFootInst(`${spec.key}-sill`, cols, tone, ground))

  if (cols < HEADER_COMPACT_UNDER || spec.compact === true) {
    const pillRow = meta.length > 0 && pill.text.length + 2 + width(meta) <= content ? spread([pill], meta, content) : padTo([pill], content)
    const lines = wrapWords(spec.title, content, 3)
    return (
      <Box key={spec.key} flexDirection="column">
        {top}
        {line(`${spec.key}-pill`, [pad(left), ...pillRow])}
        <Text key={`${spec.key}-gap`}> </Text>
        {line(`${spec.key}-kicker`, [pad(left), { text: wordFit(spec.kicker, content), dim: true }])}
        {lines.map((s, i) =>
          i === 0 && spec.onTitle !== undefined ? (
            <Box key={`${spec.key}-t${i}`} flexDirection="row">
              <Text>{' '.repeat(left)}</Text>
              <Button key={`${spec.key}-title`} plain onPress={spec.onTitle}>
                <Text bold>{s}</Text>
              </Button>
            </Box>
          ) : (
            line(`${spec.key}-t${i}`, [pad(left), { text: s, bold: true }])
          ),
        )}
        {foot}
      </Box>
    )
  }

  const gauges = (spec.gauges ?? []).slice(0, 2)
  // F M9: the gauges end at the content's right edge (column 40 at 62, as the mock), so on a wider pane they move with it.
  const gaugeAt = right + 1 - GAUGE_PAIR.columns
  const withGauges = gauges.length > 0 && gaugeAt >= COCKPIT.gauge
  const textCol = COCKPIT.text
  const textRoom = withGauges ? gaugeAt - textCol - 2 : right - textCol + 1
  const titleLines = wrapWords(spec.title, textRoom, 2)
  const titleEls: RenderElement[] = [0, 1].map(i => {
    const s = titleLines[i] ?? ''
    if (i === 0 && s !== '' && spec.onTitle !== undefined) {
      return (
        <Button key={`${spec.key}-title`} plain onPress={spec.onTitle}>
          <Text bold>{s}</Text>
        </Button>
      )
    }
    return (
      <Text key={`${spec.key}-title-${i}`} bold>
        {s === '' ? ' ' : s}
      </Text>
    )
  })
  const critterEl =
    spec.critter !== undefined ? inst(ctx, $, { key: `${spec.key}-who`, ...spec.critter }) : <Text key={`${spec.key}-who`}> </Text>
  const blockWidth = withGauges ? gaugeAt : cols
  const block = (
    <Box key={`${spec.key}-block`} flexDirection="row">
      <Box key={`${spec.key}-left`} flexDirection="column" width={blockWidth} flexShrink={0}>
        <Text key={`${spec.key}-above`}> </Text>
        <Box key={`${spec.key}-who-row`} flexDirection="row" paddingLeft={left}>
          <Box key={`${spec.key}-who-box`} width={textCol - left} flexShrink={0}>
            {critterEl}
          </Box>
          <Box key={`${spec.key}-text`} flexDirection="column" width={textRoom} flexShrink={0}>
            <Text key={`${spec.key}-kicker`} dimColor>
              {wordFit(spec.kicker, textRoom)}
            </Text>
            {titleEls}
          </Box>
        </Box>
        <Text key={`${spec.key}-below`}> </Text>
      </Box>
      {withGauges ? inst(ctx, $, gaugesInst(`${spec.key}-gauges`, gauges, ground)) : null}
    </Box>
  )
  // The budget line, and under each gauge its word (centred under its 9 cells).
  let budget = runsOf(spec.budget)
  const budgetRoom = withGauges ? gaugeAt - left - 2 : content
  if (!withGauges && gauges.length > 0) {
    for (const g of gauges) {
      const words: Run[] = [{ text: budget.length > 0 ? ' · ' : '', dim: true }, { text: `${g.label} `, dim: true }, { text: gaugeFigure(g.pct), ...figureStyle(g.pct) }]
      if (width(budget) + width(words) <= budgetRoom) budget = [...budget, ...words]
    }
  }
  budget = (fitRuns(budget, budgetRoom) as Run[]).filter(r => r.text !== '')
  const labels: Run[] = []
  if (withGauges) {
    gauges.forEach((g, i) => {
      const word = wordFit(g.label, GAUGE_RING.columns)
      const at = i * GAUGE_PAIR.pitch + Math.floor((GAUGE_RING.columns - word.length) / 2)
      labels.push(pad(at - width(labels)), { text: word, ...gaugeStyle(g.pct) })
    })
  }
  const budgetBody = budget.map((r, i) => runText(r, ctx.e, $, `${spec.key}-b${i}`))
  const budgetRow = (
    <Box key={`${spec.key}-budget-row`} flexDirection="row">
      <Box key={`${spec.key}-budget-box`} width={withGauges ? gaugeAt : cols} paddingLeft={left} flexShrink={0}>
        {budget.length === 0 ? (
          <Text key={`${spec.key}-budget`}> </Text>
        ) : spec.onBudget !== undefined ? (
          <Button key={`${spec.key}-budget`} plain onPress={spec.onBudget}>
            {budgetBody}
          </Button>
        ) : (
          <Text key={`${spec.key}-budget`} wrap="truncate-end">
            {budgetBody}
          </Text>
        )}
      </Box>
      {labels.length > 0 ? line(`${spec.key}-labels`, labels) : null}
    </Box>
  )
  const metaRoom = content - pill.text.length - 2
  const metaRuns = metaRoom > 0 ? (fitRuns(meta, metaRoom) as Run[]).filter(r => r.text !== '') : []
  return (
    <Box key={spec.key} flexDirection="column">
      {top}
      {line(`${spec.key}-pill`, [pad(left), pill, ...(metaRuns.length > 0 ? [pad(2), ...metaRuns] : [])])}
      {block}
      {budgetRow}
      {foot}
    </Box>
  )
}

/** What `agentCard` draws. */
export type AgentCardSpec = {
  key: string
  /** The small critter (`critterOf(agent, { ground, motion })`): columns 2 to 6, its badge at 7 (R25). */
  critter: CritterArgs
  /** The agent's type in friendly case (`typeName`): bold at 9. */
  name: string
  /** What it was asked to do, after the name. */
  job?: string
  /** Flush right at 59 on the first row: dim when a string ("2 min"; R27). Runs keep their style (the long runner bold, a waiter amber). */
  time?: string | Run[]
  /**
   * The second row at 9: what it is doing (`doing(step)`), dim when a string. A function is given the
   * columns the phrase may take (F I7) and answers a phrase that fits: `doing(step, view, room)`.
   */
  doing: string | Run[] | ((room: number) => string | Run[])
  /** Flush right on the second row, dim: "31k tokens". */
  tokens?: string
  /** The first row becomes one plain Button. */
  onPress?: () => void | Promise<void>
  autoFocus?: boolean
}

/**
 * An agent card (cockpit spec "An agent card is 3 rows"; R25): the critter
 * 5 x 3 at column 2 with its badge column at 7 (always reserved), the name
 * bold at 9 and the job after it, the time flush right at 59; under it what
 * it is doing (dim), tokens flush right; the third row empty. The name and
 * job are cut at a word to leave the time two columns.
 *
 * @example agentCard(ctx, $, { key: `card-${a.id}`, critter: critterOf(a, { ground, motion }), name: typeName(a.type), job: a.description, time: span(ctx.now - a.startedAt), doing: doing(running) })
 */
export function agentCard(ctx: ViewCtx, $: EngineInterface, c: AgentCardSpec): RenderElement {
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  const { left, right } = edges(ctx.cols)
  const textCol = COCKPIT.text
  const room = Math.max(1, right - textCol + 1)
  // F M14: the job follows the name only when a word of it fits; a lone "…" after the name is left out.
  const timeW = width(runsOf(c.time, { dim: true }))
  const jobRoom = room - timeW - 2 - c.name.length - 2
  const jobCut = c.job !== undefined && c.job !== '' && jobRoom > 0 ? wordFit(c.job, jobRoom) : ''
  const job = jobCut.replace(/…$/, '').length >= 4 ? jobCut : ''
  const head: Run[] = [{ text: c.name, bold: true }, ...(job !== '' ? [{ text: `  ${job}` }] : [])]
  const first = spread(head, runsOf(c.time, { dim: true }), room)
  // F I7: the doing line shortens by clause; the word "tokens" goes before any of it is cut.
  let tokens = c.tokens
  let doingRuns: Run[]
  if (typeof c.doing === 'function') {
    const full = runsOf(c.doing(Infinity), { dim: true })
    const tw = (tokens ?? '').length
    if (tokens !== undefined && width(full) + 2 + tw > room) tokens = tokens.replace(/ tokens$/, '')
    const space = room - (tokens === undefined ? 0 : tokens.length + 2)
    doingRuns = width(full) <= space ? full : runsOf(c.doing(space), { dim: true })
  } else doingRuns = runsOf(c.doing, { dim: true })
  const second = spread(doingRuns, runsOf(tokens, { dim: true }), room)
  const k = c.key
  const firstBody = first.map((r, i) => runText(r, ctx.e, $, `${k}-a${i}`))
  return (
    <Box key={`card-${k}`} flexDirection="row">
      <Box key={`${k}-who-box`} width={textCol} paddingLeft={left} flexShrink={0}>
        {inst(ctx, $, { key: `${k}-who`, ...c.critter })}
      </Box>
      <Box key={`${k}-text`} flexDirection="column" width={room} flexShrink={0}>
        {c.onPress !== undefined ? (
          <Button key={k} plain onPress={c.onPress} autoFocus={c.autoFocus === true ? true : undefined}>
            {firstBody}
          </Button>
        ) : (
          <Text key={k} wrap="truncate-end">
            {firstBody}
          </Text>
        )}
        <Text key={`${k}-doing`} wrap="truncate-end">
          {second.map((r, i) => runText(r, ctx.e, $, `${k}-d${i}`))}
        </Text>
        <Text key={`${k}-gap`}> </Text>
      </Box>
    </Box>
  )
}

/**
 * The all-clear line (cockpit spec principle 3): `✓` in `success` at 2, then
 * " Nothing needs you" dim, then `extra` (" · 2 things to watch"), cut at a
 * word. The caller adds the blank row after it.
 */
export function allClear(ctx: ViewCtx, $: EngineInterface, extra?: string | Run[]): RenderElement {
  const { Text } = $.ui.resolve(ctx.e)
  const { left, right } = edges(ctx.cols)
  const runs = fitRuns([{ text: '✓', color: CK.ok }, { text: ' Nothing needs you', dim: true }, ...runsOf(extra, { dim: true })], right - left + 1) as Run[]
  return (
    <Text key="all-clear" wrap="truncate-end">
      {' '.repeat(left)}
      {runs.filter(r => r.text !== '').map((r, i) => runText(r, ctx.e, $, `all-clear-${i}`))}
    </Text>
  )
}

/** What `primaryButton` draws. */
export type PrimarySpec = {
  key: string
  label: string
  onPress: () => void | Promise<void>
  hotkey?: string
  autoFocus?: boolean
}

/** The columns a primary Button takes on the terminal: `[ label ]`. */
export function primaryWidth(label: string): number {
  return label.length + 4
}

/**
 * The one filled button of a screen (R33): `Button variant="primary"`, drawn
 * by the terminal as `[ label ]` in the accent and natively on a desktop. It
 * stays pressable (a Button, never a Text with a background). Place it in a
 * row Box after the gutter; it is `primaryWidth(label)` wide.
 *
 * @example primaryButton(ctx, $, { key: 'export', label: 'Export digest', hotkey: 'e', onPress: exportDigest })
 */
export function primaryButton(ctx: ViewCtx, $: EngineInterface, p: PrimarySpec): RenderElement {
  const { Button } = $.ui.resolve(ctx.e)
  return (
    <Button key={p.key} variant="primary" {...(p.hotkey !== undefined ? { hotkey: p.hotkey } : {})} onPress={p.onPress} autoFocus={p.autoFocus === true ? true : undefined}>
      {p.label}
    </Button>
  )
}
