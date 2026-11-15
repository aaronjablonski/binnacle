import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Timeline, UiState } from '../types'
import { ASK_MS, needsYou } from './views/needs'

type Box = { timeline?: Timeline; writes: Timeline[] }

const UI = { dismissed: [] } as unknown as UiState
// No hook beneath answers the request: the prompt is the person's.
const unanswered = (on: On) => on('classic.PermissionRequest', () => ({}))
const AGENT_INPUT = { subagent_type: 'Explore', description: 'look', prompt: 'p' }

// The world beneath the mod: a clock, no home folder (so the journal stays
// quiet), a debug log that goes nowhere, and a recorder of the timeline the
// mod writes (the test's `$` has no `state` noun of its own).
function world(on: On, opts: { failState?: boolean } = {}): Box {
  const box: Box = { writes: [] }
  mock.clock(on, { now: 1000 })
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
  expect(needsYou(during!, UI, 1000 + 5 * 60_000)).toEqual([])

  const verdict = await $.tool.check({ tool: 'Bash', input: { command: 'npm test' } })
  expect(verdict).toEqual({ decision: 'ask', reason: 'needs a yes' })
})

test('a permission request marks the running step with the same command; its need shows from 20 s and clears when the step ends', async ($, on) => {
  const box = world(on)
  unanswered(on)
  let during: Timeline | undefined
  on('tool.call', async () => {
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'npm test' } })
    during = box.timeline
    return { result: {}, text: 'ok' }
  })

  await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'toolu_p' } as never)

  const step = during?.steps.find(s => s.id === 'toolu_p')
  expect(step?.status).toBe('running')
  expect(step?.asking).toBe(1000)
  expect(needsYou(during!, UI, 1000 + ASK_MS - 1)).toEqual([])
  expect(needsYou(during!, UI, 1000 + ASK_MS).map(p => p.key)).toEqual(['asking:toolu_p'])
  const ended = box.timeline?.steps.find(s => s.id === 'toolu_p')
  expect(ended?.status).toBe('done')
  expect(ended?.asking).toBe(undefined)
  expect(needsYou(box.timeline!, UI, 1000 + 5 * 60_000)).toEqual([])
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
