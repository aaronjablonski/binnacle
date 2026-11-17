import type { EngineInterface, On, RenderElement, RenderInput } from 'claude-code'

import type { UiState } from '../../types'
import { debug, errText, readPr, readTimeline, readUi } from '../state'
import { prChip } from './prblock'
import { bandModel, agentsWords, needsPiece } from './bandmodel'
import type { BandModel } from './bandmodel'
import { todoBar, wordFit } from './fit'
import { needsLimits, paneCovered, paneWatching } from './needs'
import { inst, runText } from './parts'
import type { Run } from './parts'
import { begin, cue, cueOn, cueStarted } from './paint'
import { todoBlock } from '../model/todo'
import { chooseShowAs, keepShowAs, lookOption, showAsOption } from './options'
import { leaveStrip } from './shell'
import { stripBandView } from './stripband'
import type { ViewCtx } from './shell'
import { C, CK, critterArgs, groundOf, lookAsked, motionOn, themeOf } from './style'
import { bandSvgOf, lookFor } from './svgview'

// The band above the prompt (cockpit spec "CockpitBand", mock CockpitBand;
// rulings R1 to R5, R8, R9, R24, R25). Two rows while the pane is closed and
// the band is wide: row 1 says what is happening, row 2 how far along and
// whether anything needs you, the one critter (the lead, or the asker while an
// ask is up) beside them. One row when narrow or while the pane is open; one
// dim line at idle. No Button (`/binnacle` is dim text; nothing lives only here), no
// clamp, no pill, no beads, no hotkey, and the critter never blinks (R24).
// Only an ask colours it (amber, R9). Watch adds a dim count.

/** From this many columns, with the pane closed, the band is two rows (the mock draws the one-row form at 64 and 40). */
const TWO_ROWS_FROM = 80
/** The critter's box (micro: 4 columns and the badge column) and the gap before the text. */
const CRITTER_COLUMNS = 5
const CRITTER_GAP = 1
/** The to-do bar's width in the two-row form (the mock's 28), and its gap to the words. */
const BAR_CELLS = 28
const BAR_GAP = 2
/** The least room a cut focus is worth: under it the focus is dropped. */
const MIN_FOCUS = 8
const MC = '/binnacle'
const BAND_SITE = 'binnacle-band'
/** Motion sketch 1: the band's one change cue, the new done count in the accent for one beat. */
export const COUNT_CUE_MS = 1000
/** A task done this recently, when the band first sees it, starts the cue. */
const COUNT_CUE_FRESH_MS = 2000

const widthOf = (runs: Run[]): number => runs.reduce((n, r) => n + r.text.length, 0)
const spaces = (n: number): Run => ({ text: ' '.repeat(Math.max(0, n)) })
const dim = (s: string): Run => ({ text: s, dim: true })
const plain = (s: string): Run => ({ text: s })
const bold = (s: string): Run => ({ text: s, bold: true })

/** A separator: a dot between pieces, `gap` spaces each side, dim. */
const dot = (gap: number): Run => dim(`${' '.repeat(gap)}·${' '.repeat(gap)}`)

/** Pieces joined by dots. */
function joined(pieces: Run[][], gap: number): Run[] {
  return pieces.flatMap((p, i) => (i > 0 ? [dot(gap), ...p] : p))
}

/** A gauge's figure (R9): ink, bold from 70 %, red from 90 %. */
function figure(pct: number): Run {
  const text = `${pct}%`
  return pct >= 90 ? { text, color: CK.fail } : pct >= 70 ? bold(text) : plain(text)
}

/** `context 62%   week 34%`, or the part of it that was asked for. */
function gauges(m: BandModel, which: 'both' | 'context' | 'none'): Run[] {
  if (which === 'none') return []
  const out: Run[] = []
  if (m.context !== undefined) out.push(dim('context '), figure(m.context))
  if (which === 'both' && m.week !== undefined) out.push(...(out.length > 0 ? [dim('   week ')] : [dim('week ')]), figure(m.week))
  return out
}

/** Words a cut goal never ends on (M9): "Wiring the limiter into the" reads as broken. */
const DANGLING = new Set(['a', 'an', 'the', 'and', 'or', 'but', 'of', 'to', 'into', 'onto', 'in', 'on', 'at', 'by', 'for', 'from', 'with', 'as', 'its', 'their', 'our', 'your', 'my', 'this', 'that'])

/**
 * `text` cut at a word to `room`, with no ellipsis (the mock's 64-column
 * row); '' when not even a word fits. A cut never ends on an article,
 * conjunction or preposition (M9): those words go too.
 */
export function cutWords(text: string, room: number): string {
  if (room <= 0) return ''
  if (text.length <= room) return text
  const head = text.slice(0, room + 1)
  const space = head.lastIndexOf(' ', room)
  if (space <= 0) return ''
  const words = text.slice(0, space).trimEnd().split(' ')
  while (words.length > 1 && DANGLING.has(words[words.length - 1]!.toLowerCase())) words.pop()
  return words.join(' ')
}

/** Runs trimmed to `room` at a word with a closing `…` (where the row has to cut), whole when they fit. */
function trimRuns(runs: Run[], room: number): Run[] {
  if (widthOf(runs) <= room) return runs
  const out: Run[] = []
  let left = room
  for (const r of runs) {
    if (left <= 0) break
    if (r.text.length <= left) {
      out.push(r)
      left -= r.text.length
    } else {
      // F I4: a run's leading spaces are its separator, kept apart from the words that are cut.
      const lead = /^\s*/.exec(r.text)![0]
      const cut = wordFit(r.text.slice(lead.length), left - lead.length)
      if (cut !== '') out.push({ ...r, text: lead + cut })
      left = 0
    }
  }
  return out
}

/** One row: `left`, then `right` flush at the last column of `cols`; `right` is dropped when `left` cannot keep `keep` columns beside it. */
function spread(left: Run[], right: Run[], cols: number, keep = 0): Run[] {
  const rw = widthOf(right)
  const lw = widthOf(left)
  if (rw > 0 && lw + 1 + rw <= cols) return [...left, spaces(cols - lw - rw), ...right]
  if (rw > 0 && keep > 0 && keep + 2 + rw <= cols) {
    const l = trimRuns(left, cols - rw - 2)
    return [...l, spaces(cols - widthOf(l) - rw), ...right]
  }
  return trimRuns(left, cols)
}

/** A line of runs as one Text, with the terminal's own cut as the backstop. */
function line(ctx: ViewCtx, $: EngineInterface, key: string, runs: Run[]): RenderElement {
  const { Text } = $.ui.resolve(ctx.e)
  return (
    <Text key={key} wrap="truncate-end">
      {runs.filter(r => r.text !== '').map((r, i) => runText(r, ctx.e, $, `${key}-${i}`))}
    </Text>
  )
}

// ---------- the one-row forms (64 and 40 columns, the pane open) ----------

/** The count of the lead's list: `9 of 14`. */
const countRuns = (m: BandModel): Run[] => [bold(String(m.done)), dim(` of ${m.total}`)]

/** `1 needs you`, `2 need you`: the asks standing, not the agents that ask. */
const needsWords = (m: BandModel): string => {
  const n = (m.ask?.more ?? 0) + 1
  return `${n} ${n === 1 ? 'needs' : 'need'} you`
}

/**
 * The one row. Each form is a list of pieces that give way from the end, then
 * the focus is cut at a word (the mock's 64 columns), then `/binnacle` itself. The
 * first fit is drawn whole; a row that fits nothing is cut by the terminal.
 */
function oneRow(m: BandModel, cols: number): Run[] {
  const mc = [dim(MC)]
  const place = (left: Run[]): Run[] => spread(left, mc, cols)
  const fits = (left: Run[]): boolean => widthOf(left) + 1 + MC.length <= cols

  if (m.form === 'idle' && m.rest !== undefined) {
    const head: Run[] = [...(m.rest.tick ? [{ text: '✓ ', color: CK.ok }] : []), dim(m.rest.head)]
    for (let n = m.rest.facts.length; n >= 0; n--) {
      const left = [...head, ...m.rest.facts.slice(0, n).flatMap(f => [dot(3), dim(f)])]
      if (fits(left)) return place(left)
    }
    return place(trimRuns(head, cols - 1 - MC.length))
  }

  if (m.form === 'asked' && m.ask !== undefined) {
    const lead: Run[] = [{ text: '▲ ', color: CK.ask, bold: true }, { text: needsWords(m), color: CK.ask, bold: true }]
    const forms = (gap: number): Run[][] => [
      joined([lead, [plain(m.ask!.tool)], ...(m.total > 0 ? [countRuns(m)] : [])], gap),
      joined([lead, [plain(m.ask!.tool)]], gap),
      [{ text: '▲ ', color: CK.ask, bold: true }, plain(m.ask!.tool)],
    ]
    for (let i = 0; i < 3; i++) for (const gap of [3, 2]) if (fits(forms(gap)[i]!)) return place(forms(gap)[i]!)
    return place(trimRuns([{ text: '▲ ', color: CK.ask, bold: true }, plain(m.ask.tool)], cols - 1 - MC.length))
  }

  if (m.form === 'stopped') {
    const head: Run[] = [{ text: '× ', color: CK.fail, bold: true }, { text: 'Stopped', color: CK.fail, bold: true }]
    const reason = (room: number): Run[] => {
      const cut = wordFit(m.focus, room)
      return cut === '' ? [] : [{ text: cut, color: CK.fail }]
    }
    const withCount = [...(m.total > 0 ? [countRuns(m)] : [])]
    const base = joined([head, ...withCount], 2)
    const room = cols - 1 - MC.length - widthOf(base) - 5
    const tail = room >= MIN_FOCUS ? reason(room) : []
    const left = tail.length > 0 ? joined([head, tail, ...withCount], 2) : base
    if (fits(left)) return place(left)
    return place(trimRuns(head, cols - 1 - MC.length))
  }

  // working: the count, the agents, Watch, then the focus, then the context (the mock's order); pieces give way from the end.
  const parts: Record<string, Run[]> = {
    count: m.total > 0 ? countRuns(m) : [],
    agents: m.working > 0 ? [plain(`${m.working} ${m.working === 1 ? 'agent' : 'agents'}`)] : [],
    watch: m.watch > 0 ? [dim(`${m.watch} to watch`)] : [],
    context: m.context !== undefined ? [dim('context '), figure(m.context)] : [],
  }
  const drops = [
    ['count', 'agents', 'watch', 'context'],
    ['count', 'agents', 'context'],
    ['count', 'agents'],
    ['count'],
  ]
  for (const keep of drops) {
    const before = keep.filter(k => k !== 'context' && parts[k]!.length > 0).map(k => parts[k]!)
    const after = keep.includes('context') && parts.context!.length > 0 ? [parts.context!] : []
    const without = joined([...before, ...after], 2)
    if (m.focus !== '') {
      const room = cols - 1 - MC.length - widthOf(without) - (without.length > 0 ? 4 : 0)
      const cut = cutWords(m.focus, room)
      if (cut !== '' && (cut.length >= MIN_FOCUS || cut === m.focus)) {
        const left = joined([...before, [plain(cut)], ...after], 2)
        if (fits(left)) return place(left)
      }
    }
    if (without.length > 0 && fits(without)) return place(without)
  }
  return place(trimRuns(m.total > 0 ? countRuns(m) : [dim('Working')], cols - 1 - MC.length))
}

// ---------- the two-row form ----------

/**
 * Whether the ask's command goes on row 2 (M9, I5): it is drawn whole, and
 * when row 1 has no room for it whole beside the sentence and the tool, it
 * moves to row 2 in place of the to-do words rather than being cut.
 */
function commandBelow(m: BandModel, room: number): boolean {
  if (m.form !== 'asked' || m.ask === undefined || m.ask.command === '') return false
  const a = m.ask
  const essential = 'Needs you'.length + `   ${a.sentence}  `.length + a.tool.length
  return essential + 2 + a.command.length + 2 + 'answer below ↓'.length > room
}

/** Row 1: the kicker and what it is about at the left, the gauges (or "answer below") at the right. */
function rowOne(m: BandModel, room: number): Run[] {
  if (m.form === 'asked' && m.ask !== undefined) {
    const a = m.ask
    const below = commandBelow(m, room)
    const essential: Run[] = [{ text: 'Needs you', color: CK.ask, bold: true }, plain(`   ${a.sentence}`), ...(below ? [] : [plain('  '), bold(a.tool)])]
    const right: Run[] = [{ text: 'answer below ↓', color: CK.ask }]
    // M9: the command whole on row 1, or on row 2 with its tool (commandBelow); never cut here.
    const left: Run[] = [...essential, ...(!below && a.command !== '' ? [plain('  '), bold(a.command)] : [])]
    return spread(left, right, room, widthOf(essential))
  }
  const head: Run[] = m.form === 'stopped' ? [{ text: 'Stopped', color: CK.fail, bold: true }, plain('   ')] : [dim(`${m.kicker}   `)]
  const style = (s: string): Run => (m.form === 'stopped' ? { text: s, color: CK.fail } : bold(s))
  for (const which of ['both', 'context', 'none'] as const) {
    const right = gauges(m, which)
    const roomLeft = room - widthOf(right) - (right.length > 0 ? 2 : 0) - widthOf(head)
    // F M14: at 80 the goal is cut at a word without an ellipsis, as the mock's 64-column row is.
    const goal = cutWords(m.focus, roomLeft)
    if (goal === '' && m.focus !== '' && which !== 'none') continue
    if (roomLeft >= MIN_FOCUS || which === 'none' || m.focus.length <= roomLeft) {
      return spread([...head, ...(goal !== '' ? [style(goal)] : [])], right, room)
    }
  }
  return trimRuns([...head, style(m.focus)], room)
}

/** Row 2: the to-do bar and its words, `/binnacle` at the right. */
function rowTwo(ctx: ViewCtx, $: EngineInterface, m: BandModel, room: number, countCue = false): RenderElement {
  const cells = Math.max(10, Math.min(BAR_CELLS, room - 34))
  const hasBar = m.total > 0
  const start = hasBar ? cells + BAR_GAP : 0
  const count: Run[] = [countCue ? { text: String(m.done), bold: true, color: C.accent } : bold(String(m.done)), dim(` of ${m.total} done`)]
  const agents: Run[] = m.working > 0 ? [dim(agentsWords(m))] : []
  const pieces: Run[][] = []
  // The calm piece ("nothing needs you") may give way to the chip; a Watch count or a waiting ask may not.
  let calm = false
  if (m.form === 'asked') {
    const waiting: Run = { text: `${m.waiting} waiting`, color: CK.ask }
    pieces.push(...(hasBar ? [count] : []), m.working > 0 ? [dim(`${m.working} ${m.working === 1 ? 'agent' : 'agents'} working, `), waiting] : [waiting])
  } else if (m.form === 'stopped') {
    pieces.push(...(hasBar ? [count] : []))
  } else {
    const needs = needsPiece(m)
    calm = needs === 'nothing needs you'
    pieces.push(...(hasBar ? [count] : []), ...(agents.length > 0 ? [agents] : []), [dim(needs)])
  }
  // R46, R57: the PR chip (`#123 ✓ stack 2/4`) sits before `/binnacle` only while every word that matters still fits beside it.
  const chip = prChip(ctx.pr)
  const kept = calm ? pieces.slice(0, -1) : pieces
  const chipW = chip.length > 0 ? widthOf(chip) + 3 : 0
  const withChip = chip.length > 0 && widthOf(joined(kept, 3)) <= room - start - 1 - chipW - MC.length
  const mc: Run[] = withChip ? [...chip, spaces(3), dim(MC)] : [dim(MC)]
  const mcW = widthOf(mc)
  const space = room - start - 1 - mcW
  if (m.ask !== undefined && commandBelow(m, room)) {
    // M9, I5: the ask's tool and its command whole, in place of the to-do words; cut at a word only past the row.
    const cmd: Run[] = [bold(m.ask.tool), plain('  '), bold(m.ask.command)]
    const fitted = widthOf(cmd) + 1 + mcW <= room ? cmd : trimRuns(cmd, room - 1 - mcW)
    return line(ctx, $, 'band-row-2', spread(fitted, mc, room))
  }
  let words: Run[] = joined(pieces, 3)
  for (let n = pieces.length; n > 0 && widthOf(words) > space; n--) words = joined(pieces.slice(0, n - 1), 3)
  const bar: Run[] = hasBar ? todoBar(cells, m.total, m.done, m.current) : []
  const left = [...bar, ...(hasBar ? [spaces(BAR_GAP)] : []), ...words]
  return line(ctx, $, 'band-row-2', spread(left, mc, room))
}

/** What the companion says in an empty session (R56). */
export const READY_WORDS = 'Ready when you are'

/**
 * The companion row (R56): the lead's micro critter peeking up from below,
 * its head alone above the prompt (a one-row window over its two rows), then
 * the words. The band is never empty: an empty session reads
 * `Ready when you are … /binnacle`, and at idle the dim summary sits beside it.
 */
function peekRow(ctx: ViewCtx, $: EngineInterface, runs: Run[]): RenderElement {
  const { Box } = $.ui.resolve(ctx.e)
  const room = Math.max(1, ctx.cols - CRITTER_COLUMNS - CRITTER_GAP)
  const c = critterArgs('lead', 'working', { size: 'micro', ground: ctx.ground ?? 'night', roleWord: false })
  return (
    <Box key="band-peek" flexDirection="row">
      <Box key="band-peek-window" width={CRITTER_COLUMNS} height={1} overflow="hidden" flexShrink={0}>
        {inst(ctx, $, { key: 'band-peek-critter', ...c })}
      </Box>
      <Box key="band-peek-gap" width={CRITTER_GAP} flexShrink={0} />
      <Box key="band-peek-words" width={room} flexShrink={0}>
        {line(ctx, $, 'band-peek-line', runs.length > 0 ? fitRow(runs, room) : runs)}
      </Box>
    </Box>
  )
}

/** The runs fitted to `room`, `/binnacle` kept at the right. */
function fitRow(runs: Run[], room: number): Run[] {
  return runs.reduce((n, r) => n + r.text.length, 0) <= room ? runs : trimRuns(runs, room)
}

/** The two rows: the micro critter at 0, the words from 6. */
function twoRows(ctx: ViewCtx, $: EngineInterface, m: BandModel, countCue = false): RenderElement {
  const { Box } = $.ui.resolve(ctx.e)
  const room = ctx.cols - CRITTER_COLUMNS - CRITTER_GAP
  const c = critterArgs(m.critter.role, m.critter.state, { size: 'micro', ground: ctx.ground ?? 'night' })
  return (
    <Box key="band" flexDirection="row">
      {inst(ctx, $, { key: 'band-critter', ...c })}
      <Box key="band-gap" width={CRITTER_GAP} flexShrink={0} />
      <Box key="band-words" flexDirection="column" width={room} flexShrink={0}>
        {line(ctx, $, 'band-row-1', rowOne(m, room))}
        {rowTwo(ctx, $, m, room, countCue)}
      </Box>
    </Box>
  )
}

/**
 * The row above the prompt. Two rows while the pane is closed and the band
 * has `TWO_ROWS_FROM` columns; one row otherwise (the pane open, narrow, or
 * `maxRows` of 1); at idle one dim line. Nothing for an empty session. While
 * `ui.strip` (`/binnacle strip`) the strip draws over the one row, and a press in
 * it opens the pane. The desktop app draws the band as one Svg with `/binnacle`
 * beside it as a Button.
 */
/**
 * Whether the band draws the done count in the accent now (motion sketch 1):
 * the `motion` option on, a task just done when the band first sees it. Starts
 * the cue there; one redraw ends it `COUNT_CUE_MS` later. In the rich and the
 * text look alike (the sketch's text cue); the critter never moves (R24).
 */
function countCueOn($: EngineInterface, ctx: ViewCtx, motion: boolean): boolean {
  if (!motion) return false
  const last = todoBlock(ctx.t).lastDone
  if (last === undefined) return false
  const name = `todo:${last.id}:${last.updatedAt}`
  if (!cueStarted(name) && ctx.now - last.updatedAt >= 0 && ctx.now - last.updatedAt < COUNT_CUE_FRESH_MS) cue($, name, ctx.now, COUNT_CUE_MS)
  return cueOn(name)
}

/**
 * The Show as row (R55): `Show as   1 pane   2 band   3 strip     0 keep`,
 * each a Button with its digit, which a bare digit typed in the empty prompt
 * presses; the style in force bold in the accent. Drawn only while the
 * person tries the styles (`ui.showAsTry`); `0 keep` ends it.
 */
function showAsRow(ctx: ViewCtx, $: EngineInterface): RenderElement {
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  const cur = showAsOption()
  const pick = (hotkey: string, v: string) => (
    <Button key={`band-show-${v}`} hotkey={hotkey} plain onPress={() => chooseShowAs($, v)}>
      {v === cur ? (
        <Text color={C.accent} bold>
          {v}
        </Text>
      ) : (
        v
      )}
    </Button>
  )
  return (
    <Box key="band-show-as" flexDirection="row" columnGap={3}>
      <Text bold>Show as</Text>
      {pick('1', 'pane')}
      {pick('2', 'band')}
      {pick('3', 'strip')}
      <Button key="band-show-keep" hotkey="0" plain dimColor onPress={() => keepShowAs($)}>
        keep
      </Button>
      <Text dimColor>type the digit in the empty prompt</Text>
    </Box>
  )
}

export function registerBand(on: On, options: { look?: string; ground?: unknown; accent?: unknown; motion?: unknown } = {}): void {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    try {
      const t = await readTimeline($)
      const u: UiState = await readUi($)
      const pr = await readPr($)
      const now = await $.clock.now()
      const m = bandModel(t, u, now, needsLimits(), paneCovered(now), paneWatching(now))
      const isStrip = u.strip === true
      const trying = u.showAsTry === true
      // R56: the band is never empty; an empty session shows the companion (below, once ctx is built).

      const cols = e.props.bodyColumns
      // The Rasters here are all still, so the paint clock never blits the band.
      begin(BAND_SITE)
      const theme = await themeOf($)
      const chosen = lookAsked(lookOption() ?? options.look, theme)
      const look = lookFor($.ui.resolve(e), e.surface, chosen !== undefined ? { look: chosen } : {})
      const ctx: ViewCtx = { e: e as RenderInput, t, u, cols, now, look, site: BAND_SITE, ground: groundOf(options.ground, theme), pr }
      if (!isStrip && !m.nothing) {
        // `/binnacle` stays pressable beside the Svg: a press opens the pane, as the command does.
        const svg = bandSvgOf($, { e: e as RenderInput, look, t, u, now, cols, model: m, ground: ctx.ground ?? 'night', pr, presses: [{ key: 'band-mc', label: MC, onPress: () => leaveStrip($) }] })
        if (svg !== null) return svg
      }
      // R55: while the person tries the Show as styles, their row sits on top of the band or the strip.
      const tryRow = trying ? showAsRow(ctx, $) : null
      const withTry = (el: RenderElement): RenderElement => {
        if (tryRow === null) return el
        const { Box } = $.ui.resolve(e)
        return (
          <Box key="band-with-try" flexDirection="column">
            {tryRow}
            {el}
          </Box>
        )
      }
      const maxRows = e.props.maxRows - (tryRow !== null ? 1 : 0)
      if (m.nothing && !isStrip) {
        const room = Math.max(1, cols - CRITTER_COLUMNS - CRITTER_GAP)
        return withTry(peekRow(ctx, $, spread([dim(READY_WORDS)], [dim(MC)], room)))
      }
      // R56: at idle the companion peeks beside the dim summary.
      if (m.form === 'idle' && !isStrip) return withTry(peekRow(ctx, $, oneRow(m, Math.max(1, cols - CRITTER_COLUMNS - CRITTER_GAP))))
      const one = line(ctx, $, 'band', oneRow(m, cols))
      if (isStrip) return withTry(stripBandView(ctx, $, { maxRows, line: one, after: () => leaveStrip($) }))
      const two = u.paneOpen !== true && cols >= TWO_ROWS_FROM && maxRows >= 2 && m.form !== 'idle'
      return withTry(two ? twoRows(ctx, $, m, countCueOn($, ctx, motionOn(options.motion))) : one)
    } catch (err) {
      debug($, `band failed: ${errText(err)}`)
      return next(e)
    }
  })
}
