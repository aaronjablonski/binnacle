import type { EngineInterface, RenderElement } from 'claude-code'

import type { AgentRow, NotifyMode, Step, Timeline } from '../../types'
import { alertNotes, answeredAsks, askedVerb, autoFocuses, CHECKING_TEXT, headerState, needs, settledAsks, spanText, watch } from '../model/alerts'
import type { Need, NeedsOptions, NeedsView, Watch } from '../model/alerts'
import { oneLine } from '../model/label'
import { ASK_MS, NOTIFY_ASK_MS } from '../model/limits'
import { cacheLine, doneTurn, notifies, runLimits, thisTurn, turnClock } from '../model/meter'
import type { RunLimits } from '../model/meter'
import { headline } from './bandmodel'
import { apply, debug, errText, readTimeline, readUi, updateUi } from '../state'
import { fitRuns, shortPaths, span, toolName, wordFit, wrapWords } from './fit'
import { openStepInline } from './openstep'
import { allClear, inst, runText, section } from './parts'
import type { Run } from './parts'
import { clockLive } from './shell'
import type { ViewCtx } from './shell'
import { cue, cueOn, cueStarted } from './paint'
import { APPEAR_FRESH_MS, CK, COCKPIT, critterArgs, critterOf, edges, podOf, typeName } from './style'
import type { CritterArgs, Pod, PodState } from './style'

// The ask delays live in the model now (limits.ts; the rule is alerts.ts's `needs`).
export { ASK_MS, NOTIFY_ASK_MS }
/** A subagent's finish and a failed turn are raised only while this fresh, so a restore does not replay old ones. */
const FRESH_MS = 15_000
// The warm countdown's words change once a minute (`warmWords`, R40), so it redraws once a minute.
const COUNTDOWN_REDRAW_MS = 60_000
/** Agent-finished toasts wait this long for the others still running, so a batch folds into one (R36, M13). */
export const FOLD_HOLD_MS = 30_000
/**
 * Motion sketch 3: an agent-finished toast waits until its newest finish is
 * this old, so it goes up after the card's nod, fade and fold (1 s) and
 * finishes that land together fold into one toast.
 */
export const FINISH_HOLD_MS = 1500
/** At most one agent-finished toast this often (M13): forty agents ending over an hour are not forty toasts. */
export const TOAST_EVERY_MS = 60_000
/** A finish waits for its toast at most this long (the fold and the rate limit). */
const TOAST_FRESH_MS = FOLD_HOLD_MS + TOAST_EVERY_MS + 15_000
const MAX_SEEN_FINISHES = 400
// When the first finish still unshown was seen, and when the last agent toast went up. Ephemeral: a reload starts them over.
let foldSince: number | undefined
let toastAt: number | undefined
// Each finish as the clock first saw it: true when it was fresh then (FRESH_MS) and may be toasted,
// false when it was already old (a restore, a reload), so a held toast never replays one.
const seenFinish = new Map<string, boolean>()

export type { NotifyMode }

// The options the clock's tick and `needsYou` read: the long-run limits and
// the done sound. Module state set once by `configureNeeds` at register time
// (a render hook may not read options, and the shell's tick passes only
// `notify`). A reload starts them over from the options again.
let limits: RunLimits = runLimits(undefined)
let doneSound = false
let watchNotify = false

/** Sets the limits the crew's Watch reads (`crewAlerts`), whether a done notification also plays a sound, and whether Watch rows notify (R10). Register time. */
export function configureNeeds(o: { agentLimitMin?: unknown; turnLimitMin?: unknown; doneSound?: unknown; watchNotify?: unknown } | undefined): void {
  limits = runLimits(o)
  doneSound = o?.doneSound === true
  watchNotify = o?.watchNotify === true
  // A (re)load starts the toast fold and its rate limit over.
  foldSince = undefined
  toastAt = undefined
  seenFinish.clear()
}

/** The long-run limits in force (minutes; 0 is off). */
export const needsLimits = (): Required<RunLimits> => runLimits(limits)

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

/** What the crew views read of the alert model, from the same selectors as Now (I-2). */
export type CrewAlerts = {
  /** The needs as the pane shows them (`isPromptCovered` applied). */
  view: NeedsView
  /** The Watch rows not dismissed, under the limits in force: Now's Watch, row for row. */
  rows: Watch[]
  /** An agent with a need is `waiting` (`?`); one with a Stalled step or a Quiet row `stalled` (`z`), as Now's cards doze. Waiting wins. */
  states: Map<string, PodState>
  /** The agents with a need or a Watch row: the rows `n`/`p` visit. */
  ids: Set<string>
  /** When each asking agent's oldest need was raised. */
  since: Map<string, number>
}

/** The crew's alerts: Now's `needs` and `watch` selectors, so every tab says the same of an agent. Pure; writes nothing. */
export function crewAlerts(ctx: Pick<ViewCtx, 't' | 'u' | 'now' | 'isPromptCovered'> & Partial<Pick<ViewCtx, 'e'>>): CrewAlerts {
  const view = doingView(ctx)
  const rows = watch(ctx.t, ctx.now, ctx.u.dismissed, limits)
  const states = new Map<string, PodState>()
  const since = new Map<string, number>()
  for (const n of view.items) {
    states.set(n.agent, 'waiting')
    if (!since.has(n.agent)) since.set(n.agent, n.since)
  }
  for (const w of rows) if ((w.kind === 'stalled' || w.kind === 'quiet') && !states.has(w.agent)) states.set(w.agent, 'stalled')
  const ids = new Set<string>([...view.items.map(n => n.agent), ...rows.map(w => w.agent)])
  return { view, rows, states, ids, since }
}

/** The agents' wait states (`crewAlerts(ctx).states`). */
export function waitStates(ctx: Pick<ViewCtx, 't' | 'u' | 'now' | 'isPromptCovered'> & Partial<Pick<ViewCtx, 'e'>>): Map<string, PodState> {
  return crewAlerts(ctx).states
}

/** An agent as a pod, with its state taken from `waits` (else from its status). */
export function podFor(a: AgentRow, waits: Map<string, PodState>, now: number): Pod {
  const state = waits.get(a.id)
  return podOf({ id: a.id, type: a.type, status: a.status, ...(state !== undefined ? { state } : {}) }, now)
}

// ---------- the needs slot (cockpit spec "CockpitNowNeedsYou", R1 to R5) ----------
//
// One slot under the header, always at the same row: the all-clear line
// when nothing blocks the session, a dim "Checking a permission" while an
// auto-mode ask is being settled (R2), else the Needs you block. Needs come
// from the alert model's `needs` selector (no dismissals: no `x` on a need).

// What the pane last saw of the prompt (F C1, C-1). Ephemeral pane state like
// onscreen.ts's: a drawing notes its own `isPromptCovered` here and writes no
// `$.state`; the clock reads it and records on the Timeline the asks it saw
// settled (`step.unask`). Only the terminal pane is read: the prop speaks of
// the terminal's keys, and another surface's drawing (with no prop) must not
// read as "the dialog closed". A reload starts it empty, which only delays a
// clear by ASK_MS. Bounded by MAX_COVERED.
const MAX_COVERED = 50
/**
 * `coveredAt` and `uncoveredAt` hold the drawing's number (`seq`), not the
 * time: two drawings in one millisecond keep their order. `coveredSince` is
 * when the current run of covered drawings began, `clearSince` when the
 * current unbroken run of uncovered ones did (a gap past WATCHING_MS breaks
 * a run: the pane was not looking).
 */
const cover: {
  seq: number; coveredAt: Map<string, number>; uncoveredAt?: number; drawnAt?: number; covered?: boolean
  coveredSince?: number; clearSince?: number
} = { seq: 0, coveredAt: new Map() }
/** The pane counts as watching the prompt while its last terminal drawing is this fresh (it redraws every second while a step runs). */
const WATCHING_MS = 5_000

/**
 * Notes what a terminal drawing of the pane saw (no `$.state`, no redraw).
 * Covered: the oldest asking step is marked seen covered by this drawing,
 * and only when it was asked at or before this covered run began (M2: a
 * search, `/model` or a queued dialog opened before the ask is not its
 * dialog). Uncovered: this drawing is the latest without a dialog, and the
 * uncovered run goes on (or starts). O(steps). Any other site or surface is
 * ignored.
 */
export function observeCover(ctx: Pick<ViewCtx, 't' | 'now' | 'isPromptCovered'> & Partial<Pick<ViewCtx, 'e'>>): void {
  const e = ctx.e
  if (e === undefined || e.component !== 'Pane' || e.surface !== 'terminal') return
  const fresh = cover.drawnAt !== undefined && ctx.now - cover.drawnAt <= WATCHING_MS
  const covered = ctx.isPromptCovered === true
  const continues = fresh && cover.covered === covered
  cover.drawnAt = ctx.now
  cover.covered = covered
  const seq = ++cover.seq
  if (!covered) {
    cover.uncoveredAt = seq
    delete cover.coveredSince
    if (!continues || cover.clearSince === undefined) cover.clearSince = ctx.now
    return
  }
  delete cover.clearSince
  if (!continues || cover.coveredSince === undefined) cover.coveredSince = ctx.now
  let oldest: Step | undefined
  for (const s of ctx.t.steps) {
    if (s.status !== 'running' || s.asking === undefined) continue
    if (oldest === undefined || s.asking < oldest.asking!) oldest = s
  }
  if (oldest === undefined || oldest.asking! > cover.coveredSince) return
  cover.coveredAt.delete(oldest.id)
  cover.coveredAt.set(oldest.id, seq)
  while (cover.coveredAt.size > MAX_COVERED) cover.coveredAt.delete(cover.coveredAt.keys().next().value!)
}

/** Forgets what the pane saw (tests; a new session). */
export function resetCover(): void {
  cover.seq = 0
  cover.coveredAt.clear()
  delete cover.uncoveredAt
  delete cover.drawnAt
  delete cover.covered
  delete cover.coveredSince
  delete cover.clearSince
}

/** Whether the terminal pane drew lately, so an answered ask is cleared and permission notifications may be raised (`alertNotes` `watching`). */
export function paneWatching(now: number): boolean {
  return cover.drawnAt !== undefined && now - cover.drawnAt <= WATCHING_MS
}

/**
 * Whether the terminal pane's last drawing, if fresh, had a dialog holding the prompt. The band has no
 * `isPromptCovered` of its own, so it reads this: an ask the pane shows as Needs you at once (R2: covered)
 * is never "Checking a permission" in the band (FX3, M-3). Not drawn lately, it is false.
 */
export function paneCovered(now: number): boolean {
  return paneWatching(now) && cover.covered === true
}

/**
 * The clock's half of F C1 and C-1: the asks the pane saw covered and then
 * uncovered (answered at the dialog), and the asks it watched uncovered for
 * ASK_MS (settled with no dialog: `settledAsks`), are taken off the
 * Timeline (`step.unask`) and forgotten here. Clock only (it writes state).
 * Returns how many were cleared.
 */
async function clearAnswered($: EngineInterface, t: Timeline, now: number): Promise<number> {
  for (const id of cover.coveredAt.keys()) {
    const s = t.steps.find(x => x.id === id)
    if (s === undefined || s.status !== 'running' || s.asking === undefined) cover.coveredAt.delete(id)
  }
  const watching = paneWatching(now)
  const ids = new Set([
    ...answeredAsks(t, cover.coveredAt, cover.uncoveredAt),
    ...(watching && cover.covered !== true ? settledAsks(t, now, cover.clearSince) : []),
  ])
  for (const id of ids) {
    await apply($, { kind: 'step.unask', id })
    cover.coveredAt.delete(id)
  }
  return ids.size
}

/**
 * How a pane drawing reads the needs (I1). The terminal pane is the watcher:
 * its `isPromptCovered` says whether a dialog holds the prompt. A pane drawn
 * on another surface (desktop, VS Code) is not: the type file speaks of the
 * prop in terms of the terminal's keys, so where it is absent such a pane
 * reads as the band does with what the terminal pane saw, if it drew lately
 * (`paneCovered`, `paneWatching`), so with no terminal pane a permission is
 * a need for its first minute and then a dim "asked … · running". Where
 * such a surface does pass the prop, a covered drawing shows the ask at once.
 */
export function paneNeedsOptions(ctx: Pick<ViewCtx, 'now' | 'isPromptCovered'> & Partial<Pick<ViewCtx, 'e'>>): NeedsOptions {
  const covered = ctx.isPromptCovered === true
  const surface = ctx.e?.surface
  if (surface === undefined || surface === 'terminal') return { covered }
  const seen = paneCovered(ctx.now)
  return { covered: covered || seen, watching: covered || seen || paneWatching(ctx.now) }
}

/** What blocks the session now, with the pane's `isPromptCovered` (R2: covered, an ask shows at once). A terminal pane's drawing also notes what it saw (`observeCover`); another surface's reads as `paneNeedsOptions` says. */
export function needsView(ctx: Pick<ViewCtx, 't' | 'now' | 'isPromptCovered'> & Partial<Pick<ViewCtx, 'e'>>): NeedsView {
  observeCover(ctx)
  return needs(ctx.t, ctx.now, paneNeedsOptions(ctx))
}

/**
 * The needs view a card's `doing` reads (F I1): the same answer as `needsView`
 * but without noting what the pane saw, so a card may ask it as often as it likes.
 */
export function doingView(ctx: Pick<ViewCtx, 't' | 'now' | 'isPromptCovered'> & Partial<Pick<ViewCtx, 'e'>>): NeedsView {
  return needs(ctx.t, ctx.now, paneNeedsOptions(ctx))
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

/** How long a fresh ask's block stays at half strength (motion sketch 4): one frame, then full amber. */
export const ASK_SOFT_MS = 140

/**
 * Whether the opened need's block draws at half strength now (motion sketch
 * 4): the `motion` option on, the terminal (rich or text look; the desktop's
 * Svg stays still, R32), and the need fresh when first drawn. Starts its one
 * cue there: `ASK_SOFT_MS` later one redraw brings full amber. Never again
 * for that need.
 */
function softAsk(ctx: ViewCtx, $: EngineInterface, n: Need): boolean {
  if (ctx.motion !== true || ctx.e.surface !== 'terminal') return false
  const name = `ask:${n.key}:${n.since}`
  if (!cueStarted(name) && ctx.now - n.since >= 0 && ctx.now - n.since < APPEAR_FRESH_MS) cue($, name, ctx.now, ASK_SOFT_MS)
  return cueOn(name)
}

/** The asker's critter, waiting (`?`): the lead's, or a subagent's from its row. */
export function askerCritter(ctx: ViewCtx, n: Need, size: 'small' | 'micro' = 'small'): CritterArgs {
  // Motion sketch 4: the asker glances toward its badge and hops once when the ask arrives (pane only; `since` names the ask).
  const o = { size, ground: ctx.ground ?? 'night', motion: ctx.motion === true, since: n.since }
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

/**
 * The ask's rows at `room` columns (I5): `askRuns` on one row when it fits;
 * else the words go on to a second row before anything is cut: the tool and
 * the command's words that fit, then the rest of the command (cut at a word
 * only when even two rows cannot hold it).
 */
export function askLines(n: Need, room: number): Run[][] {
  const runs = askRuns(n)
  const width = runs.reduce((k, r) => k + r.text.length, 0)
  if (width <= room || room <= 0) return [runs]
  const toolRun = n.kind === 'permission' && n.tool !== undefined ? runs[0]! : undefined
  const body = (toolRun !== undefined ? runs.slice(1) : runs).map(r => r.text).join('').trim()
  const style = toolRun !== undefined || runs[0]?.bold === true ? { bold: true } : { dim: true }
  const words = body.split(' ').filter(w => w !== '')
  const lead = toolRun !== undefined ? toolRun.text.length + 2 : 0
  let head = ''
  let i = 0
  for (; i < words.length; i++) {
    const next = head === '' ? words[i]! : `${head} ${words[i]}`
    if (lead + next.length > room) break
    head = next
  }
  const rest = words.slice(i).join(' ')
  const first: Run[] = toolRun !== undefined ? [toolRun, ...(head !== '' ? [{ text: `  ${head}`, ...style }] : [])] : [{ text: head, ...style }]
  if (rest === '') return [first]
  const second: Run[] = [{ text: wordFit(rest, room), ...style }]
  return head === '' && toolRun === undefined ? [second] : [first, second]
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

/** Rows of the slot for `view`, `cap` other needs listed: 1, or the head, the opened need's 3 (one more when its sentence wraps, one more when its ask does, with `cols`) and the rest. */
export function needsSlotHeight(view: NeedsView, cap = 3, o: { cols?: number; now?: number } = {}): number {
  if (view.items.length === 0) return 1
  const others = view.items.length - 1
  const shown = Math.min(others, cap)
  const n = view.items[openedNeed(view.items.length)]!
  const wraps = o.cols !== undefined && o.now !== undefined && needSentence(n, o.now, o.cols).lines.length > 1
  const askWraps = o.cols !== undefined && askLines(n, askRoom(o.cols)).length > 1
  return 1 + 3 + (wraps ? 1 : 0) + (askWraps ? 1 : 0) + shown + (others > shown ? 1 : 0)
}

/** The opened need's text room at `cols`: from the text column to the right edge. */
const askRoom = (cols: number): number => Math.max(1, edges(cols).right - COCKPIT.text + 1)

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
    const asked = view.asked?.[0]
    const words: Run | undefined =
      view.checking ? { text: CHECKING_TEXT, dim: true }
      // I1: a permission nothing can see answered, past its first minute: dim, never the tick.
      : asked !== undefined ? { text: `${askedVerb(asked)} · running`, dim: true }
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
  // Motion sketch 4: a fresh ask's block comes in at half strength (dim amber) for one frame, then full amber; never again.
  const soft = softAsk(ctx, $, n)
  const amber = (r: Run): Run => (soft && r.color === CK.ask ? { ...r, dim: true } : r)
  const out: RenderElement[] = [
    section(ctx, $, 'Needs you', [{ text: String(sum.n), color: CK.ask, bold: true }, { text: ` ${sum.noun}`, color: CK.ask }].map(amber), { tone: soft ? 'askSoft' : 'ask', key: 'sec-needs' }),
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
  const asks = askLines(n, room)
  const key = `open-${n.key}`
  const marker = (k: string): RenderElement => (
    <Text key={k} color={CK.ask} {...(soft ? { dimColor: true } : {})}>
      {'▍'}
    </Text>
  )
  out.push(
    <Box key="need-open" flexDirection="row">
      <Box key="need-marks" flexDirection="column" width={left} flexShrink={0}>
        {Array.from({ length: 2 + asks.length + (second !== undefined ? 1 : 0) }, (_, i) => marker(`need-mark-${i}`))}
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
        {asks.map((runs, j) => (
          <Text key={j === 0 ? 'need-ask' : `need-ask-${j + 1}`} wrap="truncate-end">
            {fit(runs).map((r, i) => runText(r, ctx.e, $, `need-ask${j === 0 ? '' : `-${j + 1}`}-${i}`))}
          </Text>
        ))}
        <Text key="need-prompt" wrap="truncate-end">
          {promptRuns(n, ctx.isFocused === true, room).map((r, i) => runText(soft && r.bg === CK.ask ? { ...r, dim: true } : r, ctx.e, $, `need-prompt-${i}`))}
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

/** `Done in 6 min: the focus. 3 tasks closed, 1 error.` (R27: `6m 12s` is for Steps alone.) */
export function doneText(t: Timeline, ms: number): string {
  const h = headline(t)
  const focus = h.isIdle ? undefined : h.text
  const turn = thisTurn(t)
  const bits: string[] = []
  if (turn !== undefined && turn.tasksClosed.length > 0) bits.push(`${turn.tasksClosed.length} ${turn.tasksClosed.length === 1 ? 'task' : 'tasks'} closed`)
  if (turn !== undefined && turn.errors > 0) bits.push(`${turn.errors} ${turn.errors === 1 ? 'error' : 'errors'}`)
  const head = `Done in ${span(ms)}${focus !== undefined ? `: ${wordFit(oneLine(focus), 80)}` : ''}`
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
    if ((await clearAnswered($, t, now)) > 0) t = await readTimeline($)
    await countdownTick($, t, now)

    const notes: { id: string; text: string }[] = alertNotes(t, u, now, { mode, watchNotify, limits, freshMs: FRESH_MS, watching: paneWatching(now), covered: paneCovered(now) })
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
    const toasts: { id: string; text: string; endedAt: number }[] = []
    for (const a of Object.values(t.agents)) {
      if (a.id === 'main' || a.status === 'running' || a.endedAt === undefined) continue
      const id = `agent-done:${a.id}`
      if (!seenFinish.has(id)) {
        seenFinish.set(id, now - a.endedAt <= FRESH_MS)
        while (seenFinish.size > MAX_SEEN_FINISHES) seenFinish.delete(seenFinish.keys().next().value!)
      }
      if (seenFinish.get(id) !== true || now - a.endedAt > TOAST_FRESH_MS || u.toasted.includes(id)) continue
      // A workflow agent's answer is empty and its doing is its last step: its result says more.
      const result = a.result !== undefined ? oneLine(a.result) : ''
      const first = result !== '' ? result : oneLine(a.doing.split('\n')[0] ?? '')
      toasts.push({ id, text: `${typeName(a.type)} finished${first !== '' ? `: ${first}` : ''}`, endedAt: a.endedAt })
    }
    // R36, M13: finishes fold into one toast. While other agents still run, the first finish waits up to
    // FOLD_HOLD_MS for the rest; and never more than one agent toast in TOAST_EVERY_MS.
    const othersRunning = Object.values(t.agents).some(a => a.id !== 'main' && a.status === 'running')
    if (toasts.length === 0) foldSince = undefined
    else {
      foldSince ??= now
      const holding = othersRunning && now - foldSince < FOLD_HOLD_MS
      const tooSoon = toastAt !== undefined && now - toastAt < TOAST_EVERY_MS
      const settling = now - foldSince < FOLD_HOLD_MS && now - Math.max(...toasts.map(x => x.endedAt)) < FINISH_HOLD_MS
      // A held toast is never dropped: when the clock is about to stop (nothing live), it goes up at once.
      if ((holding || tooSoon || settling) && clockLive(t, now)) toasts.length = 0
      else foldSince = undefined
    }
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
    if (toasts.length > 0) {
      toastAt = now
      // Folded, the toast says how many, never an answer's words.
      $.ui.toast(toasts.length === 1 ? toasts[0]!.text : `${toasts.length} agents finished`)
    }
  } catch (err) {
    debug($, `needs tick failed: ${errText(err)}`)
  }
}
