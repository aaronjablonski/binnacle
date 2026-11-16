import type { EngineInterface, On } from 'claude-code'

import type { Ev } from '../types'
import { bodyOf, claimJournal, saveSnapshot, writeBody } from './journal'
import { LEDGER_EVERY_MS } from './model/limits'
import { promptedStep } from './model/select'
import { budgetOf, usageOf } from './model/usage'
import { apply, debug, errText, readTimeline, saveLedger } from './state'
import { wakeClock } from './views/shell'

// The capture hooks only observe: each calls `next(e)` exactly once and
// returns what it resolved to. The mod's own work sits in try/catch and
// reports to the debug log, so nothing it does can break the chain.

/** The guide's tool (Task 4 answers it); not recorded as a step. */
export const UPDATE_TOOL = 'mcp__mission-control__update'
const PROMPT_MAX = 200
const RESERVED = new Set(['tool', 'tool_use_id', 'agentId', 'consent', 'requestMeta'])

/** Applies an event to the Timeline and starts the clock again if it stopped for want of anything live (M10). */
async function record($: EngineInterface, ev: Ev): Promise<void> {
  await apply($, ev)
  wakeClock($)
}

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

const ERROR_WORDS: Record<string, string> = {
  authentication_failed: 'Sign-in failed', oauth_org_not_allowed: 'This organization is not allowed', account_on_hold: 'The account is on hold',
  verification_required: 'The account needs verification', billing_error: 'A billing error', rate_limit: 'Rate limited',
  overloaded: 'The API is overloaded', invalid_request: 'The API refused the request', model_not_found: 'The model was not found',
  server_error: 'An API server error', max_output_tokens: 'The reply hit its output limit', cloud_credential_error: 'Cloud credentials failed',
}

/** StopFailure's error in words, with its details when given. */
function failureText(error: unknown, details: unknown): string {
  const head = (typeof error === 'string' ? ERROR_WORDS[error] : undefined) ?? 'An API error ended the turn'
  return typeof details === 'string' && details.trim() !== '' ? `${head}: ${details}` : head
}

/** A refusal in words: the API's explanation when it sent one. */
function refusalText(refusal: unknown): string {
  const r = typeof refusal === 'object' && refusal !== null ? (refusal as { explanation?: unknown; category?: unknown }) : {}
  const why = typeof r.explanation === 'string' && r.explanation.trim() !== '' ? r.explanation : typeof r.category === 'string' ? r.category : ''
  return why !== '' ? `Claude declined: ${why}` : 'Claude declined to answer'
}

export function registerCapture(on: On): void {
  // When session.measure last wrote the ledger; a reload starts it over.
  let ledgerAt = -Infinity

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
      await record($, { kind: 'step.start', at, id, agent, tool: String(e.tool), input })
    })
    const ran = await next(e)
    await safely($, 'step.end', async () => {
      if (id === '') return
      const status: Extract<Ev, { kind: 'step.end' }>['status'] =
        ran.deny !== undefined ? 'denied' : ran.isError === true ? 'error' : 'done'
      await record($, { kind: 'step.end', at: await now($), id, status, result: ran.result })
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
      const spawnStep = typeof e.tool_use_id === 'string' && e.tool_use_id !== '' ? e.tool_use_id : undefined
      if (spawnStep !== undefined) ev.spawnStep = spawnStep
      if (e.workflow !== undefined) {
        ev.runId = e.workflow.runId
        ev.agentIndex = e.workflow.agentIndex
      }
      await record($, ev)
      // A spawn happens only once the call was let through, so its ask is
      // settled. Workflow agents carry the Workflow call's id: that clears it too.
      if (spawnStep !== undefined) await record($, { kind: 'step.unask', id: spawnStep })
      // The model the subagent runs on: core's resolved id (`claude-sonnet-5-5`
      // in probe-usage), replaced later by each turn's usage.model.
      if (typeof out.model === 'string' && out.model !== '') {
        await record($, { kind: 'agent.model', id: out.agentId, model: out.model })
      }
    })
    return out
  }).catch(($, e, next) => next(e))

  // A prompt is raised: the call waits on the person (or the host). Not
  // `tool.check`'s `ask`, which only puts the call to the mode's decider; in
  // auto mode that comes before the classifier allows it, with nobody asked.
  // The request names no tool_use_id, so the step is found by tool and input.
  // A hook beneath that answered it asked nobody: nothing is marked. The mark
  // clears when the step ends, when an agent it spawned shows it went ahead,
  // or when the pane saw the dialog cover the prompt and then close (the
  // clock's `step.unask`, needs.tsx `clearAnswered`).
  // Observes only: the answer is never changed or given here.
  on('classic.PermissionRequest', async ($, e, next) => {
    const answer = await next(e)
    await safely($, 'step.ask', async () => {
      if (answer.decision !== undefined) return
      const agent = typeof e.agent_id === 'string' && e.agent_id !== '' ? e.agent_id : 'main'
      const step = promptedStep(await readTimeline($), e.tool_name, e.tool_input, agent)
      if (step === undefined) return
      await record($, { kind: 'step.ask', at: await now($), id: step.id, auto: e.permission_mode === 'auto' })
    })
    return answer
  }).catch(($, e, next) => next(e))

  // An MCP server asks the person for input (an elicitation dialog): a need
  // until its result comes, or the turn ends. A hook beneath that blocked it
  // showed nothing. Observes only.
  on('classic.Elicitation', async ($, e, next) => {
    const answer = await next(e)
    await safely($, 'input.ask', async () => {
      if (answer.block !== undefined || answer.preventContinuation !== undefined) return
      const agent = typeof e.agent_id === 'string' && e.agent_id !== '' ? e.agent_id : 'main'
      const id = typeof e.elicitation_id === 'string' ? e.elicitation_id : ''
      await record($, { kind: 'input.ask', at: await now($), id, agent, server: String(e.mcp_server_name ?? ''), message: String(e.message ?? '') })
    })
    return answer
  }).catch(($, e, next) => next(e))

  on('classic.ElicitationResult', async ($, e, next) => {
    await safely($, 'input.done', async () => {
      const ev: Extract<Ev, { kind: 'input.done' }> = { kind: 'input.done', server: String(e.mcp_server_name ?? '') }
      if (typeof e.elicitation_id === 'string' && e.elicitation_id !== '') ev.id = e.elicitation_id
      await record($, ev)
    })
    return next(e)
  }).catch(($, e, next) => next(e))

  // Why a main turn died on an API error, for the header's STOPPED line (R8).
  on('classic.StopFailure', async ($, e, next) => {
    await safely($, 'turn.fail', async () => {
      if (typeof e.agent_id === 'string' && e.agent_id !== '') return
      await record($, { kind: 'turn.fail', agent: 'main', reason: failureText(e.error, e.error_details) })
    })
    return next(e)
  }).catch(($, e, next) => next(e))

  // The session's context fill, rate-limit windows and cost, whenever a unit
  // moved; the ledger's row follows at most once every LEDGER_EVERY_MS.
  on('session.measure', async ($, e, next) => {
    const out = await next(e)
    await safely($, 'measure', async () => {
      if (!Array.isArray(e.changed) || e.changed.length === 0) return
      const at = await now($)
      await record($, { kind: 'measure', at, budget: budgetOf(e, at) })
      if (at - ledgerAt < LEDGER_EVERY_MS) return
      ledgerAt = at
      later($, 'ledger', async () => saveLedger($, at))
    })
    return out
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    await safely($, 'turn.start', async () => {
      const prompt = typeof e.text === 'string' ? e.text.slice(0, PROMPT_MAX) : ''
      await record($, { kind: 'turn.start', at: await now($), turnId: e.turnId, agent: e.agentId ?? 'main', prompt })
    })
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    await safely($, 'turn.end', async () => {
      const failed = e.reason === 'error' || e.reason === 'refusal'
      const aborted = e.isAborted === true || e.reason === 'aborted'
      const agent = e.agentId ?? 'main'
      const at = await now($)
      const end: Extract<Ev, { kind: 'turn.end' }> = { kind: 'turn.end', at, turnId: e.turnId, agent, answer: e.answer, failed, aborted }
      if (e.reason === 'refusal') end.reason = refusalText(e.refusal)
      await record($, end)
      // An interrupt reports no usage: its length still counts.
      const used = usageOf(e.usage)
      const ms = typeof e.durationMs === 'number' && Number.isFinite(e.durationMs) && e.durationMs >= 0 ? e.durationMs : undefined
      if (used !== undefined || ms !== undefined) {
        const ev: Extract<Ev, { kind: 'usage' }> = { kind: 'usage', at, agent, ...used, turnId: e.turnId }
        if (ms !== undefined) ev.ms = ms
        await record($, ev)
      }
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
