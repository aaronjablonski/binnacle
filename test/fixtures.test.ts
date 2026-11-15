import { describe, expect, it } from 'vitest'

import type { Ev, Timeline } from '../mod/types'
import { empty, reduce } from '../mod/hooks/model/reduce'
import { fixtureEvents, fromFixture } from '../mod/hooks/model/select'

const raw = import.meta.glob<string>('./fixtures/probe-*.jsonl', { query: '?raw', import: 'default', eager: true })

const lines = (name: string): unknown[] => {
  const text = raw[`./fixtures/probe-${name}.jsonl`]
  if (text === undefined) throw new Error(`no fixture probe-${name}.jsonl`)
  return text.split('\n').filter((l) => l.trim() !== '').map((l): unknown => JSON.parse(l))
}

const play = (name: string): Timeline => fixtureEvents(lines(name)).reduce(reduce, empty)

function wellFormed(t: Timeline) {
  for (const s of t.steps) expect(Object.keys(t.agents)).toContain(s.agent)
  expect(t.steps.filter((s) => s.status === 'running')).toEqual([])
  expect(t.steps.filter((s) => s.pending !== undefined)).toEqual([])
}

describe('fromFixture', () => {
  it('maps the stateless lines', () => {
    expect(fromFixture({ at: 1, event: 'tool.call', e: { tool: 'Read', tool_use_id: 'u1', file_path: 'a.ts', agentId: 'x' } }))
      .toEqual([{ kind: 'step.start', at: 1, id: 'u1', agent: 'x', tool: 'Read', input: { file_path: 'a.ts' } }])
    expect(fromFixture({ at: 2, event: 'tool.result', e: { tool: 'Read', tool_use_id: 'u1' }, r: { result: { ok: 1 } } }))
      .toEqual([{ kind: 'step.end', at: 2, id: 'u1', status: 'done', result: { ok: 1 } }])
    expect(fromFixture({ at: 3, event: 'tool.result', e: { tool_use_id: 'u2' }, r: { isError: true, result: 'boom' } }))
      .toEqual([{ kind: 'step.end', at: 3, id: 'u2', status: 'error', result: 'boom' }])
    expect(fromFixture({ at: 4, event: 'tool.result', e: { tool_use_id: 'u3' }, r: { deny: 'no' } }))
      .toEqual([{ kind: 'step.end', at: 4, id: 'u3', status: 'denied' }])
    expect(fromFixture({ at: 5, event: 'turn.start', e: { text: 'hi', turnId: 't' } }))
      .toEqual([{ kind: 'turn.start', at: 5, turnId: 't', agent: 'main', prompt: 'hi' }])
    expect(fromFixture({ at: 6, event: 'turn.complete', e: { answer: 'a', turnId: 't', agentId: 'x', isAborted: false, reason: 'answer' } }))
      .toEqual([{ kind: 'turn.end', at: 6, turnId: 't', agent: 'x', answer: 'a', failed: false }])
    expect(fromFixture({ at: 7, event: 'turn.complete', e: { answer: '', turnId: 't', isAborted: true, reason: 'aborted' } })[0])
      .toMatchObject({ failed: true })
    expect(fromFixture({ at: 8, event: 'agent.spawn', e: { tool_use_id: 'u4' } })).toEqual([])
    expect(fromFixture({ at: 9, event: 'agent.spawned', e: { tool_use_id: 'u4' }, r: { agentId: 'z' } }))
      .toEqual([{ kind: 'agent.start', at: 9, id: 'z', parent: 'main', type: 'unknown', description: '' }])
    for (const junk of [null, 3, 'x', {}, { event: 'session.receive', e: {} }, { event: 'tool.call', e: {} }]) expect(fromFixture(junk)).toEqual([])
  })
})

describe('fixtureEvents', () => {
  it('pairs workflow spawns with their agent ids in order', () => {
    const evs = fixtureEvents(lines('workflow')).filter((e): e is Extract<Ev, { kind: 'agent.start' }> => e.kind === 'agent.start')
    expect(evs.map((e) => [e.id, e.agentIndex, e.runId, e.type, e.description])).toEqual([
      ['aceff99dd3da32c85', 1, 'wf_18950403-0bb', 'workflow-subagent', 'read:agent-1'],
      ['a7eba813391b91f8e', 2, 'wf_18950403-0bb', 'workflow-subagent', 'read:agent-2'],
    ])
  })
})

describe('fixtures fold through reduce', () => {
  it('subagent', () => {
    const t = play('subagent')
    wellFormed(t)
    const subs = Object.values(t.agents).filter((a) => a.id !== 'main')
    expect(subs.length).toBeGreaterThanOrEqual(1)
    expect(t.agents.a41a5036f06e55d2f).toMatchObject({ type: 'Explore', description: 'Count JSON files in folder', parent: 'main', status: 'done', stepCount: 2 })
    expect(t.agents.a41a5036f06e55d2f!.doing).toMatch(/^\(1\) Total \.json files/)
  })

  it('subagent in the background (guide)', () => {
    const t = play('guide')
    wellFormed(t)
    expect(t.agents.a8ea70b5622da885c).toMatchObject({ type: 'Explore', status: 'done' })
    expect(t.turns.map((x) => x.agent)).toEqual(['main', 'a8ea70b5622da885c', 'main'])
  })

  it('tasks', () => {
    const t = play('tasks')
    wellFormed(t)
    expect(t.tasks).toHaveLength(3)
    expect(t.tasks.map((x) => [x.id, x.subject, x.status])).toEqual([
      ['1', 'Task A', 'completed'],
      ['2', 'Task B', 'pending'],
      ['3', 'Task C', 'pending'],
    ])
  })

  it('workflow', () => {
    const t = play('workflow')
    wellFormed(t)
    expect(Object.values(t.runs)).toHaveLength(1)
    const run = t.runs['wf_18950403-0bb']!
    expect(run).toMatchObject({ name: 'read-package-name', parent: 'main' })
    const inRun = Object.values(t.agents).filter((a) => a.runId === run.runId)
    expect(inRun).toHaveLength(2)
    // workflow agents answer through StructuredOutput: an empty answer keeps their last label
    for (const a of inRun) expect(a).toMatchObject({ status: 'done', doing: expect.stringMatching(/^StructuredOutput /) })
  })

  it('stays far under the $.state limit', () => {
    for (const name of ['subagent', 'guide', 'tasks', 'workflow']) {
      expect(JSON.stringify(play(name)).length).toBeLessThan(64 * 1024)
    }
  })
})
