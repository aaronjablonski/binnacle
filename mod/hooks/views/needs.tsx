import type { EngineInterface, RenderElement } from 'claude-code'

import type { AgentRow, NotifyMode, Timeline, UiState } from '../../types'
import { alertNotes, answeredAsks, autoFocuses, CHECKING_TEXT, headerState, needs, spanText } from '../model/alerts'
import type { Need, NeedsView } from '../model/alerts'
import { oneLine } from '../model/label'
import { ASK_MS, NOTIFY_ASK_MS } from '../model/limits'
import { cacheLine, doneTurn, notifies, runLimits, thisTurn, turnClock } from '../model/meter'
import type { RunLimits } from '../model/meter'
import { problems, summary } from '../model/select'
import type { Problem } from '../model/select'
import { apply, debug, errText, readTimeline, readUi, updateUi } from '../state'
import { elapsed, fitRuns, shortPaths, span, toolName, wordFit, wrapWords } from './fit'
import { openStepInline } from './openstep'
import { allClear, inst, runText, section } from './parts'
import type { Run } from './parts'
import type { ViewCtx } from './shell'
import { C, CK, COCKPIT, critterArgs, critterOf, edges, podOf } from './style'
import type { CritterArgs, Pod, PodState } from './style'

// The ask delays live in the model now (limits.ts; the rule is alerts.ts's `needs`).
export { ASK_MS, NOTIFY_ASK_MS }
/** A subagent's finish and a failed turn are raised only while this fresh, so a restore does not replay old ones. */
const FRESH_MS = 15_000
// The warm countdown's words change once a minute (`warmWords`, R40), so it redraws once a minute.
const COUNTDOWN_REDRAW_MS = 60_000
/** Agent-finished toasts wait this long for the others still running, so a batch folds into one (R36). */
const FOLD_HOLD_MS = 2_000
let foldSince: number | undefined

export type { NotifyMode }

// The options the clock's tick and `needsYou` read: the long-run limits and
// the done sound. Module state set once by `configureNeeds` at register time
// (a render hook may not read options, and the shell's tick passes only
// `notify`). A reload starts them over from the options again.
let limits: RunLimits = runLimits(undefined)
let doneSound = false
let watchNotify = false

/** Sets the limits `needsYou` passes to `problems`, whether a done notification also plays a sound, and whether Watch rows notify (R10). Register time. */
export function configureNeeds(o: { agentLimitMin?: unknown; turnLimitMin?: unknown; doneSound?: unknown; watchNotify?: unknown } | undefined): void {
  limits = runLimits(o)
  doneSound = o?.doneSound === true
  watchNotify = o?.watchNotify === true
}

/** The long-run limits in force (minutes; 0 is off). */
export const needsLimits = (): Required<RunLimits> => runLimits(limits)

/**
 * The legacy combined list (needs, watch rows, failed turns), for the views
 * wave 2 has not reached yet (the band, Agents, Tasks, the run board): an ask
 * shows at once unless it came in auto mode, where it waits ASK_MS (R2; they
 * have no `isPromptCovered`). Now reads `needsView` and watch.tsx instead.
 * Watch rows never take autoFocus (`focusable`).
 */
export function needsYou(t: Timeline, u: UiState, now: number): Problem[] {
  return problems(t, now, u.dismissed, limits, {})
}

/** Whether a problem's row may take autoFocus: a need only, never a watch row or a failed turn. */
export const focusable = (p: Problem): boolean => p.kind === 'asking' && autoFocuses(p.need ?? 'permission')

/** One line for a problem: the kind's wording around its label. */
export function problemText(p: Problem): string {
  const label = oneLine(p.label)
  switch (p.kind) {
    case 'asking':
      return label
    case 'repeat':
      return `${label} failed ×${p.count ?? 2}`
    case 'loop':
      return `${label} looped ×${p.count ?? 3}`
    case 'stalled':
      return `${label} stalled`
    case 'long-run':
      return `${label} long run`
    default:
      return `turn failed: ${label}`
  }
}

/** The kind as a label-column word (ten wide at most), for the NEEDS YOU rows and the band: `PERMISSION`, `LONG RUN`, `STALLED`. */
export function kindLabel(p: Problem): string {
  switch (p.kind) {
    case 'asking':
      return 'PERMISSION'
    case 'long-run':
      return 'LONG RUN'
    case 'stalled':
      return 'STALLED'
    case 'repeat':
      return 'FAILED'
    case 'loop':
      return 'LOOP'
    default:
      return 'TURN FAILED'
  }
}

/** The detail that sits beside the kind: how long it has run against its limit, how quiet it is, how often it failed. */
export function needDetail(p: Problem, now: number): string {
  switch (p.kind) {
    case 'asking':
      return `asked ${elapsed(p.since, now)} ago`
    case 'long-run': {
      const start = p.since - (p.limitMs ?? 0)
      // R27 durations: `64 min` reads `1 h 4 min`; the limit in minutes, as the option sets it.
      return `${spanText(Math.max(0, now - start))} of ${Math.round((p.limitMs ?? 0) / 60_000)} min`
    }
    case 'stalled':
      return `quiet ${elapsed(p.since, now)}`
    case 'repeat':
      return `failed ×${p.count ?? 2}`
    case 'loop':
      return `looped ×${p.count ?? 3}`
    default:
      return 'failed'
  }
}

// Which item of NEEDS YOU is opened. Ephemeral pane state like onscreen.ts's:
// a render hook may not write `$.state`, and a reload starting at the first
// item loses nothing.
let openedAt = 0

/** The opened item's index in a list of `count`. */
export function openedNeed(count: number): number {
  return count <= 0 ? 0 : Math.max(0, Math.min(openedAt, count - 1))
}

/** `n` and `p`: opens the next or previous item (wrapping), and redraws. Press handlers only. */
export function moveNeed($: EngineInterface, delta: 1 | -1, count: number): void {
  if (count <= 0) return
  openedAt = (openedNeed(count) + delta + count) % count
  try {
    $.ui.invalidate('ui.render')
  } catch (err) {
    debug($, `invalidate failed: ${errText(err)}`)
  }
}

// ---------- the crew: who asks, who stalled ----------

/** The agents the problems point at: an ask is `waiting` (the hull's `?`), a stall `stalled` (`z`). Waiting wins. */
export function waitStates(t: Timeline, u: UiState, now: number): Map<string, PodState> {
  const out = new Map<string, PodState>()
  for (const p of needsYou(t, u, now)) {
    if (p.kind === 'asking') out.set(p.agent, 'waiting')
    else if (p.kind === 'stalled' && !out.has(p.agent)) out.set(p.agent, 'stalled')
  }
  return out
}

/** An agent as a pod, with its state taken from `waits` (else from its status). */
export function podFor(a: AgentRow, waits: Map<string, PodState>, now: number): Pod {
  const state = waits.get(a.id)
  return podOf({ id: a.id, type: a.type, status: a.status, ...(state !== undefined ? { state } : {}) }, now)
}

/** The state pill's word and colour: waiting on the person, working, all done, or idle. */
export function paneState(ctx: ViewCtx): { word: string; color: string } {
  const { t, u, now } = ctx
  if (needsYou(t, u, now).length > 0) return { word: 'WAITING', color: C.wait }
  const working =
    t.steps.some(x => x.status === 'running') ||
    t.tasks.some(x => x.status === 'in_progress') ||
    Object.values(t.agents).some(a => a.id !== 'main' && a.status === 'running')
  if (working) return { word: 'WORKING', color: C.live }
  const s = summary(t)
  if (s.total > 0 && s.done === s.total) return { word: 'ALL DONE', color: C.subtle }
  return { word: 'IDLE', color: C.subtle }
}

// ---------- the needs slot (cockpit spec "CockpitNowNeedsYou", R1 to R5) ----------
//
// One slot under the header, always at the same row: the all-clear line
// when nothing blocks the session, a dim "Checking a permission" while an
// auto-mode ask is being settled (R2), else the Needs you block. Needs come
// from the alert model's `needs` selector (no dismissals: no `x` on a need).

// What the pane last saw of the prompt (F C1). Ephemeral pane state like
// onscreen.ts's: a drawing notes its own `isPromptCovered` here and writes no
// `$.state`; the clock reads it and records on the Timeline the asks whose
// dialog it saw close (`step.unask`). Only the terminal pane is read: the
// prop speaks of the terminal's keys, and another surface's drawing (with no
// prop) must not read as "the dialog closed". A reload starts it empty, which
// only delays a clear until the step ends. Bounded by MAX_COVERED.
const MAX_COVERED = 50
// `coveredAt` and `uncoveredAt` hold the drawing's number (`seq`), not the time: two drawings in one millisecond keep their order.
const cover: { seq: number; coveredAt: Map<string, number>; uncoveredAt?: number; drawnAt?: number } = { seq: 0, coveredAt: new Map() }
/** The pane counts as watching the prompt while its last terminal drawing is this fresh (it redraws every second while a step runs). */
const WATCHING_MS = 5_000

/**
 * Notes what a terminal drawing of the pane saw (no `$.state`, no redraw):
 * covered, each asking step is marked seen covered by this drawing;
 * uncovered, this drawing is the latest without a dialog. O(steps). Any
 * other site or surface is ignored.
 */
export function observeCover(ctx: Pick<ViewCtx, 't' | 'now' | 'isPromptCovered'> & Partial<Pick<ViewCtx, 'e'>>): void {
  const e = ctx.e
  if (e === undefined || e.component !== 'Pane' || e.surface !== 'terminal') return
  cover.drawnAt = ctx.now
  const seq = ++cover.seq
  if (ctx.isPromptCovered !== true) {
    cover.uncoveredAt = seq
    return
  }
  for (const s of ctx.t.steps) {
    if (s.status !== 'running' || s.asking === undefined) continue
    cover.coveredAt.delete(s.id)
    cover.coveredAt.set(s.id, seq)
  }
  while (cover.coveredAt.size > MAX_COVERED) cover.coveredAt.delete(cover.coveredAt.keys().next().value!)
}

/** Forgets what the pane saw (tests; a new session). */
export function resetCover(): void {
  cover.seq = 0
  cover.coveredAt.clear()
  delete cover.uncoveredAt
  delete cover.drawnAt
}

/** Whether the terminal pane drew lately, so an answered ask is cleared and permission notifications may be raised (`alertNotes` `watching`). */
export function paneWatching(now: number): boolean {
  return cover.drawnAt !== undefined && now - cover.drawnAt <= WATCHING_MS
}

/**
 * The clock's half of F C1: the asks the pane saw covered and then
 * uncovered are taken off the Timeline (`step.unask`), and forgotten here.
 * Clock only (it writes state). Returns how many were cleared.
 */
async function clearAnswered($: EngineInterface, t: Timeline): Promise<number> {
  for (const id of cover.coveredAt.keys()) {
    const s = t.steps.find(x => x.id === id)
    if (s === undefined || s.status !== 'running' || s.asking === undefined) cover.coveredAt.delete(id)
  }
  const ids = answeredAsks(t, cover.coveredAt, cover.uncoveredAt)
  for (const id of ids) {
    await apply($, { kind: 'step.unask', id })
    cover.coveredAt.delete(id)
  }
  return ids.length
}

/** What blocks the session now, with the pane's `isPromptCovered` (R2: covered, an ask shows at once). A terminal pane's drawing also notes what it saw (`observeCover`). */
export function needsView(ctx: Pick<ViewCtx, 't' | 'now' | 'isPromptCovered'> & Partial<Pick<ViewCtx, 'e'>>): NeedsView {
  observeCover(ctx)
  return needs(ctx.t, ctx.now, { covered: ctx.isPromptCovered === true })
}

/**
 * The needs view a card's `doing` reads (F I1): the same answer as `needsView`
 * but without noting what the pane saw, so a card may ask it as often as it likes.
 */
export function doingView(ctx: Pick<ViewCtx, 't' | 'now' | 'isPromptCovered'>): NeedsView {
  return needs(ctx.t, ctx.now, { covered: ctx.isPromptCovered === true })
}

/** The needs slot's line under a stopped turn (F I2): no tick, plain words. */
export const STOPPED_TEXT = 'Stopped. Send a prompt to carry on'

/** The count and noun a Needs you head sums up to: "1 permission", "2 questions", "3 asks" when the kinds differ. */
export function needsSum(items: readonly Need[]): { n: number; noun: string } {
  const n = items.length
  const kinds = new Set(items.map(x => x.kind))
  const one = kinds.size === 1 ? [...kinds][0] : undefined
  const word = one === 'permission' ? 'permission' : one === 'question' ? 'question' : one === 'plan' ? 'plan' : one === 'input' ? 'input request' : 'ask'
  return { n, noun: n === 1 ? word : `${word}s` }
}

/** A need's press: the asking step opened in place, else the Steps tab filtered to the asker. */
export async function openNeed($: EngineInterface, n: Need): Promise<void> {
  if (n.stepId !== undefined) {
    await openStepInline($, n.stepId)
    return
  }
  await updateUi($, u => {
    const { detail: _detail, ...rest } = u
    return { ...rest, tab: 'timeline', filter: n.agent === 'main' ? { kind: 'all' } : { kind: 'agent', id: n.agent } }
  })
}

/** The asker's critter, waiting (`?`): the lead's, or a subagent's from its row. */
export function askerCritter(ctx: ViewCtx, n: Need, size: 'small' | 'micro' = 'small'): CritterArgs {
  const o = { size, ground: ctx.ground ?? 'night' }
  if (n.agent === 'main') return critterArgs('lead', 'waiting', o)
  const a = ctx.t.agents[n.agent]
  return critterOf({ id: n.agent, type: a?.type ?? n.agent, status: a?.status ?? 'running' }, { ...o, state: 'waiting' })
}

/**
 * The words in place of a control (R3, R39): no call hands the keys back to
 * the prompt, so nothing pretends to be a button, yet the row keeps the
 * mock's weight: an amber filled chip that is plain Text, ` esc  back to the
 * prompt ` while the pane holds the keys, ` answer in the prompt ↓ `
 * otherwise. A permission adds "allow or deny" after it when it fits.
 * Under `room` columns the chip's words shorten (` esc  to the prompt `,
 * ` esc  prompt `).
 */
export function promptRuns(n: Pick<Need, 'kind'>, isFocused: boolean, room = Infinity): Run[] {
  const forms = isFocused ? [' esc  back to the prompt ', ' esc  to the prompt ', ' esc  prompt '] : [' answer in the prompt ↓ ', ' in the prompt ↓ ', ' prompt ↓ ']
  const form = forms.find(f => f.length <= room) ?? forms[forms.length - 1]!
  const chip: Run = { text: form, color: CK.inverse, bg: CK.ask, bold: true }
  const tail = n.kind === 'permission' ? (isFocused ? '  then allow or deny' : '  allow or deny') : ''
  return tail !== '' && form.length + tail.length <= room ? [chip, { text: tail, dim: true }] : [chip]
}

/** What the opened need's second row says: the tool in amber bold and its command bold; the question, plan or message bold. */
export function askRuns(n: Need): Run[] {
  const cmd = (n.kind === 'input' ? n.message ?? '' : n.command ?? '').replace(/\s+/g, ' ').trim()
  if (n.kind === 'permission' && n.tool !== undefined) {
    return [{ text: toolName(n.tool, 12), color: CK.ask, bold: true }, ...(cmd !== '' ? [{ text: `  ${shortPaths(cmd)}`, bold: true }] : [])]
  }
  return cmd !== '' ? [{ text: shortPaths(cmd), bold: true }] : [{ text: n.verb, dim: true }]
}

/**
 * The opened need's sentence at `cols` (F I5): one row with "asked 40s ago" beside it when both fit, else the
 * sentence alone, else the sentence wrapped to two rows.
 */
export function needSentence(n: Pick<Need, 'who' | 'verb' | 'since'>, now: number, cols: number): { fitsAge: boolean; lines: string[] } {
  const { right } = edges(cols)
  const room = Math.max(1, right - COCKPIT.text + 1)
  const sentence = `${n.who} ${n.verb}`
  const fitsAge = sentence.length + 2 + `asked ${spanText(now - n.since)} ago`.length <= room
  return { fitsAge, lines: fitsAge || sentence.length <= room ? [sentence] : wrapWords(sentence, room, 2) }
}

/** Rows of the slot for `view`, `cap` other needs listed: 1, or the head, the opened need's 3 (4 when its sentence wraps, with `cols`) and the rest. */
export function needsSlotHeight(view: NeedsView, cap = 3, o: { cols?: number; now?: number } = {}): number {
  if (view.items.length === 0) return 1
  const others = view.items.length - 1
  const shown = Math.min(others, cap)
  const wraps = o.cols !== undefined && o.now !== undefined && needSentence(view.items[openedNeed(view.items.length)]!, o.now, o.cols).lines.length > 1
  return 1 + 3 + (wraps ? 1 : 0) + shown + (others > shown ? 1 : 0)
}

/**
 * The needs slot (cockpit spec principle 1: the same row with and without an
 * ask). Nothing waits: `✓ Nothing needs you` and `watchCount` as " · 2 things
 * to watch". An auto-mode ask still settling: no tick, a dim "Checking a
 * permission" (R2). Under a stopped turn no tick either, the plain
 * `STOPPED_TEXT`; after a request that ended with tasks open, a dim "5 to do
 * still open" (F I2). Otherwise the Needs you block: the amber head with the
 * count and noun; the opened need (the first, until `n` moves it) as three
 * rows behind an amber `▍`: the asker's critter waiting at 2, the sentence
 * at 9 (the asker bold unless ambiguous, R4) and "asked 40s ago" at the
 * right, the tool and command, then the words in place of a control (R3);
 * the other needs one row each (up to `cap`, then `+ n more`). The opened
 * row is a plain Button that takes the pane's focus (`autoFocus`) and opens
 * the asking step. The caller adds the blank row after it.
 */
export function needsSlot(
  ctx: ViewCtx,
  $: EngineInterface,
  view: NeedsView,
  o: { watchCount?: number; cap?: number; press?: (f: () => void | Promise<void>) => () => void | Promise<void> } = {},
): RenderElement[] {
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  const { now } = ctx
  const { left, right } = edges(ctx.cols)
  const press = o.press ?? ((f: () => void | Promise<void>) => f)
  const watchCount = o.watchCount ?? 0
  const extra = watchCount > 0 ? ` · ${watchCount} ${watchCount === 1 ? 'thing' : 'things'} to watch` : ''
  if (view.items.length === 0) {
    // F I2: no green tick under a stopped turn or a request that ended with tasks open.
    const hs = view.checking ? undefined : headerState(ctx.t, now, view)
    const words: Run | undefined =
      view.checking ? { text: CHECKING_TEXT, dim: true }
      : hs?.state === 'stopped' ? { text: STOPPED_TEXT }
      : hs?.state === 'idle-open' ? { text: `${hs.open} to do still open`, dim: true }
      : undefined
    if (words === undefined) return [allClear(ctx, $, extra)]
    const runs = fitRuns([words, ...(extra !== '' ? [{ text: extra, dim: true }] : [])], right - left + 1) as Run[]
    return [
      <Text key="all-clear" wrap="truncate-end">
        {' '.repeat(left)}
        {runs.filter(r => r.text !== '').map((r, i) => runText(r, ctx.e, $, `checking-${i}`))}
      </Text>,
    ]
  }
  const items = view.items
  const at = openedNeed(items.length)
  const n = items[at]!
  const sum = needsSum(items)
  const out: RenderElement[] = [
    section(ctx, $, 'Needs you', [{ text: String(sum.n), color: CK.ask, bold: true }, { text: ` ${sum.noun}`, color: CK.ask }], { tone: 'ask', key: 'sec-needs' }),
  ]
  const textCol = COCKPIT.text
  const room = Math.max(1, right - textCol + 1)
  const fit = (runs: Run[]): Run[] => (fitRuns(runs, room) as Run[]).filter(r => r.text !== '')
  const age: Run[] = [{ text: `asked ${spanText(now - n.since)} ago`, dim: true }]
  const who: Run = { text: n.who, ...(n.askerAmbiguous ? {} : { bold: true }) }
  // F I5: "asked 40s ago" goes before any of the sentence is cut, and the sentence wraps to a second row before it is cut.
  const { fitsAge, lines } = needSentence(n, now, ctx.cols)
  const runsOfLine = (line: string, i: number): Run[] => {
    const head = i === 0 ? Math.min(line.length, who.text.length) : 0
    return [{ text: line.slice(0, head), ...(who.bold === true ? { bold: true } : {}) }, { text: line.slice(head) }].filter(r => r.text !== '')
  }
  const first = fitsAge ? spreadRuns([who, { text: ` ${n.verb}` }], age, room) : runsOfLine(lines[0]!, 0)
  const second = lines[1] !== undefined ? runsOfLine(lines[1], 1) : undefined
  const key = `open-${n.key}`
  const marker = (k: string): RenderElement => (
    <Text key={k} color={CK.ask}>
      {'▍'}
    </Text>
  )
  out.push(
    <Box key="need-open" flexDirection="row">
      <Box key="need-marks" flexDirection="column" width={left} flexShrink={0}>
        {Array.from({ length: 3 + (second !== undefined ? 1 : 0) }, (_, i) => marker(`need-mark-${i}`))}
      </Box>
      <Box key="need-who" width={textCol - left} flexShrink={0}>
        {inst(ctx, $, { key: 'asker', ...askerCritter(ctx, n) })}
      </Box>
      <Box key="need-lines" flexDirection="column" width={room} flexShrink={0}>
        <Button key={key} plain autoFocus={autoFocuses(n.kind) ? true : undefined} onPress={press(() => openNeed($, n))}>
          {first.map((r, i) => runText(r, ctx.e, $, `${key}-${i}`))}
        </Button>
        {second !== undefined ? (
          <Text key="need-sentence-2" wrap="truncate-end">
            {second.map((r, i) => runText(r, ctx.e, $, `need-sentence-2-${i}`))}
          </Text>
        ) : null}
        <Text key="need-ask" wrap="truncate-end">
          {fit(askRuns(n)).map((r, i) => runText(r, ctx.e, $, `need-ask-${i}`))}
        </Text>
        <Text key="need-prompt" wrap="truncate-end">
          {promptRuns(n, ctx.isFocused === true, room).map((r, i) => runText(r, ctx.e, $, `need-prompt-${i}`))}
        </Text>
      </Box>
    </Box>,
  )
  const cap = o.cap ?? 3
  const others = items.filter((_, i) => i !== at)
  others.slice(0, cap).forEach(x => {
    const k = `open-${x.key}`
    const runs = spreadRuns([{ text: x.sentence, dim: true }], [{ text: spanText(now - x.since), dim: true }], room)
    out.push(
      <Box key={`row-${k}`} flexDirection="row">
        <Text>{' '.repeat(textCol)}</Text>
        <Button key={k} plain onPress={press(() => openNeed($, x))}>
          {runs.map((r, i) => runText(r, ctx.e, $, `${k}-${i}`))}
        </Button>
      </Box>,
    )
  })
  if (others.length > cap) {
    out.push(
      <Text key="need-more" dimColor wrap="truncate-end">
        {`${' '.repeat(textCol)}+ ${others.length - cap} more`}
      </Text>,
    )
  }
  return out
}

/** `left` cut to leave `right` and two spaces, `right` flush at the end of `cols`. */
export function spreadRuns(left: Run[], right: Run[], cols: number): Run[] {
  const rw = right.reduce((n, r) => n + r.text.length, 0)
  if (rw === 0 || rw + 2 > cols) return (fitRuns(left, cols) as Run[]).filter(r => r.text !== '')
  const l = (fitRuns(left, cols - rw - 2) as Run[]).filter(r => r.text !== '')
  const lw = l.reduce((n, r) => n + r.text.length, 0)
  return [...l, { text: ' '.repeat(cols - lw - rw) }, ...right]
}

/** A main turn this long or longer, ended normally, raises the done notification. */
export const DONE_MS = 60_000

/** `Done in 6m 12s: the focus. 3 tasks closed, 1 error.` */
export function doneText(t: Timeline, ms: number): string {
  const focus = summary(t).focus
  const turn = thisTurn(t)
  const bits: string[] = []
  if (turn !== undefined && turn.tasksClosed.length > 0) bits.push(`${turn.tasksClosed.length} ${turn.tasksClosed.length === 1 ? 'task' : 'tasks'} closed`)
  if (turn !== undefined && turn.errors > 0) bits.push(`${turn.errors} ${turn.errors === 1 ? 'error' : 'errors'}`)
  const head = `Done in ${span(ms, { steps: true })}${focus !== undefined ? `: ${wordFit(oneLine(focus), 80)}` : ''}`
  return bits.length > 0 ? `${head}. ${bits.join(', ')}.` : head
}

// The idle countdown's last redraw: the minute it showed, and whether
// the cold redraw (which clears the readout) was taken. Ephemeral.
const countdown: { bucket?: number; cold: boolean } = { cold: true }

/**
 * While the session is idle and the cache is warm, Now's budget line counts
 * it down in whole minutes (R40; plan constraint 5: idle is still).
 * The pane and the band are redrawn when the
 * whole minute the words name changes, whether or not the pane is open: with
 * the pane closed the band is the only surface, and its words must stay true
 * (O I-3). Once the cache is cold one redraw clears the words and the
 * countdown stops.
 */
async function countdownTick($: EngineInterface, t: Timeline, now: number): Promise<void> {
  const warm = cacheLine(t).warmUntil
  if (warm === undefined || turnClock(t, now) !== undefined) return
  const redraw = (): void => {
    try {
      $.ui.invalidate('ui.render')
    } catch (err) {
      debug($, `invalidate failed: ${errText(err)}`)
    }
  }
  if (warm <= now) {
    if (countdown.cold) return
    countdown.cold = true
    delete countdown.bucket
    redraw()
    return
  }
  countdown.cold = false
  const bucket = Math.floor((warm - now) / COUNTDOWN_REDRAW_MS)
  if (bucket === countdown.bucket) return
  countdown.bucket = bucket
  redraw()
}

/**
 * The clock's one call: first takes off the Timeline each ask the pane saw
 * answered (F C1, `clearAnswered`); then raises the notifications the alert
 * model decides (`alertNotes`: a need that has waited, a permission only
 * while the pane watches, a fresh failed turn with `all`, a Watch row that
 * has stood 10 min only with `watchNotify`), the done
 * notification, and a toast when a subagent has just finished. What was raised is recorded in
 * `ui` before it is sent. Runs from the clock callback, not a render hook, so
 * it may write state. Never throws.
 */
export async function needsTick($: EngineInterface, notify: NotifyMode | undefined): Promise<void> {
  try {
    let t = await readTimeline($)
    const u = await readUi($)
    const now = await $.clock.now()
    const mode = notify ?? 'waits'
    // F C1: an ask whose dialog the pane saw close is answered; the Timeline says so before anything reads it.
    if ((await clearAnswered($, t)) > 0) t = await readTimeline($)
    await countdownTick($, t, now)

    const notes: { id: string; text: string }[] = alertNotes(t, u, now, { mode, watchNotify, limits, freshMs: FRESH_MS, watching: paneWatching(now) })
    let doneId: string | undefined
    // One notification when a main turn of a minute or more ended normally.
    if (notifies(mode, 'done')) {
      const d = doneTurn(t, DONE_MS - 1)
      const endedAt = d?.turn.endedAt
      if (d !== undefined && endedAt !== undefined && now - endedAt <= FRESH_MS) {
        const id = `done:${d.turn.id}`
        if (!u.notified.includes(id)) {
          doneId = id
          notes.push({ id, text: doneText(t, d.ms) })
        }
      }
    }
    const toasts: { id: string; text: string }[] = []
    for (const a of Object.values(t.agents)) {
      if (a.id === 'main' || a.status === 'running' || a.endedAt === undefined) continue
      const id = `agent-done:${a.id}`
      if (now - a.endedAt > FRESH_MS || u.toasted.includes(id)) continue
      // A workflow agent's answer is empty and its doing is its last step: its result says more.
      const result = a.result !== undefined ? oneLine(a.result) : ''
      const first = result !== '' ? result : oneLine(a.doing.split('\n')[0] ?? '')
      toasts.push({ id, text: `${a.type} finished${first !== '' ? `: ${first}` : ''}` })
    }
    // R36: finishes fold into one toast. While other agents still run, the first finish waits a moment for the rest.
    const othersRunning = Object.values(t.agents).some(a => a.id !== 'main' && a.status === 'running')
    if (toasts.length === 0) foldSince = undefined
    else if (othersRunning && (foldSince === undefined || now - foldSince < FOLD_HOLD_MS)) {
      foldSince ??= now
      toasts.length = 0
    } else foldSince = undefined
    if (notes.length === 0 && toasts.length === 0) return

    await updateUi($, cur => ({
      ...cur,
      notified: [...cur.notified, ...notes.map(n => n.id).filter(id => !cur.notified.includes(id))],
      toasted: [...cur.toasted, ...toasts.map(x => x.id).filter(id => !cur.toasted.includes(id))],
    }))
    for (const n of notes) {
      try {
        await $.ui.notify(n.text)
      } catch (err) {
        debug($, `notify failed: ${errText(err)}`)
      }
      if (n.id === doneId && doneSound) {
        try {
          await $.audio.play({ asset: 'sounds/done.wav' })
        } catch (err) {
          debug($, `done sound failed: ${errText(err)}`)
        }
      }
    }
    if (toasts.length > 0) $.ui.toast(toasts.length === 1 ? toasts[0]!.text : `${toasts.length} agents finished`)
  } catch (err) {
    debug($, `needs tick failed: ${errText(err)}`)
  }
}
