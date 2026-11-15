import type { On } from 'claude-code'

import { summary } from '../model/select'
import { debug, errText, readTimeline } from '../state'
import { fit } from './fit'
import { C } from './style'

const SEPARATOR = ' │ '
const MIN_FOCUS = 8

// A part of the band: an optional glyph in a theme colour, then plain text.
type Part = { glyph?: string; color?: string; text: string }

const widthOf = (p: Part): number => (p.glyph !== undefined ? p.glyph.length + 1 : 0) + p.text.length

/** The row above the prompt: `▣ 2/6 tasks │ ▶ focus │ ● 2 agents │ /mc`, glyphs coloured, bars dim. */
export function registerBand(on: On): void {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    try {
      const s = summary(await readTimeline($))
      const cols = e.props.bodyColumns
      const parts: Part[] = []
      if (s.total > 0) parts.push({ glyph: '▣', color: C.accent, text: `${s.done}/${s.total} tasks` })
      if (s.running.length > 0) {
        parts.push({ glyph: '●', color: C.running, text: `${s.running.length} ${s.running.length === 1 ? 'agent' : 'agents'}` })
      }
      if (parts.length === 0 && !s.focus) return next(e)
      parts.push({ text: '/mc' })
      if (s.focus) {
        // The focus is the part that gives way, so the rest and /mc stay whole.
        const others = parts.reduce((n, p) => n + widthOf(p), 0) + SEPARATOR.length * (parts.length - 1)
        const room = cols - others - SEPARATOR.length
        if (room >= MIN_FOCUS) {
          const at = s.total > 0 ? 1 : 0
          parts.splice(at, 0, { glyph: '▶', color: C.running, text: fit(s.focus, room - 2) })
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
