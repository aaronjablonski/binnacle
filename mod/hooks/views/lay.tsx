import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'

import type { Timeline } from '../../types'
import { summary } from '../model/select'
import { placed, shortPaths } from './fit'
import type { Run } from './parts'
import { runText } from './parts'

/** A run placed at an absolute pane column. */
export type Placed = Run & { col: number }

/**
 * The runs laid at their columns, as children: the spaces before each one are
 * plain strings (a Button may hold them), each run is one Text. `start` is
 * the column the line itself starts at (2 inside a row Box's Button).
 */
export function laid(segs: Placed[], start: number, e: RenderInput, $: EngineInterface, prefix: string): (RenderElement | string)[] {
  const out: (RenderElement | string)[] = []
  placed(segs.filter(s => s.text !== ''), start).forEach((p, i) => {
    if (p.gap !== '') out.push(p.gap)
    out.push(runText(p.seg, e, $, `${prefix}${i}`))
  })
  return out
}

/** One row of runs at columns from column 0, `wrap: truncate-end` as the backstop. */
export function runsLine(e: RenderInput, $: EngineInterface, segs: Placed[], key: string): RenderElement {
  const { Text } = $.ui.resolve(e)
  return (
    <Text key={key} wrap="truncate-end">
      {laid(segs, 0, e, $, `${key}-`)}
    </Text>
  )
}

/** A step's label without its leading tool name, paths shortened. */
export function argOf(tool: string, label: string): string {
  const one = label.replace(/\s+/g, ' ').trim()
  const rest = one === tool ? '' : one.startsWith(`${tool} `) ? one.slice(tool.length + 1) : one
  return shortPaths(rest)
}

/** The headline of Now and of slim: Claude's focus, else the task, else the step in flight or the newest, else idle. */
export function headline(t: Timeline): { text: string; isIdle: boolean; at?: number } {
  const s = summary(t)
  if (s.focus !== undefined) return { text: s.focus.replace(/\s+/g, ' ').trim(), isIdle: false, ...(s.focusAt !== undefined ? { at: s.focusAt } : {}) }
  const bySeq = [...t.steps].sort((a, b) => b.seq - a.seq)
  const step = bySeq.find(x => x.status === 'running') ?? bySeq[0]
  if (step !== undefined) return { text: shortPaths(step.label.replace(/\s+/g, ' ').trim()), isIdle: false }
  return { text: 'Idle. Nothing running yet.', isIdle: true }
}
