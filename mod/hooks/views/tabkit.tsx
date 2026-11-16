import type { EngineInterface, RenderElement } from 'claude-code'

import { lineOf } from './crewnode'
import type { Seg } from './crewnode'
import { blank, heightOf, runText } from './parts'
import type { Action, Detail, Run } from './parts'
import { armKeys, TAB_ROWS } from './shell'
import type { ViewCtx } from './shell'
import { STEP_GLYPH } from './agentmeta'
import { shortPaths, wordFit } from './fit'
import { CK, edges } from './style'

// The parts the Tasks, Steps and Artifacts tabs share (cockpit spec
// "CockpitTasks", "CockpitSteps", "CockpitArtifacts"): figures flush right at
// 59 and 49, the dim column heads of a section, the opened block, and the
// footer on the last row.

const widthOf = (runs: Run[]): number => runs.reduce((n, r) => n + r.text.length, 0)

/** Where a middle figure ends: ten columns before the right edge (49 at 62), absent under 50 columns. */
export function midEnd(cols: number): number | undefined {
  return cols >= 50 ? edges(cols).right - 10 : undefined
}

/** Whether the time column exists: from 36 columns. */
export const hasTime = (cols: number): boolean => cols >= 36

/** Where a name ends (exclusive) so the figures at the right keep two clear columns. */
export function nameLimit(cols: number): number {
  const mid = midEnd(cols)
  const { right } = edges(cols)
  if (mid !== undefined) return mid - 6
  if (hasTime(cols)) return right - 8
  return right + 1
}

/** A step's glyph as the mocks draw it: ▸ running, ✓ done, × failed; the rest as before. */
export function stepGlyph(status: keyof typeof STEP_GLYPH): string {
  return status === 'running' ? '▸' : status === 'done' ? '✓' : status === 'error' ? '×' : STEP_GLYPH[status]
}

/** The runs as segments ending at column `end` (flush right). */
export function flushRight(runs: Run[], end: number): Seg[] {
  let col = end + 1 - widthOf(runs)
  return runs.map(r => {
    const seg = { ...r, col }
    col += r.text.length
    return seg
  })
}

/**
 * The sum of a section that heads two columns: `9  ·  tokens      time`, the
 * count first, then the dim heads over the figures (the middle one ends at 49,
 * the time at 59). Narrower: the time head alone, then only the count.
 */
export function colHeads(cols: number, count: string, metric: string | undefined, time: string): Run[] {
  const right = edges(cols).right
  const mid = midEnd(cols)
  if (mid !== undefined && metric !== undefined) {
    const gap = right - mid - time.length
    return [{ text: count, dim: true }, { text: `  ·  ${metric}${' '.repeat(Math.max(1, gap))}${time}`, dim: true }]
  }
  if (hasTime(cols)) return [{ text: count, dim: true }, { text: `  ·  ${time}`, dim: true }]
  return [{ text: count, dim: true }]
}

/** `+ 6 more` at column 4, dim; a Button when it can be pressed. Keyed by `key`. */
export function moreRow(ctx: ViewCtx, $: EngineInterface, key: string, text: string, onPress?: () => void | Promise<void>): RenderElement {
  const body: Seg[] = [{ col: 4, text, dim: true }]
  return lineOf(ctx, $, { key, body, ...(onPress !== undefined ? { onPress } : {}) })
}

/** The opened row's key column at 4 and the value from 14. */
const KEY_COL = 4
const VALUE_COL = 14

/** What `openedBlock` draws. */
export type OpenedSpec = {
  key: string
  details: Detail[]
  actions: Action[]
  /** Dim words flush right on the actions' row (`↵ full page`). */
  right?: string
}

/**
 * The block under an opened row (mock "Result … g: chat  k: keep  c: copy  ↵ full page"):
 * each detail a dim key at 4 and its value from 14, then the actions as
 * hotkeyed Buttons from 4 (the engine draws their colon), three columns
 * apart, and the dim words at the right edge when they fit.
 */
export function openedBlock(ctx: ViewCtx, $: EngineInterface, o: OpenedSpec): RenderElement[] {
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  const { right } = edges(ctx.cols)
  const out: RenderElement[] = o.details.map((d, i) => {
    const value: Run[] = typeof d.value === 'string' ? [{ text: d.value }] : d.value
    let col = VALUE_COL
    const segs: Seg[] = [{ col: KEY_COL, text: d.key, dim: true }]
    for (const r of value) {
      segs.push({ ...r, col })
      col += r.text.length
    }
    return lineOf(ctx, $, { key: `${o.key}-d${i}`, body: segs })
  })
  const shown: Action[] = []
  let used = KEY_COL
  for (const a of o.actions) {
    const w = (shown.length > 0 ? 3 : 0) + a.hotkey.length + 2 + a.label.length
    if (used + w > right + 1) break
    shown.push(a)
    used += w
  }
  if (shown.length > 0 || o.right !== undefined) {
    const rw = o.right !== undefined ? o.right.length : 0
    const room = right + 1 - used - rw
    out.push(
      <Box key={`${o.key}-actions`} flexDirection="row">
        <Box key={`${o.key}-buttons`} flexDirection="row" paddingLeft={KEY_COL} columnGap={3}>
          {shown.map(a => (
            <Button key={a.key} hotkey={a.hotkey} plain dimColor onPress={a.onPress}>
              {a.label}
            </Button>
          ))}
        </Box>
        {o.right !== undefined && room >= 2 ? <Text key={`${o.key}-right`} dimColor>{`${' '.repeat(room)}${o.right}`}</Text> : null}
      </Box>,
    )
  }
  return out
}

/**
 * One footer hint, drawn as text (R28 amended: the key in the accent, the word
 * dim, no colon, as the mocks draw them). A hint with an `id` and `onPress`
 * also arms its key: a hidden Button in the footer (shell.tsx `armKeys`), for
 * the keys with no visible Button in the body. `hidden` arms without drawing.
 */
export type FootHint = { key: string; label: string } | { hotkey: string; label: string; id: string; onPress: () => void | Promise<void>; hidden?: boolean }

/**
 * The footer: hints from column 2, three apart, as many as fit. Null unless the
 * pane holds the keys (slim and the strip have no row to keep; the tabs use
 * `footerSlot`).
 */
export function footerRow(ctx: ViewCtx, $: EngineInterface, hints: FootHint[]): RenderElement | null {
  if (ctx.isFocused !== true) return null
  const { Box, Text } = $.ui.resolve(ctx.e)
  const { left, right } = edges(ctx.cols)
  const kept: FootHint[] = []
  let used = left
  for (const x of hints) {
    if ('hidden' in x && x.hidden === true) continue
    const w = (kept.length > 0 ? 3 : 0) + ('hotkey' in x ? x.hotkey.length : x.key.length) + 1 + x.label.length
    if (used + w > right + 1) continue
    kept.push(x)
    used += w
  }
  const arms = hints.flatMap(x => ('hotkey' in x ? [{ id: x.id, hotkey: x.hotkey, onPress: x.onPress }] : []))
  return (
    <Box key="footer" flexDirection="row" paddingLeft={left} columnGap={3}>
      {kept.map(x => {
        const k = 'hotkey' in x ? x.hotkey : x.key
        return (
          <Text key={`hint-${k}-${x.label}`}>
            <Text color={CK.accent}>{k}</Text>
            <Text dimColor>{` ${x.label}`}</Text>
          </Text>
        )
      })}
      {armKeys($, ctx.e, arms)}
    </Box>
  )
}

/**
 * The footer row of a tab: the hints while the pane holds the keys, else a
 * blank row, so the height does not change with focus (Fable round 2 M12).
 */
export function footerSlot(ctx: ViewCtx, $: EngineInterface, hints: FootHint[]): RenderElement {
  const { Box, Text } = $.ui.resolve(ctx.e)
  return (
    footerRow(ctx, $, hints) ?? (
      <Box key="footer" flexDirection="row">
        <Text>{' '}</Text>
      </Box>
    )
  )
}

/**
 * The tab's rows, then blanks down to the last row, then the footer: as the
 * mocks put it. With no footer (the pane does not hold the keys) the rows
 * stand alone.
 */
export function withFooter(ctx: ViewCtx, $: EngineInterface, out: RenderElement[], hints: FootHint[]): RenderElement[] {
  const foot = footerSlot(ctx, $, hints)
  const rows = (ctx.bodyRows ?? 46) - TAB_ROWS
  const used = out.reduce((n, el) => n + heightOf(el), 0)
  const pad = Math.max(1, rows - 1 - used)
  const filled = [...out]
  for (let i = 0; i < pad; i++) filled.push(blank(ctx, $, `pad-${i}`))
  filled.push(foot)
  return filled
}

/** A name that may hold paths: whole while it fits `room`, else its paths shortened (`…/file.ts`), then cut at a word. */
export function pathFit(text: string, room: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  if (one.length <= room) return one
  return wordFit(shortPaths(one), Math.max(1, room))
}
