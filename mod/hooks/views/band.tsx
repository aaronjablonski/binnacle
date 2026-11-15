import type { On } from 'claude-code'

import type { BudgetWindow, Timeline } from '../../types'
import { summary } from '../model/select'
import { debug, errText, readTimeline, readUi } from '../state'
import { fit, wordFit } from './fit'
import { needsYou } from './needs'
import { runText } from './parts'
import type { Run } from './parts'
import { C } from './style'

const GAP = 3
const MC = '/mc'
// The least room the focus is worth keeping in: under it the counts give way instead.
const MIN_FOCUS = 10

/** A piece of the band's left side: styled runs, and the spaces before it. */
type Part = { id: 'needs' | 'head' | 'focus' | 'live' | 'error' | 'budget' | 'artifacts'; runs: Run[]; gap: number }

const widthOf = (runs: Run[]): number => runs.reduce((n, r) => n + r.text.length, 0)
const plain = (parts: Part[]): string => parts.map(p => ' '.repeat(p.gap) + p.runs.map(r => r.text).join('')).join('')

/** The one window the band shows: the 5h or the 7d, whichever is hotter. */
function hotWindow(windows: BudgetWindow[]): { label: string; pct: number } | undefined {
  const known = windows
    .filter(w => w.name === 'five_hour' || w.name === 'seven_day')
    .map(w => ({ label: w.name === 'five_hour' ? '5h' : '7d', pct: w.pct }))
  return known.sort((a, b) => b.pct - a.pct)[0]
}

/** `ctx 9%   7d 22%`, dim; nothing when the session reported no budget. */
function budgetPart(t: Timeline): Part | undefined {
  const bits: string[] = []
  if (t.budget?.contextPct !== undefined) bits.push(`ctx ${Math.round(t.budget.contextPct)}%`)
  const hot = hotWindow(t.budget?.windows ?? [])
  if (hot !== undefined) bits.push(`${hot.label} ${Math.round(hot.pct)}%`)
  if (bits.length === 0) return undefined
  return { id: 'budget', runs: [{ text: bits.join('   '), dim: true }], gap: GAP }
}

/**
 * The row above the prompt, from the left: `▲ n need you` (bold, warning) when
 * anything waits, `▍ done/total`, the focus, `▸ n live`, `✖ n error`, then the
 * budget; `/mc` dim at the right edge. When the row is too wide it gives up
 * the budget, then the words `live` and `error`, then `/mc`, and only then
 * cuts the focus at a word (spec "Band"). All done: one dim row.
 */
export function registerBand(on: On): void {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    try {
      const t = await readTimeline($)
      const s = summary(t)
      const needs = needsYou(t, await readUi($), await $.clock.now())
      const cols = e.props.bodyColumns
      const live = s.running.length
      const errors = t.steps.filter(x => x.status === 'error').length
      if (needs.length === 0 && s.total === 0 && live === 0 && errors === 0 && !s.focus) return next(e)

      const { Text } = $.ui.resolve(e)
      const allDone = needs.length === 0 && s.total > 0 && s.done === s.total && live === 0
      let parts: Part[]
      let mc = true
      if (allDone) {
        // Done: one dim row, `▍ 14/14 done   3 artifacts`.
        const words = [`▍ ${s.done}/${s.total} done`, ...(t.artifacts.length > 0 ? [`${t.artifacts.length} ${t.artifacts.length === 1 ? 'artifact' : 'artifacts'}`] : [])]
        parts = words.map((w, i) => ({ id: i === 0 ? 'head' : 'artifacts', runs: [{ text: w, dim: true }], gap: i === 0 ? 0 : GAP }))
        while (parts.length > 1 && widthOf(parts.flatMap(p => p.runs)) + (parts.length - 1) * GAP + 2 + MC.length > cols) parts.pop()
        if (plain(parts).length + 2 + MC.length > cols) mc = false
      } else {
        const stage = (budget: boolean, words: boolean): Part[] => {
          const list: Part[] = []
          if (needs.length > 0) {
            list.push({ id: 'needs', runs: [{ text: `▲ ${needs.length} need you`, bold: true, color: C.wait }], gap: 0 })
          }
          const head: Run[] = [{ text: '▍', color: C.accent }]
          if (s.total > 0) head.push({ text: ` ${s.done}` }, { text: `/${s.total}`, dim: true })
          list.push({ id: 'head', runs: head, gap: list.length > 0 ? GAP : 0 })
          if (live > 0) {
            list.push({ id: 'live', runs: [{ text: '▸', color: C.live }, { text: words ? ` ${live} live` : ` ${live}` }], gap: GAP })
          }
          if (errors > 0) {
            const noun = errors === 1 ? 'error' : 'errors'
            list.push({ id: 'error', runs: [{ text: '✖', color: C.error }, { text: words ? ` ${errors} ${noun}` : ` ${errors}` }], gap: GAP })
          }
          const b = budget ? budgetPart(t) : undefined
          if (b !== undefined) list.push(b)
          return list
        }
        // The focus sits after the head. Its gap is wider when a count follows the glyph.
        const focusGap = s.total > 0 ? GAP : 1
        const place = (list: Part[], focus: string | undefined): Part[] => {
          if (focus === undefined || focus === '') return list
          const at = list.findIndex(p => p.id === 'head') + 1
          return [...list.slice(0, at), { id: 'focus', runs: [{ text: focus }], gap: focusGap }, ...list.slice(at)]
        }
        const stages: [boolean, boolean, boolean][] = [
          [true, true, true],
          [false, true, true],
          [false, false, true],
          [false, false, false],
        ]
        const room = (list: Part[], hasMc: boolean): number => {
          const used = plain(list).length + (hasMc ? 2 + MC.length : 0)
          return cols - used - focusGap
        }
        const focusText = s.focus ?? ''
        parts = []
        for (const [b, w, m] of stages) {
          const base = stage(b, w)
          const fitsWhole = focusText === '' ? plain(base).length + (m ? 2 + MC.length : 0) <= cols : room(base, m) >= focusText.length
          if (fitsWhole || (!b && !w && !m)) {
            mc = m
            let list = base
            // Last stage: cut the focus at a word; if there is no room worth keeping, the counts give way.
            while (focusText !== '' && room(list, mc) < MIN_FOCUS && list.some(p => p.id === 'error' || p.id === 'live')) {
              const drop = list.some(p => p.id === 'error') ? 'error' : 'live'
              list = list.filter(p => p.id !== drop)
            }
            const space = room(list, mc)
            parts = place(list, focusText === '' ? undefined : space >= 4 ? wordFit(focusText, space) : undefined)
            break
          }
        }
      }

      // A pane too narrow even for that: whole parts from the right, then the first part's text is cut.
      while (parts.length > 1 && plain(parts).length + (mc ? 2 + MC.length : 0) > cols) {
        if (mc) mc = false
        else parts.pop()
      }
      const first = parts[0]
      if (parts.length === 1 && first !== undefined && plain(parts).length > cols) {
        const color = first.runs.find(r => r.color !== undefined)?.color
        parts = [{ ...first, runs: [{ ...(color !== undefined ? { color } : {}), text: fit(plain(parts), cols) }] }]
        mc = false
      }

      const gapToEdge = ' '.repeat(Math.max(1, cols - plain(parts).length - MC.length))
      return (
        <Text wrap="truncate-end">
          {parts.flatMap(p => [
            p.gap > 0 ? ' '.repeat(p.gap) : '',
            ...p.runs.map((r, i) => runText(r, e, $, `${p.id}-${i}`)),
          ])}
          {mc ? gapToEdge : ''}
          {mc ? <Text dimColor>{MC}</Text> : null}
        </Text>
      )
    } catch (err) {
      debug($, `band failed: ${errText(err)}`)
      return next(e)
    }
  })
}
