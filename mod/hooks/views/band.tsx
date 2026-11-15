import type { On } from 'claude-code'

import { summary } from '../model/select'
import { debug, errText, readTimeline, readUi } from '../state'
import { fit } from './fit'
import { needsYou } from './needs'
import { C } from './style'

const SEPARATOR = ' │ '
const MIN_FOCUS = 8

// A part of the band: an optional glyph in a theme colour, then plain text.
type Part = { id: 'needs' | 'tasks' | 'agents' | 'focus' | 'hint'; glyph?: string; color?: string; text: string }

// What gives way when the row is too wide, first to last. The focus is cut instead.
const DROP_ORDER: Part['id'][] = ['agents', 'tasks', 'hint']

const widthOf = (p: Part): number => (p.glyph !== undefined ? p.glyph.length + 1 : 0) + p.text.length

/** The row above the prompt: `▣ 2/6 tasks │ ▶ focus │ ● 2 agents │ /mc`, glyphs coloured, bars dim. */
export function registerBand(on: On): void {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    try {
      const t = await readTimeline($)
      const s = summary(t)
      const needs = needsYou(t, await readUi($), await $.clock.now())
      const cols = e.props.bodyColumns
      const parts: Part[] = []
      if (needs.length > 0) parts.push({ id: 'needs', glyph: '!', color: C.error, text: `${needs.length} need you` })
      if (s.total > 0) parts.push({ id: 'tasks', glyph: '▣', color: C.accent, text: `${s.done}/${s.total} tasks` })
      if (s.running.length > 0) {
        parts.push({ id: 'agents', glyph: '●', color: C.running, text: `${s.running.length} ${s.running.length === 1 ? 'agent' : 'agents'}` })
      }
      if (parts.length === 0 && !s.focus) return next(e)
      parts.push({ id: 'hint', text: '/mc' })
      const rowWidth = (): number => parts.reduce((n, p) => n + widthOf(p), 0) + SEPARATOR.length * (parts.length - 1)
      // Drop the agents, then the tasks, then the hint, until the row fits.
      for (const id of DROP_ORDER) {
        if (rowWidth() <= cols) break
        const at = parts.findIndex(p => p.id === id)
        if (at >= 0 && parts.length > 1) parts.splice(at, 1)
      }
      // One part left and still too long: cut its text.
      const only = parts[0]
      if (parts.length === 1 && only && widthOf(only) > cols) {
        parts[0] = { ...only, glyph: undefined, text: fit(only.text, cols) }
      }
      if (s.focus) {
        // The focus is the part that gives way, so what is left stays whole.
        const others = rowWidth()
        const room = cols - others - SEPARATOR.length
        if (room >= MIN_FOCUS) {
          const at = (needs.length > 0 ? 1 : 0) + (s.total > 0 ? 1 : 0)
          parts.splice(at, 0, { id: 'focus', glyph: '▶', color: C.running, text: fit(s.focus, room - 2) })
        }
      }
      const { Box, Text } = $.ui.resolve(e)
      const runs = parts.flatMap((p, i) => {
        const run = (
          <Text key={`part-${i}`}>
            {p.glyph !== undefined ? <Text color={p.color}>{p.glyph}</Text> : null}
            {p.glyph !== undefined ? ` ${p.text}` : p.text}
          </Text>
        )
        if (i === 0) return [run]
        return [
          ' ',
          <Text key={`bar-${i}`} dimColor>
            │
          </Text>,
          ' ',
          run,
        ]
      })
      return (
        <Box>
          <Text>{runs}</Text>
        </Box>
      )
    } catch (err) {
      debug($, `band failed: ${errText(err)}`)
      return next(e)
    }
  })
}
