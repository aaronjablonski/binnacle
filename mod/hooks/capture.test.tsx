import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Timeline } from '../types'

type Box = { timeline?: Timeline }

// The world beneath the mod: a clock, no home folder (so the journal stays
// quiet), a debug log that goes nowhere, and a recorder of the timeline the
// mod writes (the test's `$` has no `state` noun of its own).
function world(on: On, opts: { failState?: boolean } = {}): Box {
  const box: Box = {}
  mock.clock(on, { now: 1000 })
  mock.env(on, {})
  on('ui.log', () => ({ value: undefined }))
  on('state.set', async (_, e, next) => {
    if (opts.failState === true) throw new Error('state is down')
    const out = await next(e)
    if (e.key === 'timeline') box.timeline = (e.value as { value?: Timeline } | undefined)?.value
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
