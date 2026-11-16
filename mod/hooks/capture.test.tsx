import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { LedgerRow, Timeline } from '../types'
import { ASK_MS } from './views/needs'
import { headerState, needs, watch } from './model/alerts'

type Box = { timeline?: Timeline; writes: Timeline[]; clock: ReturnType<typeof mock.clock> }

// No hook beneath answers the request: the prompt is the person's.
const unanswered = (on: On) => on('classic.PermissionRequest', () => ({}))
const AGENT_INPUT = { subagent_type: 'Explore', description: 'look', prompt: 'p' }

// The world beneath the mod: a clock, no home folder (so the journal stays
// quiet), a debug log that goes nowhere, and a recorder of the timeline the
// mod writes (the test's `$` has no `state` noun of its own).
function world(on: On, opts: { failState?: boolean } = {}): Box {
  const box: Box = { writes: [], clock: mock.clock(on, { now: 1000 }) }
  mock.env(on, {})
  on('ui.log', () => ({ value: undefined }))
  on('state.set', async (_, e, next) => {
    if (opts.failState === true) throw new Error('state is down')
    const out = await next(e)
    if (e.key === 'timeline') {
      box.timeline = (e.value as { value?: Timeline } | undefined)?.value
      if (box.timeline !== undefined) box.writes.push(box.timeline)
    }
    return out
  })
  return box
}

test('a tool call becomes a done step with a label', async ($, on) => {
  const box = world(on)
  on('tool.call', () => ({ result: {}, text: 'ok' }))

  await $.tool.call({ tool: 'Bash', command: 'ls' })

  const t = box.timeline
  expect(t?.steps.length).toBe(1)
  expect(t?.steps[0]?.status).toBe('done')
  expect(t?.steps[0]?.agent).toBe('main')
  expect(t?.steps[0]?.tool).toBe('Bash')
  expect(t?.steps[0]?.label).toContain('ls')
  expect(t?.steps[0]?.pending).toBe(undefined)
})

test('an errored call becomes an error step', async ($, on) => {
  const box = world(on)
  on('tool.call', () => ({ result: {}, text: 'boom', isError: true }))

  await $.tool.call({ tool: 'Bash', command: 'false' })

  expect(box.timeline?.steps[0]?.status).toBe('error')
})

test('a denied call becomes a denied step', async ($, on) => {
  const box = world(on)
  on('tool.call', () => ({ deny: 'not here' }))

  await $.tool.call({ tool: 'Bash', command: 'rm -rf /' })

  expect(box.timeline?.steps[0]?.status).toBe('denied')
})

test("a subagent's call lands under its agentId", async ($, on) => {
  const box = world(on)
  on('tool.call', () => ({ result: {}, text: 'ok' }))

  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' })

  const t = box.timeline
  expect(t?.steps[0]?.agent).toBe('a1')
  expect(t?.agents.a1?.stepCount).toBe(1)
})

test('agent.spawn records the agent with its workflow run', async ($, on) => {
  const box = world(on)
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'w1' }))

  await $.agent.spawn({
    tool_use_id: 'toolu_wf',
    prompt: 'read package.json',
    description: 'read:agent-1',
    subagentType: 'workflow-subagent',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'haiku',
    background: true,
    fork: false,
    workflow: { runId: 'wf_1', agentIndex: 1 },
  })

  const t = box.timeline
  expect(t?.agents.w1?.parent).toBe('main')
  expect(t?.agents.w1?.type).toBe('workflow-subagent')
  expect(t?.agents.w1?.runId).toBe('wf_1')
  expect(t?.agents.w1?.agentIndex).toBe(1)
  expect(t?.runs.wf_1?.runId).toBe('wf_1')
})

test('the update tool is not recorded as a step', async ($, on) => {
  const box = world(on)
  on('tool.call', () => ({ result: 'ok' }))

  await $.tool.call({ tool: 'mcp__mission-control__update', focus: 'x' } as never)

  expect(box.timeline?.steps.length ?? 0).toBe(0)
})

test("the hook returns the engine's answer unchanged", async ($, on) => {
  world(on)
  const answer = { result: { stdout: 'a b' }, text: 'a b' }
  on('tool.call', () => answer)

  const got = await $.tool.call({ tool: 'Bash', command: 'ls' })

  expect(got).toEqual(answer)
})

test('a failing state write does not break the call', async ($, on) => {
  world(on, { failState: true })
  on('tool.call', () => ({ result: {}, text: 'ok' }))

  const got = await $.tool.call({ tool: 'Bash', command: 'ls' })

  expect(got.text).toBe('ok')
})

test('turns are recorded and a main turn end closes its steps', async ($, on) => {
  const box = world(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))

  await $.turn.start({ text: 'x'.repeat(300), turnId: 't1' })
  await $.turn.complete({
    answer: 'all done', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer',
  })

  const t = box.timeline
  expect(t?.turns[0]?.id).toBe('t1')
  expect(t?.turns[0]?.endedAt).toBe(1000)
  expect((t?.turns[0]?.prompt.length ?? 0) <= 200).toBe(true)
})

test('a failed subagent turn marks the agent error', async ($, on) => {
  const box = world(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))

  await $.turn.start({ text: 'go', turnId: 't2', agentId: 'a9' })
  await $.turn.complete({
    answer: '', durationMs: 5, isAborted: false, turnId: 't2', agentId: 'a9', reason: 'error',
  })

  expect(box.timeline?.agents.a9?.status).toBe('error')
})

// Auto mode's check resolves `ask` before its classifier decides, so an ask is
// no prompt: nothing is marked and NEEDS YOU stays empty however long it runs.
test("a check that resolves ask marks nothing and raises no need, and the engine's verdict comes back unchanged", async ($, on) => {
  const box = world(on)
  on('tool.check', () => ({ decision: 'ask', reason: 'needs a yes' }))
  on('classic.PermissionRequest', () => ({ decision: { behavior: 'allow' } }))
  let during: Timeline | undefined
  on('tool.call', () => {
    during = box.timeline
    return { result: {}, text: 'ok' }
  })

  await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'toolu_ask' } as never)

  expect(during?.steps.find(s => s.id === 'toolu_ask')?.status).toBe('running')
  expect(box.writes.some(t => t.steps.some(s => s.asking !== undefined))).toBe(false)
  expect(needs(during!, 1000 + 5 * 60_000).items).toEqual([])

  const verdict = await $.tool.check({ tool: 'Bash', input: { command: 'npm test' } })
  expect(verdict).toEqual({ decision: 'ask', reason: 'needs a yes' })
})

// R2 and C-1: in auto mode an uncovered ask is "Checking a permission" however long it stands (the classifier may
// have allowed it; the clock settles it from what the pane sees); a covered prompt shows it at once. Outside auto it shows at once (next test).
test('a permission request in auto mode marks the running step with the same command; uncovered it is only checked, covered a need; it clears when the step ends', async ($, on) => {
  const box = world(on)
  unanswered(on)
  let during: Timeline | undefined
  on('tool.call', async () => {
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'npm test' }, permission_mode: 'auto' })
    during = box.timeline
    return { result: {}, text: 'ok' }
  })

  await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'toolu_p' } as never)

  const step = during?.steps.find(s => s.id === 'toolu_p')
  expect(step?.status).toBe('running')
  expect(step?.asking).toBe(1000)
  expect(needs(during!, 1000 + ASK_MS - 1)).toEqual({ items: [], checking: true })
  expect(needs(during!, 1000 + ASK_MS)).toEqual({ items: [], checking: true })
  expect(needs(during!, 1000 + 5 * 60_000)).toEqual({ items: [], checking: true })
  expect(needs(during!, 1000 + ASK_MS, { covered: true }).items.map(n => n.key)).toEqual(['asking:toolu_p'])
  const ended = box.timeline?.steps.find(s => s.id === 'toolu_p')
  expect(ended?.status).toBe('done')
  expect(ended?.asking).toBe(undefined)
  expect(needs(box.timeline!, 1000 + 5 * 60_000).items).toEqual([])
})

test('a permission request outside auto mode is one need at once, with its tool, command and asker, and clears when its step ends', async ($, on) => {
  const box = world(on)
  unanswered(on)
  let during: Timeline | undefined
  on('tool.call', async () => {
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'npm run deploy' }, permission_mode: 'default' })
    during = box.timeline
    return { result: {}, text: 'ok' }
  })

  await $.tool.call({ tool: 'Bash', command: 'npm run deploy', tool_use_id: 'toolu_d' } as never)

  const view = needs(during!, 1000)
  expect(view.checking).toBe(false)
  expect(view.items.map(n => [n.kind, n.tool, n.command, n.asker, n.askerAmbiguous, n.sentence])).toEqual([
    ['permission', 'Bash', 'npm run deploy', 'Claude', false, 'Claude asks to run a command'],
  ])
  expect(watch(during!, 1000)).toEqual([])
  expect(needs(box.timeline!, 2000).items).toEqual([])
})

test('an MCP input request is a need until its result comes', async ($, on) => {
  const box = world(on)
  on('classic.Elicitation', () => ({}))
  on('classic.ElicitationResult', () => ({}))

  await $.classic.Elicitation({ mcp_server_name: 'github', message: 'Pick a repository', elicitation_id: 'el1' } as never)
  const view = needs(box.timeline!, 1000)
  expect(view.items.map(n => [n.kind, n.asker, n.sentence, n.message])).toEqual([['input', 'github', 'github asks for input', 'Pick a repository']])

  await $.classic.ElicitationResult({ mcp_server_name: 'github', elicitation_id: 'el1', action: 'accept' } as never)
  expect(needs(box.timeline!, 1000).items).toEqual([])
})

test('a StopFailure gives the failed turn its reason; the header says stopped', async ($, on) => {
  const box = world(on)
  on('turn.start', () => ({ turnId: 'tf' }))
  on('turn.complete', () => ({ text: '' }))
  on('classic.StopFailure', () => ({}))

  await $.turn.start({ text: 'fix it', turnId: 'tf' })
  await $.classic.StopFailure({ error: 'rate_limit', error_details: '429 from the API' } as never)
  await $.turn.complete({ turnId: 'tf', answer: '', reason: 'error' } as never)

  expect(box.timeline?.failure).toEqual({ turnId: 'tf', reason: 'Rate limited: 429 from the API' })
  const h = headerState(box.timeline!, 5000, needs(box.timeline!, 5000))
  expect([h.state, h.reason]).toEqual(['stopped', 'Rate limited: 429 from the API'])
})

test("a permission request from a subagent marks that agent's step, not main's with the same command", async ($, on) => {
  const box = world(on)
  unanswered(on)
  let during: Timeline | undefined
  on('tool.call', async (_, e) => {
    if (e.agentId === 'a1') {
      await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'npm test' }, agent_id: 'a1' })
      during = box.timeline
      return { result: {}, text: 'ok' }
    }
    await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'toolu_sub', agentId: 'a1' } as never)
    return { result: {}, text: 'ok' }
  })

  await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'toolu_main' } as never)

  expect(during?.steps.find(s => s.id === 'toolu_sub')?.asking).toBe(1000)
  expect(during?.steps.find(s => s.id === 'toolu_main')?.asking).toBe(undefined)
})

test('a permission request with no matching running step changes nothing', async ($, on) => {
  const box = world(on)
  unanswered(on)
  let before = 0
  let after = 0
  on('tool.call', async () => {
    before = box.writes.length
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'npm run build' } })
    await $.classic.PermissionRequest({ tool_name: 'PowerShell', tool_input: { command: 'npm test' } })
    after = box.writes.length
    return { result: {}, text: 'ok' }
  })

  await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'toolu_n' } as never)
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'npm test' } })

  expect(after).toBe(before)
  expect(box.writes.some(t => t.steps.some(s => s.asking !== undefined))).toBe(false)
})

test("a permission request returns the engine's answer unchanged, and a hook's answer marks nothing", async ($, on) => {
  const box = world(on)
  const deny = { decision: { behavior: 'deny', message: 'not today' } } as const
  on('classic.PermissionRequest', () => deny)
  let answer: unknown
  on('tool.call', async () => {
    answer = await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'npm test' } })
    return { result: {}, text: 'ok' }
  })

  await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'toolu_h' } as never)

  expect(answer).toEqual(deny)
  expect(box.writes.some(t => t.steps.some(s => s.asking !== undefined))).toBe(false)
})

test('a permission request still answers when the state is down', async ($, on) => {
  world(on, { failState: true })
  on('classic.PermissionRequest', () => ({ decision: { behavior: 'allow' } }))

  const answer = await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'npm test' } })

  expect(answer).toEqual({ decision: { behavior: 'allow' } })
})

test('a check that allows marks nothing', async ($, on) => {
  const box = world(on)
  on('tool.check', () => ({ decision: 'allow' }))
  on('tool.call', () => ({ result: {}, text: 'ok' }))

  await $.tool.call({ tool: 'Read', file_path: 'a.ts', tool_use_id: 'toolu_ok' } as never)

  expect(box.writes.some(t => t.steps.some(s => s.asking !== undefined))).toBe(false)
})

test('session.measure records the budget and returns the engine answer unchanged', async ($, on) => {
  const box = world(on)
  on('session.measure', (_, e) => ({ changed: e.changed }))

  const got = await $.session.measure({
    context: { tokens: 43437, window: 1000000, percent: 4 },
    rateLimits: [{ kind: 'seven_day', percentUsed: 21, resetsAt: '2026-11-19T09:00:00.000Z' }],
    cost: { usd: 0.0058 },
    changed: ['context', 'rateLimits', 'cost'],
  })

  expect(got).toEqual({ changed: ['context', 'rateLimits', 'cost'] })
  expect(box.timeline?.budget).toEqual({
    contextPct: 4,
    contextTokens: 43437,
    windows: [{ name: 'seven_day', pct: 21, resetsAt: Date.parse('2026-11-19T09:00:00.000Z') }],
    costUsd: 0.0058,
    at: 1000,
  })
})

test("turn.complete's usage lands on the agent, summed over its turns", async ($, on) => {
  const box = world(on)
  on('turn.complete', () => ({ text: '' }))
  const usage = { input_tokens: 4, output_tokens: 193, cache_read_input_tokens: 33638, cache_creation_input_tokens: 40757, model: 'claude-sonnet-5-5' }

  await $.turn.complete({ answer: '', durationMs: 5, isAborted: false, turnId: 't1', agentId: 'w1', reason: 'answer', usage })
  await $.turn.complete({ answer: '', durationMs: 5, isAborted: false, turnId: 't2', agentId: 'w1', reason: 'answer', usage })

  expect(box.timeline?.agents.w1?.model).toBe('claude-sonnet-5-5')
  expect(box.timeline?.agents.w1?.tokensIn).toBe(2 * 74399)
  expect(box.timeline?.agents.w1?.tokensOut).toBe(2 * 193)
})

test("agent.spawn's model lands on the agent", async ($, on) => {
  const box = world(on)
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'a7' }))

  await $.agent.spawn({
    tool_use_id: 'toolu_ag',
    prompt: 'count files',
    description: 'count',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'haiku',
    background: false,
    fork: false,
  })

  expect(box.timeline?.agents.a7?.model).toBe('claude-sonnet-5-5')
})

test('a timeline-2 value an earlier version stored reads as the initial value (still)', async ($, on) => {
  const box = world(on)
  const stale = { seq: 7, turns: [], steps: [], agents: {}, runs: {}, tasks: [], notes: [], artifacts: [], changed: [] }
  on('state.get', async (_, e, next) => (e.key === 'timeline' && box.timeline === undefined
    ? { value: { value: { shape: 'timeline-2', value: stale }, version: 0 } }
    : next(e)))
  on('tool.call', () => ({ result: {}, text: 'ok' }))

  await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'toolu_new' } as never)

  // Folded onto the initial value: seq starts again at 1 and main is there.
  expect(box.timeline?.seq).toBe(1)
  expect(box.timeline?.agents.main?.type).toBe('main')
  expect(box.timeline?.steps.map(s => s.id)).toEqual(['toolu_new'])
})

test('a timeline-3 value the previous version stored reads as the initial value', async ($, on) => {
  const box = world(on)
  const stale = { seq: 7, turns: [], steps: [], agents: {}, runs: {}, tasks: [], notes: [], artifacts: [], changed: [] }
  on('state.get', async (_, e, next) => (e.key === 'timeline' && box.timeline === undefined
    ? { value: { value: { shape: 'timeline-3', value: stale }, version: 0 } }
    : next(e)))
  on('tool.call', () => ({ result: {}, text: 'ok' }))

  await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'toolu_new' } as never)

  expect(box.timeline?.seq).toBe(1)
  expect(box.timeline?.agents.main?.type).toBe('main')
  expect(box.timeline?.steps.map(s => s.id)).toEqual(['toolu_new'])
})

const SPAWN = {
  prompt: 'look around',
  description: 'look',
  subagentType: 'Explore',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'haiku',
  background: false,
  fork: false,
} as const

test("an asked Agent call's mark clears when its agent spawns, and the agent keeps its spawning step", async ($, on) => {
  const box = world(on)
  unanswered(on)
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'a7' }))
  let during: Timeline | undefined
  // The Agent call runs the whole subagent: it is still running when the agent spawns.
  on('tool.call', async () => {
    await $.classic.PermissionRequest({ tool_name: 'Agent', tool_input: AGENT_INPUT })
    await $.agent.spawn({ ...SPAWN, tool_use_id: 'toolu_agent' })
    during = box.timeline
    return { result: {}, text: 'ok' }
  })

  await $.tool.call({ tool: 'Agent', ...AGENT_INPUT, tool_use_id: 'toolu_agent' } as never)

  expect(box.writes.some(t => t.steps.some(s => s.id === 'toolu_agent' && s.asking !== undefined))).toBe(true)
  const step = during?.steps.find(s => s.id === 'toolu_agent')
  expect(step?.status).toBe('running')
  expect(step?.asking).toBe(undefined)
  expect(during?.agents.a7?.spawnStep).toBe('toolu_agent')
})

test('a denied spawn clears nothing', async ($, on) => {
  const box = world(on)
  unanswered(on)
  on('agent.spawn', () => ({ deny: 'no' }) as never)
  let during: Timeline | undefined
  on('tool.call', async () => {
    await $.classic.PermissionRequest({ tool_name: 'Agent', tool_input: AGENT_INPUT })
    await $.agent.spawn({ ...SPAWN, tool_use_id: 'toolu_agent' })
    during = box.timeline
    return { result: {}, text: 'ok' }
  })

  await $.tool.call({ tool: 'Agent', ...AGENT_INPUT, tool_use_id: 'toolu_agent' } as never)

  expect(during?.steps.find(s => s.id === 'toolu_agent')?.asking).toBe(1000)
})

test('turn.complete keeps cache counts and turn time on the agent, and marks an interrupted turn', async ($, on) => {
  const box = world(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  const usage = { input_tokens: 4, output_tokens: 193, cache_read_input_tokens: 33638, cache_creation_input_tokens: 40757, model: 'm' }

  await $.turn.complete({ answer: '', durationMs: 7000, isAborted: false, turnId: 'w-t', agentId: 'w1', reason: 'answer', usage })
  await $.turn.start({ text: 'go', turnId: 't1' })
  // An interrupt reports no usage; its time still counts.
  await $.turn.complete({ answer: '', durationMs: 3000, isAborted: true, turnId: 't1', reason: 'aborted' })

  const t = box.timeline
  expect(t?.agents.w1).toMatchObject({ tokensIn: 74399, tokensOut: 193, cacheRead: 33638, cacheWrite: 40757, ms: 7000 })
  expect(t?.agents.main?.ms).toBe(3000)
  expect(t?.agents.main?.tokensIn).toBe(undefined)
  expect(t?.turns.find(x => x.id === 't1')?.aborted).toBe(true)
})

// The ledger lives in $.store; these hooks keep it and record each write.
function ledgerStore(on: On, start?: unknown): { writes: unknown[]; value: () => unknown } {
  const box: { writes: unknown[]; value: unknown } = { writes: [], value: start }
  on('store.get', (_, e) => ({ value: e.key === 'mission-control:ledger' ? box.value : undefined }))
  on('store.set', (_, e) => {
    if (e.key === 'mission-control:ledger') {
      box.value = e.value
      box.writes.push(e.value)
    }
    return { value: undefined }
  })
  on('store.delete', () => ({ value: undefined }))
  return { writes: box.writes, value: () => box.value }
}
const MEASURE = { context: { tokens: 1, window: 100, percent: 1 }, rateLimits: [], cost: { usd: 0.5 }, changed: ['context', 'cost'] as ('context' | 'cost')[] }
const rowsOf = (v: unknown): LedgerRow[] => (v as { rows: LedgerRow[] }).rows

test("session.measure writes the session's ledger row, at most once a minute", async ($, on) => {
  const box = world(on)
  const store = ledgerStore(on)
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('turn.complete', () => ({ text: '' }))
  const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'opus' }
  await $.turn.complete({ answer: '', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer', usage })

  await $.session.measure(MEASURE)
  await box.clock.advance(1)
  expect(store.writes.length).toBe(1)
  const row = rowsOf(store.value())[0]
  expect(row).toMatchObject({ session: 'sess-1', tokens: { opus: 15 }, usd: 0.5 })

  await $.session.measure(MEASURE)
  await box.clock.advance(30_000)
  expect(store.writes.length).toBe(1)
  await $.session.measure(MEASURE)
  await box.clock.advance(1)
  expect(store.writes.length).toBe(1)
  await box.clock.advance(31_000)
  await $.session.measure(MEASURE)
  await box.clock.advance(1)
  expect(store.writes.length).toBe(2)
  expect(rowsOf(store.value())).toHaveLength(1)
})

test('session.end writes the ledger row', async ($, on) => {
  const box = world(on)
  const store = ledgerStore(on)
  on('session.id', () => ({ value: 'sess-2' }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('turn.complete', () => ({ text: '' }))
  const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'sonnet' }
  await $.turn.complete({ answer: '', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer', usage })

  await $.session.end({ reason: 'other', sessionId: 'sess-2', resume: { id: 'sess-2' } } as never)

  expect(box.timeline).toBeDefined()
  expect(rowsOf(store.value()).map(r => [r.session, r.tokens])).toEqual([['sess-2', { sonnet: 2 }]])
})

test('a ledger stored in an old shape is read as empty and replaced', async ($, on) => {
  const box = world(on)
  const store = ledgerStore(on, [{ day: '2026-01-01', session: 'old', tokens: { x: 1 }, at: 1 }])
  on('session.id', () => ({ value: 'sess-3' }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('turn.complete', () => ({ text: '' }))
  const usage = { input_tokens: 1, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'opus' }
  await $.turn.complete({ answer: '', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer', usage })

  await $.session.measure(MEASURE)
  await box.clock.advance(1)

  expect(store.value()).toMatchObject({ v: 1 })
  expect(rowsOf(store.value()).map(r => r.session)).toEqual(['sess-3'])
})

test('an empty timeline writes no ledger row', async ($, on) => {
  const box = world(on)
  const store = ledgerStore(on)
  on('session.id', () => ({ value: 'sess-4' }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  await $.session.end({ reason: 'other', sessionId: 'sess-4', resume: { id: 'sess-4' } } as never)
  await box.clock.advance(1)
  expect(store.writes.length).toBe(0)
})
