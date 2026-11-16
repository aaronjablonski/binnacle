import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'

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

/** A step's label without its leading tool name, paths shortened. */
export function argOf(tool: string, label: string): string {
  const one = label.replace(/\s+/g, ' ').trim()
  const rest = one === tool ? '' : one.startsWith(`${tool} `) ? one.slice(tool.length + 1) : one
  return shortPaths(rest)
}

/** The headline of Now and of slim (kept in bandmodel.ts, a module with no engine import, so the band and the Svg read the same one). */
export { headline } from './bandmodel'
