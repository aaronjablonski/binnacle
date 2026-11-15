import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'

import { debug, errText } from '../state'
import { at, bar10, DIAGRAM, fit, fitRuns, headerParts, keepCells, line, placed, spark10, stack10, wordFit } from './fit'
import type { ViewCtx } from './shell'
import { C, cellsFor, COL, GRID, tableCols } from './style'

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
  const body = fit(text, Math.max(0, ctx.cols - indent.length - glyph.length - 1))
  return (
    <Text>
      {indent !== '' ? indent : null}
      {color !== undefined ? <Text color={color}>{glyph}</Text> : <Text dimColor>{glyph}</Text>}
      {bold ? <Text bold>{` ${body}`}</Text> : ` ${body}`}
    </Text>
  )
}

/**
 * Left text and a dim right text on one row, or two rows when they do not fit.
 * @deprecated HUD v1. Use `row`, whose metric and time sit on grid columns.
 */
export function splitLine(
  ctx: ViewCtx,
  $: EngineInterface,
  glyph: string,
  color: string | undefined,
  left: string,
  right: string,
  bold = false,
  indent = '',
): RenderElement {
  const { Box, Text } = $.ui.resolve(ctx.e)
  const room = ctx.cols - right.length - 1
  if (right === '') return glyphLine(ctx, $, glyph, color, left, bold, indent)
  if (room < MIN_SPLIT) {
    return (
      <Box flexDirection="column">
        {glyphLine(ctx, $, glyph, color, left, bold, indent)}
        <Text dimColor>{fit(right, ctx.cols)}</Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="row" justifyContent="space-between">
      {glyphLine({ ...ctx, cols: room }, $, glyph, color, left, bold, indent)}
      <Text dimColor>{right}</Text>
    </Box>
  )
}

/**
 * A status glyph as a Text: in its colour, or dim when it has none.
 * @deprecated HUD v1. `row` draws the glyph; `runText` draws any styled run.
 */
export function glyphText(glyph: string, color: string | undefined, e: RenderInput, $: EngineInterface, key?: string): RenderElement {
  const { Text } = $.ui.resolve(e)
  return color !== undefined ? (
    <Text key={key} color={color}>
      {glyph}
    </Text>
  ) : (
    <Text key={key} dimColor>
      {glyph}
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

/** A styled piece of one line. Colours are theme keys from `C`; `dim` is `dimColor`. */
export type Run = { text: string; color?: string; bold?: boolean; dim?: boolean; underline?: boolean }

/** A Run as one Text. `key` is its address in a list. */
export function runText(r: Run, e: RenderInput, $: EngineInterface, key?: string): RenderElement {
  const { Text } = $.ui.resolve(e)
  return (
    <Text
      key={key}
      color={r.color}
      bold={r.bold === true ? true : undefined}
      dimColor={r.dim === true ? true : undefined}
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

/** The gutter flags: `◂` (in view in the chat) in the accent, `!` (a problem here or below) in error. */
export type Flag = 'inView' | 'problem'

const FLAG: Record<Flag, Run> = { inView: { text: '◂', color: C.live }, problem: { text: '!', color: C.fail } }

/** What `row` draws. */
export type RowSpec = {
  /** The row's address: the Button's key (and its press target). Unique in the pane. */
  key: string
  /** Column 0: `◂` or `!`; absent, blank. */
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
  /** Absent, the row is a Text (not pressable). */
  onPress?: () => void | Promise<void>
  /** The pane's focus ring starts here (the first NEEDS YOU row). */
  autoFocus?: boolean
}

/** The room a cell at `col` has: 10, or less at the edge. */
const cellRoom = (cols: number, col: number): number => Math.min(GRID.content, cols - col)

const cellText = (v: string | Run, room: number): Run =>
  typeof v === 'string' ? { text: fit(v, room), dim: true } : { ...v, text: fit(v.text, room) }

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
  if (r.guide !== undefined && indent > 0) segs.push({ col: COL.glyph, text: fit(r.guide, indent), color: C.subtle })
  segs.push({ col: glyphCol, text: r.glyph, ...(r.glyphColor !== undefined ? { color: r.glyphColor } : { dim: true }) })
  if (r.tool !== undefined) segs.push({ col: toolCol, text: fit(r.tool, 5), dim: true })
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

/** Options of `section`. */
export type SectionOpts = {
  /** `wait`: the corner and the label in `warning` (NEEDS YOU). Default: the accent corner, a plain bold label. */
  tone?: 'wait'
  /** With `onPress`: the whole label row is one plain Button keyed `key`. */
  key?: string
  onPress?: () => void | Promise<void>
}

/**
 * A section label: `┌` at 0 in the accent (or warning), the label bold caps
 * at 2, dim lower-case heads at the metric (38) and time (50) columns of
 * `tableCols`; a head whose column the tier drops is left out. The label is
 * cut by word to end 2 before the first head.
 *
 * @example section(ctx, $, 'AGENTS', 'tokens', 'time')
 * @example section(ctx, $, 'NEEDS YOU', 'why', 'waiting', { tone: 'wait' })
 */
export function section(
  ctx: ViewCtx,
  $: EngineInterface,
  label: string,
  metricHead?: string,
  timeHead?: string,
  opts: SectionOpts = {},
): RenderElement {
  const { Text, Button } = $.ui.resolve(ctx.e)
  const cols = ctx.cols
  const tc = tableCols(cols)
  const tone = opts.tone === 'wait' ? C.wait : C.accent
  const heads: (Run & { col: number })[] = []
  if (metricHead !== undefined && tc.metric !== undefined) {
    heads.push({ col: tc.metric, text: fit(metricHead, cellRoom(cols, tc.metric)), dim: true })
  }
  if (timeHead !== undefined && tc.time !== undefined) {
    heads.push({ col: tc.time, text: fit(timeHead, cellRoom(cols, tc.time)), dim: true })
  }
  const labelEnd = heads.length > 0 ? (heads[0]?.col ?? cols) - 2 : cols
  const segs: (Run & { col: number })[] = [
    { col: COL.gutter, text: '┌', color: tone },
    { col: COL.glyph, text: wordFit(label, labelEnd - COL.glyph), bold: true, ...(opts.tone === 'wait' ? { color: C.wait } : {}) },
    ...heads,
  ]
  const key = opts.key ?? `sec-${label}`
  const body = laidOut(segs.filter(s => s.text !== ''), 0, ctx.e, $, `${key}-`)
  if (opts.onPress !== undefined) {
    return (
      <Button key={key} plain onPress={opts.onPress}>
        {body}
      </Button>
    )
  }
  return (
    <Text key={key} wrap="truncate-end">
      {body}
    </Text>
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
      { col: COL.detailKey, text: fit(d.key, COL.detailValue - COL.detailKey - 1), dim: true },
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
            {fit(c.label, GRID.content)}
          </Button>
        ) : (
          <Text dimColor>{fit(c.label, GRID.content)}</Text>
        ),
      )}
      {cellRow('value', (c, i) => <Text>{clip(asRuns(c.value, { bold: true })).map((r, j) => runText(r, ctx.e, $, `v${i}-${j}`))}</Text>)}
      {cellRow('gfx', (c, i) => <Text>{c.gfx.map((r, j) => runText(r, ctx.e, $, `g${i}-${j}`))}</Text>)}
    </Box>
  )
}

/** A 10-wide bar for `value` of `total`: the fill in `color` (default the accent), the rest in `subtle` (`bar10`). */
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

/** A 10-wide sparkline of `buckets` (`spark10`) in `color` (default the accent). */
export function sparkCell(buckets: number[], color: string = C.live): Run[] {
  return [{ text: spark10(buckets), color }]
}

/** One footer hint: a hotkeyed Button (so its key is armed), or an engine key as dim text (`↵ open`, `esc prompt`). */
export type Hint = { hotkey: string; label: string; key: string; onPress: () => void | Promise<void> } | { text: string }

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
      {hints.slice(0, 3).map((hint, i) =>
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
