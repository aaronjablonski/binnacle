import type { EngineInterface, RenderElement } from 'claude-code'

import type { Timeline, UiState } from '../../types'
import { dismissKey, problems } from '../model/select'
import type { Problem } from '../model/select'
import { debug, errText, readTimeline, readUi, updateUi } from '../state'
import { elapsed, fit } from './fit'
import { openStep } from './openstep'
import { sectionHeader } from './parts'
import type { ViewCtx } from './shell'
import { C } from './style'

/** An ask counts as "waiting on you" only once it has run this long: in auto mode the classifier settles most within seconds. */
export const ASK_MS = 20_000
/** A subagent's finish is toasted only while it is this fresh, so a restore does not replay old ones. */
const FRESH_MS = 15_000
// Rows the section draws; the rest become one dim line.
const MAX_ROWS = 5
const DISMISS = 'dismiss'

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
async function openProblem($: EngineInterface, p: Problem): Promise<void> {
  if (p.stepId !== undefined) {
    await openStep($, p.stepId)
    return
  }
  await updateUi($, u => {
    const { detail: _detail, ...rest } = u
    return { ...rest, tab: 'timeline', filter: p.agent === 'main' ? { kind: 'all' } : { kind: 'agent', id: p.agent } }
  })
}

/** NEEDS YOU: one row per problem, its dismiss under it. Null when there is none. */
export function needsSection(ctx: ViewCtx, $: EngineInterface): RenderElement | null {
  const { Box, Button, Text } = $.ui.resolve(ctx.e)
  const { t, u, cols, now } = ctx
  const list = needsYou(t, u, now)
  if (list.length === 0) return null
  const shown = list.slice(0, MAX_ROWS)
  return (
    <Box key="needs" flexDirection="column">
      {sectionHeader('NEEDS YOU', String(list.length), cols, ctx.e, $)}
      {shown.map(p => {
        const text = fit(problemText(p), Math.max(0, cols - 2))
        const who = p.agent !== 'main' ? t.agents[p.agent]?.type ?? p.agent : 'main'
        const meta = fit(`  ${who} · ${ageText(p, now)}`, Math.max(0, cols - DISMISS.length - 1))
        return (
          <Box key={`need-${p.key}`} flexDirection="column">
            <Button key={`open-${p.key}`} plain label={fit(`! ${text}`, cols)} onPress={() => openProblem($, p)}>
              <Text color={C.error}>!</Text>
              <Text>{` ${text}`}</Text>
            </Button>
            <Box flexDirection="row" justifyContent="space-between">
              <Text dimColor>{meta}</Text>
              <Button
                key={`dismiss-${p.key}`}
                plain
                dimColor
                onPress={() => updateUi($, cur => ({ ...cur, dismissed: [...cur.dismissed, dismissKey(p)] }))}
              >
                <Text>{DISMISS}</Text>
              </Button>
            </Box>
          </Box>
        )
      })}
      {list.length > shown.length ? <Text dimColor>{fit(`+${list.length - shown.length} more`, cols)}</Text> : null}
    </Box>
  )
}

/**
 * The clock's one call: raises a native notification once per step id for an
 * ask that has waited ASK_MS (and, with `all`, once per failed turn), and a
 * toast when a subagent has just finished. What was raised is recorded in
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
        if (p.kind === 'asking') notes.push({ id, text: `Waiting on you: ${oneLine(p.label)}` })
        else if (p.kind === 'failed-turn' && mode === 'all') notes.push({ id, text: `Turn failed: ${oneLine(p.label)}` })
      }
    }
    const toasts: { id: string; text: string }[] = []
    for (const a of Object.values(t.agents)) {
      if (a.id === 'main' || a.status === 'running' || a.endedAt === undefined) continue
      const id = `agent-done:${a.id}`
      if (now - a.endedAt > FRESH_MS || u.toasted.includes(id)) continue
      const first = oneLine(a.doing.split('\n')[0] ?? '')
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
