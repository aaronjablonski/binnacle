import type { AgentRow, StepStatus, TaskItem } from '../../types'

/**
 * The calm-accent palette: theme keys only, so the pane follows the person's
 * theme. Views never write a colour literal.
 */
export const C = {
  accent: 'suggestion',
  running: 'warning',
  done: 'success',
  error: 'error',
  doc: 'merged',
  rule: 'subtle',
  tabFg: 'inverseText',
} as const

/** The theme key of a status glyph; undefined means a dim glyph (pending, interrupted). */
export function glyphColor(status: StepStatus | AgentRow['status'] | TaskItem['status']): string | undefined {
  switch (status) {
    case 'running':
    case 'in_progress':
      return C.running
    case 'done':
    case 'completed':
      return C.done
    case 'error':
    case 'denied':
      return C.error
    default:
      return undefined
  }
}
