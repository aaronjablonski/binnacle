import type { AgentRow, Step } from '../../types'
import { elapsed } from './fit'
import type { ViewCtx } from './shell'

export const STEP_GLYPH: Record<Step['status'], string> = {
  running: '·',
  done: '✔',
  error: '✖',
  denied: '⊘',
  interrupted: '◌',
}
export const AGENT_GLYPH: Record<AgentRow['status'], string> = { running: '▶', done: '✔', error: '✖' }
// `main` stays 'running' for the whole session, so it gets no status glyph.
export const MAIN_GLYPH = '•'
export const WORKFLOW_TYPE = 'workflow-subagent'
export const EMPTY = 'No agents yet. Subagents and workflow agents appear here while they run.'

/** When main began: its first step, since the `main` row itself carries no start. */
export function mainSince({ t }: ViewCtx): number | undefined {
  let first: number | undefined
  for (const s of t.steps) {
    if (s.agent !== 'main') continue
    if (first === undefined || s.startedAt < first) first = s.startedAt
  }
  return first
}

/** `unit` follows the step count: ' steps' in the list, '' in the tree. */
export function metaOf(ctx: ViewCtx, agent: AgentRow, unit = ' steps'): string {
  const steps = `${agent.stepCount}${unit}`
  if (agent.id === 'main') {
    const since = mainSince(ctx)
    return since === undefined ? steps : `${elapsed(since, ctx.now)} · ${steps}`
  }
  const end = agent.status === 'running' ? ctx.now : (agent.endedAt ?? ctx.now)
  return `${elapsed(agent.startedAt, end)} · ${steps}`
}
