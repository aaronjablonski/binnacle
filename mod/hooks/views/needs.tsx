import type { EngineInterface, RenderElement } from 'claude-code'

import type { Timeline, UiState } from '../../types'
import { dismissKey, problems } from '../model/select'
import type { Problem } from '../model/select'
import { debug, errText, readTimeline, readUi, updateUi } from '../state'
import { elapsed, promptTitle, shortPaths } from './fit'
import { showInChat } from './find'
import { argOf } from './lay'
import { openStepInline } from './openstep'
import { blank, more, opened, row, section, viewAgent } from './parts'
import type { Action, Detail } from './parts'
import type { ViewCtx } from './shell'
import { C } from './style'

/** An ask counts as "waiting on you" only once it has run this long: in auto mode the classifier settles most within seconds. */
export const ASK_MS = 20_000
/**
 * An ask on any tool but Agent and Workflow notifies only once it has run this
 * long: a real permission dialog raises Claude Code's own notification, and a
 * call let through that runs long (a test run, a build) is no wait at all.
 */
export const NOTIFY_ASK_MS = 60_000
/** Asks that notify from ASK_MS: their mark clears as soon as the agent they spawn shows. */
const SPAWNING_TOOLS = new Set(['Agent', 'Workflow'])
/** A subagent's finish and a failed turn are raised only while this fresh, so a restore does not replay old ones. */
const FRESH_MS = 15_000

export type NotifyMode = 'off' | 'waits' | 'all'

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** What needs the person: the problems not dismissed, with an ask shown only after ASK_MS. */
export function needsYou(t: Timeline, u: UiState, now: number): Problem[] {
  return problems(t, now, u.dismissed).filter(p => p.kind !== 'asking' || now - p.since >= ASK_MS)
}

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
    default:
      return `turn failed: ${label}`
  }
}

function ageText(p: Problem, now: number): string {
  const age = elapsed(p.since, now)
  return p.kind === 'asking' ? `asked ${age} ago` : `${age} ago`
}

// Pressing a row: the step's detail, else the Timeline filtered to the agent.
export async function openProblem($: EngineInterface, p: Problem): Promise<void> {
  if (p.stepId !== undefined) {
    await openStepInline($, p.stepId)
    return
  }
  await updateUi($, u => {
    const { detail: _detail, ...rest } = u
    return { ...rest, tab: 'timeline', filter: p.agent === 'main' ? { kind: 'all' } : { kind: 'agent', id: p.agent } }
  })
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

/** The glyph and its colour for a kind: `?` and `▲` wait on the person, a failure is `✖`. */
export function needGlyph(p: Problem): { glyph: string; color: string } {
  if (p.kind === 'asking') return { glyph: '?', color: C.wait }
  if (p.kind === 'stalled') return { glyph: '▲', color: C.wait }
  return { glyph: '✖', color: C.fail }
}

/** The `why` column: what is wrong, in a word or two. */
export function needWhy(p: Problem): string {
  switch (p.kind) {
    case 'asking':
      return 'asking'
    case 'repeat':
      return `failed ${p.count ?? 2}×`
    case 'loop':
      return `looped ${p.count ?? 3}×`
    case 'stalled':
      return 'stalled'
    default:
      return 'failed'
  }
}

/** Dismisses a problem: its key goes to `ui.dismissed`. */
export function dismissNeed($: EngineInterface, p: Problem): Promise<void> {
  return updateUi($, cur => ({ ...cur, dismissed: [...cur.dismissed, dismissKey(p)] }))
}

/** `g: chat`: the step's own row, or the agent's transcript; undefined when the problem has neither. */
export function chatFor($: EngineInterface, p: Problem): (() => Promise<void>) | undefined {
  if (p.stepId !== undefined) {
    const id = p.stepId
    return () => showInChat($, id)
  }
  if (p.agent !== 'main') {
    const id = p.agent
    return () => viewAgent($, id)
  }
  return undefined
}

/** The tool of a problem's step, when it has one. */
function stepOf(t: Timeline, p: Problem): { tool: string; label: string } | undefined {
  const s = p.stepId !== undefined ? t.steps.find(x => x.id === p.stepId) : undefined
  return s !== undefined ? { tool: s.tool, label: s.label } : undefined
}

/** What the name column of a problem's row says. */
export function needName(t: Timeline, p: Problem): string {
  const s = stepOf(t, p)
  if (s !== undefined) return argOf(s.tool, s.label) || s.tool
  if (p.kind === 'failed-turn') return promptTitle(p.label) || problemText(p)
  return shortPaths(oneLine(p.label))
}

// Rows the section draws; the rest become one dim line.
const MAX_LIST = 6

/**
 * NEEDS YOU (spec "Now"): `┌ NEEDS YOU why waiting` in warning, then one row
 * per problem. The opened item (the first until `n` or `p` moves it) is bold
 * with an `asks` or `why` line, an `agent` line and `g: chat  x: dismiss  n:
 * next`; the first row takes the pane's focus. Null when nothing waits.
 */
export function needsSection(ctx: ViewCtx, $: EngineInterface): RenderElement | null {
  const { Box } = $.ui.resolve(ctx.e)
  const { t, u, now } = ctx
  const list = needsYou(t, u, now)
  if (list.length === 0) return null
  const shown = list.slice(0, MAX_LIST)
  const at = openedNeed(shown.length)
  const parts: RenderElement[] = [section(ctx, $, 'NEEDS YOU', 'why', 'waiting', { tone: 'wait' })]
  shown.forEach((p, i) => {
    const s = stepOf(t, p)
    const mark = needGlyph(p)
    const isOpen = i === at
    if (isOpen && i > 0) parts.push(blank(ctx, $, `need-gap-${i}`))
    parts.push(
      row(ctx, $, {
        key: `open-${p.key}`,
        glyph: mark.glyph,
        glyphColor: mark.color,
        ...(s !== undefined ? { tool: s.tool } : {}),
        name: needName(t, p),
        bold: isOpen,
        metric: needWhy(p),
        time: elapsed(p.since, now),
        onPress: () => openProblem($, p),
        ...(i === 0 ? { autoFocus: true } : {}),
      }),
    )
    if (!isOpen) return
    const who = p.agent !== 'main' ? t.agents[p.agent]?.type ?? p.agent : 'main'
    const details: Detail[] =
      p.kind === 'asking'
        ? [{ key: 'asks', value: `to run ${shortPaths(oneLine(p.label))}` }]
        : [{ key: 'why', value: shortPaths(problemText(p)) }]
    details.push({ key: 'agent', value: who })
    const chat = chatFor($, p)
    const actions: Action[] = []
    if (chat !== undefined) actions.push({ hotkey: 'g', label: 'chat', key: `chat-${p.key}`, onPress: chat })
    actions.push({ hotkey: 'x', label: 'dismiss', key: `dismiss-${p.key}`, onPress: () => dismissNeed($, p) })
    if (shown.length > 1) actions.push({ hotkey: 'n', label: 'next', key: 'need-next', onPress: () => moveNeed($, 1, shown.length) })
    parts.push(opened(ctx, $, details, actions))
    if (i < shown.length - 1) parts.push(blank(ctx, $, `need-after-${i}`))
  })
  if (list.length > shown.length) parts.push(more(ctx, $, list.length - shown.length))
  return (
    <Box key="needs" flexDirection="column">
      {parts}
    </Box>
  )
}

/**
 * The clock's one call: raises a native notification once per step id for an
 * ask that has waited ASK_MS on Agent or Workflow and NOTIFY_ASK_MS on any
 * other tool (and, with `all`, once per failed turn that ended within
 * FRESH_MS), and a toast when a subagent has just finished. What was raised is recorded in
 * `ui` before it is sent. Runs from the clock callback, not a render hook, so
 * it may write state. Never throws.
 */
export async function needsTick($: EngineInterface, notify: NotifyMode | undefined): Promise<void> {
  try {
    const t = await readTimeline($)
    const u = await readUi($)
    const now = await $.clock.now()
    const mode = notify ?? 'waits'

    const notes: { id: string; text: string }[] = []
    if (mode !== 'off') {
      for (const p of needsYou(t, u, now)) {
        const id = p.stepId ?? p.key
        if (u.notified.includes(id)) continue
        if (p.kind === 'asking') {
          const tool = t.steps.find(s => s.id === p.stepId)?.tool
          const wait = tool !== undefined && SPAWNING_TOOLS.has(tool) ? ASK_MS : NOTIFY_ASK_MS
          if (now - p.since >= wait) notes.push({ id, text: `Waiting on you: ${oneLine(p.label)}` })
        } else if (p.kind === 'failed-turn' && mode === 'all' && now - p.since <= FRESH_MS) {
          notes.push({ id, text: `Turn failed: ${oneLine(p.label)}` })
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
    }
    for (const x of toasts) $.ui.toast(x.text)
  } catch (err) {
    debug($, `needs tick failed: ${errText(err)}`)
  }
}
