import { describe, expect, it } from 'vitest'

import type { Ev, Step, Timeline } from '../mod/types'
import { empty, reduce } from '../mod/hooks/model/reduce'
import { dismissKey, findSteps, problems, runBoard, signatureOf } from '../mod/hooks/model/select'

const fold = (evs: Ev[], from: Timeline = empty): Timeline => evs.reduce(reduce, from)
let clock = 1_000_000
const at = () => ++clock
const start = (id: string, tool: string, input: Record<string, unknown> = {}, agent = 'main'): Ev =>
  ({ kind: 'step.start', at: at(), id, agent, tool, input })
const end = (id: string, status: 'done' | 'error' | 'denied' = 'done', result: unknown = {}): Ev =>
  ({ kind: 'step.end', at: at(), id, status, result })
const agent = (id: string, extra: Partial<Extract<Ev, { kind: 'agent.start' }>> = {}): Ev =>
  ({ kind: 'agent.start', at: at(), id, parent: 'main', type: 'Explore', description: `desc ${id}`, ...extra })
const turnStart = (turnId: string, who = 'main', prompt = turnId): Ev => ({ kind: 'turn.start', at: at(), turnId, agent: who, prompt })
const turnEnd = (turnId: string, who = 'main', failed = false): Ev =>
  ({ kind: 'turn.end', at: at(), turnId, agent: who, answer: '', failed })

const STALL = 180_000
const TEN_MIN = 600_000

describe('signatureOf', () => {
  const step = (tool: string, label: string): Step => ({ id: 'x', seq: 1, agent: 'main', tool, label, status: 'done', startedAt: 0 })

  it('is the tool and the label without its tool prefix, whitespace collapsed', () => {
    expect(signatureOf(step('Bash', 'Bash npm   test'))).toBe('Bash:npm test')
    expect(signatureOf(step('Read', 'Read src/a.ts'))).toBe('Read:src/a.ts')
  })

  it('keeps a label that does not start with the tool', () => {
    expect(signatureOf(step('TaskUpdate', 'Task 3 → completed'))).toBe('TaskUpdate:Task 3 → completed')
  })

  it('tells the same label of two tools apart, and the same tool on two targets apart', () => {
    expect(signatureOf(step('Bash', 'Bash ls'))).not.toBe(signatureOf(step('PowerShell', 'PowerShell ls')))
    expect(signatureOf(step('Read', 'Read a.ts'))).not.toBe(signatureOf(step('Read', 'Read b.ts')))
  })
})

describe('problems', () => {
  it('asking: a running step the check sent to ask, until it ends', () => {
    const t = fold([start('s1', 'Bash', { command: 'rm -rf build' }, 'a1'), { kind: 'step.ask', at: 1_000_500, id: 's1' }])
    const now = 1_010_000
    expect(problems(t, now, [])).toEqual([
      { key: 'asking:s1', kind: 'asking', label: 'Bash rm -rf build', agent: 'a1', stepId: 's1', since: 1_000_500 },
    ])
    expect(problems(fold([end('s1')], t), now, [])).toEqual([])
  })

  it('repeat: the same signature failed twice in the session, across turns', () => {
    const t = fold([
      turnStart('t1'), start('s1', 'Bash', { command: 'npm test' }), end('s1', 'error'), turnEnd('t1'),
      turnStart('t2'), start('s2', 'Bash', { command: 'npm  test' }), end('s2', 'error'),
      start('s3', 'Bash', { command: 'npm run lint' }), end('s3', 'error'),
    ])
    const got = problems(t, clock, []).filter((p) => p.kind === 'repeat')
    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({ key: 'repeat:Bash:npm test', label: 'Bash npm test', agent: 'main', stepId: 's2', count: 2 })
    expect(got[0]!.since).toBe(t.steps.find((s) => s.id === 's2')!.endedAt)
  })

  it('a single failure is not a repeat', () => {
    const t = fold([start('s1', 'Bash', { command: 'npm test' }), end('s1', 'error'), start('s2', 'Bash', { command: 'npm test' }), end('s2')])
    expect(problems(t, clock, [])).toEqual([])
  })

  it('loop: the same signature three times in one turn, failed or not', () => {
    const t = fold([
      turnStart('t1'),
      start('s1', 'Read', { file_path: 'C:/r/src/a.ts' }), end('s1'),
      start('s2', 'Read', { file_path: 'C:/r/src/a.ts' }), end('s2'),
      start('s3', 'Read', { file_path: 'C:/r/src/a.ts' }), end('s3'),
    ])
    const got = problems(t, clock, [])
    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({ key: 'loop:t1:Read:src/a.ts', kind: 'loop', label: 'Read src/a.ts', agent: 'main', stepId: 's3', count: 3 })
    expect(got[0]!.since).toBe(t.steps.find((s) => s.id === 's3')!.startedAt)
  })

  it('three runs split over two turns are no loop', () => {
    const t = fold([
      turnStart('t1'), start('s1', 'Read', { file_path: 'a.ts' }), end('s1'), start('s2', 'Read', { file_path: 'a.ts' }), end('s2'), turnEnd('t1'),
      turnStart('t2'), start('s3', 'Read', { file_path: 'a.ts' }), end('s3'),
    ])
    expect(problems(t, clock, [])).toEqual([])
  })

  it('a signature that is a repeat failure is not also reported as a loop', () => {
    const t = fold([
      turnStart('t1'),
      start('s1', 'Bash', { command: 'npm test' }), end('s1', 'error'),
      start('s2', 'Bash', { command: 'npm test' }), end('s2', 'error'),
      start('s3', 'Bash', { command: 'npm test' }), end('s3', 'error'),
    ])
    expect(problems(t, clock, []).map((p) => p.kind)).toEqual(['repeat'])
  })

  it('stalled: a running subagent that started no step for more than three minutes', () => {
    const t = fold([agent('a1'), start('s1', 'Read', { file_path: 'a.ts' }, 'a1'), end('s1'), agent('a2'), agent('a3')])
    const last = t.agents.a1!.lastStepAt!
    expect(last).toBe(t.steps[0]!.startedAt)
    const a2Start = t.agents.a2!.startedAt
    // a3 finished; main never counts.
    const done = fold([turnEnd('x', 'a3')], t)
    expect(problems(done, last + STALL, [])).toEqual([])
    const got = problems(done, a2Start + STALL + 1, [])
    expect(got.map((p) => [p.key, p.kind, p.agent, p.label, p.since])).toEqual([
      ['stalled:a2', 'stalled', 'a2', 'desc a2', a2Start],
      ['stalled:a1', 'stalled', 'a1', 'desc a1', last],
    ])
  })

  it('failed-turn: a turn that ended failed within the last ten minutes', () => {
    const t = fold([turnStart('t1', 'main', 'fix the build'), turnEnd('t1', 'main', true), turnStart('t2'), turnEnd('t2')])
    const ended = t.turns[0]!.endedAt!
    expect(t.turns[0]!.failed).toBe(true)
    expect(t.turns[1]!.failed).toBeUndefined()
    expect(problems(t, ended + TEN_MIN, [])).toEqual([
      { key: 'failed-turn:t1', kind: 'failed-turn', label: 'fix the build', agent: 'main', since: ended },
    ])
    expect(problems(t, ended + TEN_MIN + 1, [])).toEqual([])
  })

  it('newest first', () => {
    const t = fold([
      turnStart('t1', 'main', 'old'), turnEnd('t1', 'main', true),
      start('s1', 'Bash', { command: 'x' }), { kind: 'step.ask', at: at(), id: 's1' },
    ])
    expect(problems(t, clock, []).map((p) => p.kind)).toEqual(['asking', 'failed-turn'])
  })

  it('a dismissed problem stays quiet until its count grows', () => {
    const evs: Ev[] = [start('s1', 'Bash', { command: 'npm test' }), end('s1', 'error'), start('s2', 'Bash', { command: 'npm test' }), end('s2', 'error')]
    const t = fold(evs)
    const [p] = problems(t, clock, [])
    expect(dismissKey(p!)).toBe('repeat:Bash:npm test#2')
    expect(problems(t, clock, [dismissKey(p!)])).toEqual([])
    const grown = fold([start('s3', 'Bash', { command: 'npm test' }), end('s3', 'error')], t)
    expect(problems(grown, clock, [dismissKey(p!)])).toMatchObject([{ key: 'repeat:Bash:npm test', count: 3 }])
  })

  it('a dismissed problem without a count stays dismissed', () => {
    const t = fold([start('s1', 'Bash', { command: 'x' }), { kind: 'step.ask', at: at(), id: 's1' }])
    const [p] = problems(t, clock, [])
    expect(dismissKey(p!)).toBe('asking:s1')
    expect(problems(t, clock + 60_000, ['asking:s1'])).toEqual([])
  })
})

describe('findSteps', () => {
  const t = fold([
    agent('a1', { type: 'general-purpose' }),
    start('s1', 'Bash', { command: 'curl -i https://api/upload  # 429' }),
    start('s2', 'Edit', { file_path: 'C:/r/src/server/rateLimit.ts' }, 'a1'),
    start('s3', 'Read', { file_path: 'C:/r/README.md' }),
    { kind: 'pin', id: 's3', note: 'The LIMITER design notes' },
  ])

  it('matches tool, label, agent type and pin note, case-insensitive, newest first', () => {
    expect(findSteps(t, '429').map((s) => s.id)).toEqual(['s1'])
    expect(findSteps(t, 'RATELIMIT').map((s) => s.id)).toEqual(['s2'])
    expect(findSteps(t, 'general').map((s) => s.id)).toEqual(['s2'])
    expect(findSteps(t, 'limiter').map((s) => s.id)).toEqual(['s3'])
    expect(findSteps(t, 'edit').map((s) => s.id)).toEqual(['s2'])
    expect(findSteps(t, 'r').map((s) => s.id)).toEqual(['s3', 's2', 's1'])
  })

  it('an empty or blank query matches every step; no match is empty', () => {
    expect(findSteps(t, '  ').map((s) => s.id)).toEqual(['s3', 's2', 's1'])
    expect(findSteps(t, 'nothing like it')).toEqual([])
  })
})

describe('runBoard', () => {
  const t = fold([
    start('wf', 'Workflow', { script: 'x' }),
    end('wf', 'done', { runId: 'r1', workflowName: 'review' }),
    agent('w2', { runId: 'r1', agentIndex: 2, type: 'workflow-subagent' }),
    agent('w1', { runId: 'r1', agentIndex: 1, type: 'workflow-subagent' }),
    agent('w3', { runId: 'r1', agentIndex: 3, type: 'workflow-subagent' }),
    agent('other', { runId: 'r2', agentIndex: 1 }),
    start('a', 'Read', { file_path: 'a.ts' }, 'w1'), end('a'),
    start('b', 'Read', { file_path: 'b.ts' }, 'w1'), end('b', 'error'),
    start('c', 'Grep', { pattern: 'x' }, 'w2'),
    start('d', 'Read', { file_path: 'd.ts' }, 'other'),
    turnEnd('x1', 'w1'),
    turnEnd('x3', 'w3', true),
  ])

  it('lists the run agents in spawn order with their steps, and counts done and failed', () => {
    const b = runBoard(t, 'r1')!
    expect(b.run).toMatchObject({ runId: 'r1', name: 'review' })
    expect(b.agents.map((a) => a.id)).toEqual(['w1', 'w2', 'w3'])
    expect(Object.keys(b.steps).sort()).toEqual(['w1', 'w2', 'w3'])
    expect(b.steps.w1!.map((s) => s.id)).toEqual(['a', 'b'])
    expect(b.steps.w2!.map((s) => s.id)).toEqual(['c'])
    expect(b.steps.w3).toEqual([])
    expect(b.done).toBe(1)
    expect(b.failed).toBe(1)
  })

  it('elapsed runs to now while an agent runs, else to the last end', () => {
    const run = t.runs.r1!
    expect(runBoard(t, 'r1', run.startedAt + 90_000)!.elapsed).toBe(90_000)
    const finished = fold([turnEnd('x2', 'w2')], t)
    const last = finished.agents.w2!.endedAt!
    expect(runBoard(finished, 'r1', last + 999_999)!.elapsed).toBe(last - run.startedAt)
    // With no clock given, a running board measures to its newest activity.
    expect(runBoard(t, 'r1')!.elapsed).toBe(t.agents.w3!.endedAt! - run.startedAt)
  })

  it('is undefined for a run it does not know', () => {
    expect(runBoard(t, 'nope')).toBeUndefined()
  })
})
