import type { On } from 'claude-code'

import { summary } from '../model/select'
import { debug, errText, readTimeline } from '../state'
import { fit } from './fit'

const SEPARATOR = ' · '
const MIN_FOCUS = 8

/** The row above the prompt: `▣ 2/6 tasks · ▶ focus · 2 agents · /mc`. */
export function registerBand(on: On): void {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    try {
      const s = summary(await readTimeline($))
      const cols = e.props.bodyColumns
      const parts: string[] = []
      if (s.total > 0) parts.push(`▣ ${s.done}/${s.total} tasks`)
      if (s.running.length > 0) parts.push(`${s.running.length} ${s.running.length === 1 ? 'agent' : 'agents'}`)
      if (parts.length === 0 && !s.focus) return next(e)
      parts.push('/mc')
      if (s.focus) {
        // The focus is the part that gives way, so the rest and /mc stay whole.
        const others = parts.join(SEPARATOR).length
        const room = cols - others - SEPARATOR.length
        if (room >= MIN_FOCUS) {
          const at = s.total > 0 ? 1 : 0
          parts.splice(at, 0, fit(`▶ ${s.focus}`, room))
        }
      }
      const { Box, Text } = $.ui.resolve(e)
      return (
        <Box>
          <Text>{fit(parts.join(SEPARATOR), e.props.bodyColumns)}</Text>
        </Box>
      )
    } catch (err) {
      debug($, `band failed: ${errText(err)}`)
      return next(e)
    }
  })
}
