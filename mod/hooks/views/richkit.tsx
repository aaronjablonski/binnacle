import type { EngineInterface, RenderElement } from 'claude-code'

import { fitRuns, pillRun, wordFit } from './fit'
import { laid } from './lay'
import type { Placed } from './lay'
import { inst } from './parts'
import type { InstSpec } from './parts'
import { Grid, beads as beadsGrid, drawBars, drawRing, drawStack, lintel, sill, stack as stackGrid } from './raster'
import type { Hue, Ink } from './raster'
import type { ViewCtx } from './shell'
import { C, DECK } from './style'
import type { Run } from './style'

// The Neo Rich building blocks the Now, budget, slim and strip views share:
// framed instruments (lintel, sill), the rings, beads, bars and stacks as
// `InstSpec`s with their text forms, and one deck row that puts a label
// Button, an instrument and plain Text cells in one row Box.

/** The theme key a pill takes as text, and the hue it takes as a Raster. */
export type Tone = 'live' | 'wait' | 'subtle'
const TONE_COLOR: Record<Tone, string> = { live: C.live, wait: C.wait, subtle: C.subtle }
const TONE_HUE: Record<Tone, Ink> = { live: 'iris', wait: 'amber', subtle: 'mute' }

/** The pill's tone for a state colour `paneState` returned. */
export function toneOf(color: string): Tone {
  return color === C.wait ? 'wait' : color === C.live ? 'live' : 'subtle'
}

export type FrameOpts = {
  /** `warning` turns clamps and pill amber. */
  tone?: 'accent' | 'warning'
  pill?: string
  pillTone?: Tone
  /** The pill's first column: 13 (the gauge column) by default. */
  pillCol?: number
  /** Cells of the clamp after its corner: 3 by default, 1 in a narrow compartment. */
  clamp?: number
  right?: string
  rightAmber?: boolean
}

const frameHue = (tone: FrameOpts['tone']): Hue => (tone === 'warning' ? 'amber' : 'iris')

/** The lintel as an instrument: the Raster, and as text a `┏` with the pill and the readout. */
export function lintelSpec(key: string, width: number, opts: FrameOpts = {}): InstSpec {
  const pillWidth = opts.pill !== undefined ? [...opts.pill].length + 2 : 0
  const pillEnd = (opts.pillCol ?? 13) + pillWidth
  // A readout that would touch the pill is left out; so is a pill that does not fit.
  const showRight = opts.right !== undefined && opts.right !== '' && width - 2 - [...opts.right].length - 1 > pillEnd + 1
  const o: FrameOpts = { ...opts }
  if (opts.pill !== undefined && pillEnd > width - 1) delete o.pill
  if (!showRight) delete o.right
  const hue = frameHue(o.tone)
  const corner = o.tone === 'warning' ? C.wait : C.live
  const pillTone = o.pillTone ?? (o.tone === 'warning' ? 'wait' : 'live')
  const pillCol = o.pillCol ?? 13
  const text: Run[] = [{ text: '┏', color: corner }]
  let used = 1
  if (o.pill !== undefined) {
    const gap = Math.max(1, pillCol - used)
    text.push({ text: ' '.repeat(gap) })
    const pr = pillRun(o.pill, TONE_COLOR[pillTone])
    text.push(pr)
    used += gap + pr.text.length
  }
  if (o.right !== undefined && o.right !== '') {
    const room = width - 1 - used - 1
    if (room > 0) {
      const r = wordFit(o.right, room)
      text.push({ text: ' '.repeat(Math.max(1, width - 1 - used - r.length)) }, { text: r, dim: true })
    }
  }
  const pillHue = TONE_HUE[pillTone]
  return {
    key,
    columns: width,
    rows: 1,
    sig: `lintel:${width}:${hue}:${o.pill ?? ''}:${pillHue}:${pillCol}:${o.clamp ?? 3}:${o.right ?? ''}:${o.rightAmber === true}`,
    frames: () =>
      [
        lintel(width, {
          hue,
          pillHue,
          pillCol,
          ...(o.clamp !== undefined ? { clamp: o.clamp } : {}),
          ...(o.pill !== undefined ? { pill: o.pill } : {}),
          ...(o.right !== undefined ? { right: o.right, rightHue: o.rightAmber === true ? 'amber' : 'mute' } : {}),
        }),
      ],
    fallback: [text],
  }
}

/** The sill as an instrument: the Raster, and as text a `┗`. */
export function sillSpec(key: string, width: number, o: Pick<FrameOpts, 'tone' | 'clamp'> = {}): InstSpec {
  const hue = frameHue(o.tone)
  return {
    key,
    columns: width,
    rows: 1,
    sig: `sill:${width}:${hue}:${o.clamp ?? 3}`,
    frames: () => [sill(width, { hue, ...(o.clamp !== undefined ? { clamp: o.clamp } : {}) })],
    fallback: [[{ text: '┗', color: o.tone === 'warning' ? C.wait : C.live }]],
  }
}

/** One blank-padded text row of `cols`. */
const padded = (runs: Run[], cols: number): Run[] => {
  const used = runs.reduce((n, r) => n + r.text.length, 0)
  return used < cols ? [...runs, { text: ' '.repeat(cols - used) }] : runs
}

// ---------- instruments ----------

export type Ring = { name: string; pct: number; hot?: boolean }

/** Rings side by side at a pitch of 8 (7 wide): `8n - 1` columns, 4 rows. As text: the names over the figures. */
export function ringsSpec(key: string, rings: Ring[]): InstSpec {
  const columns = Math.max(7, rings.length * 8 - 1)
  const names: Run[] = []
  const figures: Run[] = []
  rings.forEach((r, i) => {
    names.push({ text: r.name.padEnd(i < rings.length - 1 ? 8 : 3), dim: true })
    figures.push({ text: `${Math.round(r.pct)}%`.padEnd(i < rings.length - 1 ? 8 : 3), bold: true })
  })
  return {
    key,
    columns,
    rows: 4,
    sig: `rings:${rings.map(r => `${r.name}=${Math.round(r.pct)}${r.hot === true ? '!' : ''}`).join(',')}`,
    frames: () => {
      const g = new Grid(columns, 4)
      rings.forEach((r, i) => drawRing(g, i * 8, 0, r.name, r.pct, r.hot === true ? { nameHue: 'amber' } : {}))
      return [g]
    },
    fallback: [names, figures].map(row => padded(row, columns)),
  }
}

/** Beads, `cells` wide (any non-zero value lights one). As text: `▮` and `▯` a cell. */
export function beadsSpec(key: string, cells: number, pct: number, hue?: Ink): InstSpec {
  const lit = pct >= 100 ? cells : pct > 0 ? Math.max(1, Math.min(cells - 1, Math.floor((pct * cells) / 100))) : 0
  return {
    key,
    columns: cells,
    rows: 1,
    sig: `beads:${cells}:${Math.round(pct)}:${hue ?? ''}`,
    frames: () => [beadsGrid(cells, pct, hue)],
    fallback: [[{ text: '▮'.repeat(lit), color: C.live }, { text: '▯'.repeat(cells - lit), color: C.subtle }]],
  }
}

/** Eighth-block bars, 1 to 3 rows; a zero is a rest tick. `hues` gives each column's colour. As text: a one-row trace. */
export function barsSpec(key: string, rows: 1 | 2 | 3, vals: number[], hues: Ink[]): InstSpec {
  const max = Math.max(...vals, 1)
  const glyphs = '▁▂▃▄▅▆▇█'
  const text = vals.map(v => (v <= 0 ? '▁' : glyphs[Math.max(0, Math.min(7, Math.round((v / max) * 7)))]!)).join('')
  const fallback: Run[][] = []
  for (let i = 0; i < rows; i++) fallback.push(i === rows - 1 ? [{ text, color: C.live }] : [{ text: ' '.repeat(vals.length) }])
  return {
    key,
    columns: Math.max(1, vals.length),
    rows,
    sig: `bars:${rows}:${vals.join(',')}:${hues.join(',')}`,
    frames: () => {
      const g = new Grid(Math.max(1, vals.length), rows)
      drawBars(g, 0, 0, rows, vals, i => hues[i] ?? 'iris')
      return [g]
    },
    fallback,
  }
}

/** A stacked bar, `cells` wide. As text: `▪` runs in the parts' theme colours (`colors`, one a part). */
export function stackSpec(key: string, cells: number, parts: [number, Ink][], colors: string[] = []): InstSpec {
  const total = parts.reduce((a, p) => a + Math.max(0, p[0]), 0)
  const runs: Run[] = []
  let used = 0
  parts.forEach((p, i) => {
    const n = total > 0 ? Math.round((Math.max(0, p[0]) / total) * cells) : 0
    const k = Math.min(n, cells - used)
    if (k > 0) runs.push({ text: '▪'.repeat(k), ...(colors[i] !== undefined ? { color: colors[i] } : { dim: true }) })
    used += k
  })
  return {
    key,
    columns: cells,
    rows: 1,
    sig: `stack:${cells}:${parts.map(p => `${p[0]}${String(p[1])}`).join(',')}`,
    frames: () => [stackGrid(cells, parts)],
    fallback: [padded(runs, cells)],
  }
}

export { drawStack }

// ---------- one deck row ----------

export type DeckRowSpec = {
  key: string
  /** The dim caps label at 2, to 11. A press makes it a plain Button keyed `key`. */
  label?: string | Run[]
  onPress?: () => void | Promise<void>
  autoFocus?: boolean
  /** A second dim line under the label (when the instrument is two rows tall). */
  sub?: string | Run[]
  inst?: InstSpec
  /** Text cells at absolute columns: from 14, or after the instrument. A cell at 50 goes under 62 columns, one at 38 under 50. */
  cells?: Placed[]
}

/**
 * `[label at 2][instrument at 14][cells]` as one row Box (spec "one rule:
 * labels are keys, pictures are Rasters"): the label is the row's only
 * Button, so nothing pressable shares a cell with a Raster. `cols` is the
 * width the row is drawn for (the pane, or a compartment). In the pane
 * (`tiers`) a cell at 50 goes under 62 columns and one at 38 under 50; a
 * compartment is laid out for its own width and keeps what it is given.
 */
export function deckRowEl(ctx: ViewCtx, $: EngineInterface, cols: number, r: DeckRowSpec, tiers = true): RenderElement {
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  const spec = r.inst !== undefined && DECK.gauge + r.inst.columns <= cols ? r.inst : undefined
  const start = spec !== undefined ? DECK.gauge + spec.columns : DECK.gauge
  const kept = (r.cells ?? [])
    .filter(c => c.col >= start && c.text !== '')
    .filter(c => !tiers || (!(cols < 62 && c.col >= DECK.aside) && !(cols < 50 && c.col >= DECK.value)))
    .sort((a, b) => a.col - b.col)
  const segs: Placed[] = []
  kept.forEach((c, i) => {
    const next = kept[i + 1]
    const room = (next !== undefined ? next.col - 2 : cols) - c.col
    if (room <= 0) return
    const fitted = fitRuns([c], room)
    for (const f of fitted) segs.push({ ...c, ...f, col: c.col })
  })
  const asRuns = (v: string | Run[], extra: Omit<Run, 'text'> = {}): Run[] => (typeof v === 'string' ? [{ text: v, ...extra }] : v)
  const labelRuns = r.label !== undefined ? (fitRuns(asRuns(r.label, { dim: true }), DECK.gauge - 2 - DECK.label) as Run[]) : []
  const body = labelRuns.map((x, j) => (
    <Text key={`${r.key}-l${j}`} color={x.color} bold={x.bold === true ? true : undefined} dimColor={x.dim === true ? true : undefined} backgroundColor={x.bg}>
      {x.text}
    </Text>
  ))
  const labelEl =
    r.onPress !== undefined ? (
      <Button key={r.key} plain dimColor onPress={r.onPress} autoFocus={r.autoFocus === true ? true : undefined}>
        {body}
      </Button>
    ) : (
      <Text key={r.key}>{body}</Text>
    )
  const sub = r.sub !== undefined && spec !== undefined && spec.rows > 1 ? (fitRuns(asRuns(r.sub, { dim: true }), DECK.gauge - 2 - DECK.label) as Run[]) : []
  return (
    <Box key={`row-${r.key}`} flexDirection="row">
      <Box key={`${r.key}-label`} flexDirection="column" width={DECK.gauge} paddingLeft={DECK.label} flexShrink={0}>
        {labelEl}
        {sub.length > 0 ? (
          <Text key={`${r.key}-sub`}>
            {sub.map((x, j) => (
              <Text key={`${r.key}-s${j}`} color={x.color} bold={x.bold === true ? true : undefined} dimColor={x.dim === true ? true : undefined}>
                {x.text}
              </Text>
            ))}
          </Text>
        ) : null}
      </Box>
      {spec !== undefined ? inst(ctx, $, spec) : null}
      {segs.length > 0 ? (
        <Text key={`${r.key}-cells`} wrap="truncate-end">
          {laid(segs, start, ctx.e, $, `${r.key}-c`)}
        </Text>
      ) : null}
    </Box>
  )
}

/** Text at 2 in the label column: a plain dim Text (a kind label, a section name). */
export const dim = (text: string): Run => ({ text, dim: true })
