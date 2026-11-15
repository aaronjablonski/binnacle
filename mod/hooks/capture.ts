import type { EngineInterface, On } from 'claude-code'

import type { Ev } from '../types'
import { bodyOf, claimJournal, saveSnapshot, writeBody } from './journal'
import { budgetOf, usageOf } from './model/usage'
import { apply, debug, errText, readTimeline } from './state'

// The capture hooks only observe: each calls `next(e)` exactly once and
// returns what it resolved to. The mod's own work sits in try/catch and
// reports to the debug log, so nothing it does can break the chain.

/** The guide's tool (Task 4 answers it); not recorded as a step. */
export const UPDATE_TOOL = 'mcp__mission-control__update'
const PROMPT_MAX = 200
const RESERVED = new Set(['tool', 'tool_use_id', 'agentId', 'consent', 'requestMeta'])

async function now($: EngineInterface): Promise<number> {
  try {
    return await $.clock.now()
  } catch {
    return 0
  }
}

async function safely($: EngineInterface, what: string, work: () => Promise<void>): Promise<void> {
  try {
    await work()
  } catch (err) {
    debug($, `${what} failed: ${errText(err)}`)
  }
}

/** Runs work after the hook has returned; never awaited, never throws. */
function later($: EngineInterface, what: string, work: () => Promise<void>): void {
  void safely($, what, work)
}

function inputOf(e: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(e)) if (!RESERVED.has(k)) out[k] = v
  return out
}

export function registerCapture(on: On): void {
  on('tool.call', async ($, e, next) => {
    if (e.tool === UPDATE_TOOL) return next(e)
    let id = ''
    let input: Record<string, unknown> = {}
    const agent = e.agentId ?? 'main'
    await safely($, 'step.start', async () => {
      const at = await now($)
      id = e.tool_use_id
      if (typeof id !== 'string' || id === '') id = `mc-${at}-${(await readTimeline($)).seq + 1}`
      input = inputOf(e as unknown as Record<string, unknown>)
      await apply($, { kind: 'step.start', at, id, agent, tool: String(e.tool), input })
    })
    const ran = await next(e)
    await safely($, 'step.end', async () => {
      if (id === '') return
      const status: Extract<Ev, { kind: 'step.end' }>['status'] =
        ran.deny !== undefined ? 'denied' : ran.isError === true ? 'error' : 'done'
      await apply($, { kind: 'step.end', at: await now($), id, status, result: ran.result })
      const stepId = id
      const shown = ran.deny !== undefined ? { text: ran.deny, isError: true } : ran
      later($, 'writeBody', async () => {
        await writeBody($, await claimJournal($), stepId, bodyOf(input, shown))
      })
    })
    return ran
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const out = await next(e)
    await safely($, 'agent.start', async () => {
      if (out.deny !== undefined || out.agentId === undefined) return
      const ev: Extract<Ev, { kind: 'agent.start' }> = {
        kind: 'agent.start', at: await now($), id: out.agentId,
        parent: e.parentAgentId ?? 'main', type: e.subagentType, description: e.description,
      }
      if (e.workflow !== undefined) {
        ev.runId = e.workflow.runId
        ev.agentIndex = e.workflow.agentIndex
      }
      await apply($, ev)
      // The model the subagent runs on: core's resolved id (`claude-sonnet-5-5`
      // in probe-usage), replaced later by each turn's usage.model.
      if (typeof out.model === 'string' && out.model !== '') {
        await apply($, { kind: 'agent.model', id: out.agentId, model: out.model })
      }
    })
    return out
  }).catch(($, e, next) => next(e))

  // Observes the engine's permission verdict. `ask` only says the call was put
  // to the mode's decider (a person, a host or the auto-mode classifier); the
  // step stays marked until it ends through the tool.call capture above.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    await safely($, 'step.ask', async () => {
      if (verdict.decision !== 'ask') return
      const id = e.tool_use_id
      if (typeof id !== 'string' || id === '') return
      await apply($, { kind: 'step.ask', at: await now($), id })
    })
    return verdict
  }).catch(($, e, next) => next(e))

  // The session's context fill, rate-limit windows and cost, whenever a unit moved.
  on('session.measure', async ($, e, next) => {
    const out = await next(e)
    await safely($, 'measure', async () => {
      if (!Array.isArray(e.changed) || e.changed.length === 0) return
      const at = await now($)
      await apply($, { kind: 'measure', at, budget: budgetOf(e, at) })
    })
    return out
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    await safely($, 'turn.start', async () => {
      const prompt = typeof e.text === 'string' ? e.text.slice(0, PROMPT_MAX) : ''
      await apply($, { kind: 'turn.start', at: await now($), turnId: e.turnId, agent: e.agentId ?? 'main', prompt })
    })
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    await safely($, 'turn.end', async () => {
      const failed = e.reason === 'error' || e.reason === 'refusal'
      const agent = e.agentId ?? 'main'
      const at = await now($)
      await apply($, { kind: 'turn.end', at, turnId: e.turnId, agent, answer: e.answer, failed })
      const used = usageOf(e.usage)
      if (used !== undefined) await apply($, { kind: 'usage', at, agent, ...used })
      if (agent === 'main') {
        later($, 'saveSnapshot', async () => {
          const journal = await claimJournal($)
          await saveSnapshot($, journal, await readTimeline($))
        })
      }
    })
    return next(e)
  }).catch(($, e, next) => next(e))
}
