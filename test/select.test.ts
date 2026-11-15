import { describe, expect, it } from 'vitest'

import type { Ev, Timeline } from '../mod/types'
import { empty, reduce } from '../mod/hooks/model/reduce'
import { agentGroups, agentTree, stepGroups, summary, taskTree, treeLines } from '../mod/hooks/model/select'

const fold = (evs: Ev[], from: Timeline = empty): Timeline => evs.reduce(reduce, from)
let clock = 5000
const at = () => ++clock
const start = (id: string, tool: string, input: Record<string, unknown> = {}, agent = 'main'): Ev =>
  ({ kind: 'step.start', at: at(), id, agent, tool, input })
const end = (id: string, status: 'done' | 'error' | 'denied' = 'done', result: unknown = {}): Ev =>
  ({ kind: 'step.end', at: at(), id, status, result })
const agent = (id: string, parent = 'main', extra: Record<string, unknown> = {}): Ev =>
  ({ kind: 'agent.start', at: at(), id, parent, type: 'Explore', description: id, ...extra })
const turnStart = (turnId: string, who = 'main'): Ev => ({ kind: 'turn.start', at: at(), turnId, agent: who, prompt: turnId })
const turnEnd = (turnId: string, who = 'main', failed = false): Ev =>
  ({ kind: 'turn.end', at: at(), turnId, agent: who, answer: '', failed })

describe('taskTree', () => {
  it('nests an agent under the task it was spawned in and its own tasks under it', () => {
    const t = fold([
      start('s1', 'TodoWrite', { todos: [{ content: 'plan', status: 'completed' }, { content: 'build', status: 'in_progress' }] }),
      agent('a1'),
      start('s2', 'TodoWrite', { todos: [{ content: 'sub one', status: 'pending' }, { content: 'sub two', status: 'pending' }] }, 'a1'),
    ])
    const tree = taskTree(t)
    expect(tree.map((n) => n.task.subject)).toEqual(['plan', 'build'])
    expect(tree[0]!.agents).toEqual([])
    expect(tree[1]!.agents).toHaveLength(1)
    expect(tree[1]!.agents[0]!.agent.id).toBe('a1')
    expect(tree[1]!.agents[0]!.tasks.map((x) => x.subject)).toEqual(['sub one', 'sub two'])
  })

  it("keeps an unlinked agent's tasks at the top level", () => {
    const t = fold([start('s', 'TodoWrite', { todos: [{ content: 'loose', status: 'pending' }] }, 'a9')])
    expect(taskTree(t).map((n) => n.task.subject)).toEqual(['loose'])
  })
})

describe('agentGroups', () => {
  it('puts runless first and counts done', () => {
    const t = fold([
      agent('w1', 'main', { runId: 'r1', agentIndex: 1 }),
      agent('a1'),
      agent('a2'),
      agent('w2', 'main', { runId: 'r1', agentIndex: 2 }),
      turnEnd('x', 'a1'),
      turnEnd('y', 'w1'),
    ])
    const g = agentGroups(t)
    expect(g).toHaveLength(2)
    expect(g[0]!.run).toBeUndefined()
    expect(g[0]!.agents.map((a) => a.id)).toEqual(['a2', 'a1'])
    expect(g[0]!.done).toBe(1)
    expect(g[1]!.run!.runId).toBe('r1')
    expect(g[1]!.agents.map((a) => a.id)).toEqual(['w2', 'w1'])
    expect(g[1]!.done).toBe(1)
    expect(agentGroups(empty)).toEqual([])
  })
})

describe('agentTree and treeLines', () => {
  it('nests a sub-subagent two levels down and a run under its caller', () => {
    const t = fold([
      agent('A'),
      agent('A1', 'A'),
      agent('B'),
      agent('W1', 'B', { runId: 'r', agentIndex: 1 }),
      agent('W2', 'B', { runId: 'r', agentIndex: 2 }),
      turnEnd('z', 'W1'),
      agent('orphan', 'ghost'),
    ])
    const root = agentTree(t)
    expect(root.key).toBe('main')
    expect(root.children.map((c) => c.key)).toEqual(['A', 'B', 'orphan'])
    const a = root.children[0]!
    expect(a.children.map((c) => c.key)).toEqual(['A1'])
    const b = root.children[1]!
    expect(b.children.map((c) => c.key)).toEqual(['run:r'])
    const run = b.children[0]!
    expect(run).toMatchObject({ kind: 'run', done: 1 })
    expect(run.run!.runId).toBe('r')
    expect(run.children.map((c) => c.key)).toEqual(['W1', 'W2'])
  })

  it('builds prefixes and skips folded children', () => {
    const t = fold([agent('A'), agent('A1', 'A'), agent('B')])
    const root = agentTree(t)
    const lines = treeLines(root, [])
    expect(lines.map((l) => [l.key, l.prefix])).toEqual([
      ['main', ''],
      ['A', '├─ '],
      ['A1', '│  └─ '],
      ['B', '└─ '],
    ])
    const folded = treeLines(root, ['A'])
    expect(folded.map((l) => l.key)).toEqual(['main', 'A', 'B'])
    expect(folded[1]!.folded).toBe(true)
    expect(folded[0]!.folded).toBe(false)
  })

  it('uses three spaces under a last child', () => {
    const t = fold([agent('A'), agent('A1', 'A'), agent('A2', 'A')])
    expect(treeLines(agentTree(t), []).map((l) => l.prefix)).toEqual(['', '└─ ', '   ├─ ', '   └─ '])
  })
})

describe('stepGroups', () => {
  const t = fold([
    turnStart('t1'),
    start('s1', 'Bash', { command: 'a' }),
    end('s1', 'error'),
    start('s2', 'Bash', { command: 'b' }),
    end('s2'),
    turnEnd('t1'),
    turnStart('t2'),
    start('s3', 'Read', { file_path: 'x' }),
    agent('a1'),
    start('s4', 'Read', { file_path: 'y' }, 'a1'),
    { kind: 'pin', id: 's2', note: '' },
  ])

  it('orders newest turn first and newest step first', () => {
    const g = stepGroups(t, { kind: 'all' })
    expect(g.map((x) => x.turn?.id)).toEqual([undefined, 't2', 't1'])
    expect(g[2]!.steps.map((s) => s.id)).toEqual(['s2', 's1'])
    expect(g[0]!.steps.map((s) => s.id)).toEqual(['s4'])
  })

  it('filters', () => {
    const ids = (f: Parameters<typeof stepGroups>[1]) => stepGroups(t, f).flatMap((x) => x.steps.map((s) => s.id))
    expect(ids({ kind: 'pinned' })).toEqual(['s2'])
    expect(ids({ kind: 'errors' })).toEqual(['s1'])
    expect(ids({ kind: 'agent', id: 'a1' })).toEqual(['s4'])
    expect(ids({ kind: 'agent', id: 'main' })).toEqual(['s3', 's2', 's1'])
    expect(stepGroups(empty, { kind: 'all' })).toEqual([])
  })
})

describe('summary', () => {
  it('of empty', () => {
    expect(summary(empty)).toEqual({ fromClaude: false, done: 0, total: 0, running: [], finished: 0, latest: [], steps: 0, errors: 0, changed: 0, notes: [], artifacts: [] })
  })

  it('takes focus from the in-progress task without now', () => {
    const t = fold([
      start('s1', 'TodoWrite', { todos: [
        { content: 'Plan', status: 'completed' },
        { content: 'Build it', status: 'in_progress', activeForm: 'Building it' },
        { content: 'Ship', status: 'pending' },
        { content: 'Celebrate', status: 'pending' },
      ] }),
    ])
    const s = summary(t)
    expect(s).toMatchObject({ focus: 'Building it', fromClaude: false, done: 1, total: 4 })
    expect(s.current!.subject).toBe('Build it')
    expect(s.upcoming!.subject).toBe('Ship')
    const u = fold([start('s2', 'TaskUpdate', { taskId: 'todo:main:1', subject: 'Only subject' }), end('s2')], t)
    expect(summary({ ...u, tasks: u.tasks.map(({ activeForm: _a, ...x }) => x) }).focus).toBe('Only subject')
  })

  it('with now is fromClaude', () => {
    const t = fold([
      start('s1', 'TodoWrite', { todos: [{ content: 'Build', status: 'in_progress' }] }),
      { kind: 'update', at: at(), agent: 'main', update: { focus: 'Wiring hooks', next: 'tests' } },
    ])
    expect(summary(t)).toMatchObject({ focus: 'Wiring hooks', next: 'tests', fromClaude: true })
    expect(summary(t).focusAt).toBeTypeOf('number')
  })

  it('counts agents, steps, errors, and keeps the newest few', () => {
    let t = fold([
      agent('a1'), agent('a2'), turnEnd('q', 'a2'),
      start('s1', 'Bash', { command: '1' }), end('s1', 'error'),
      start('s2', 'Edit', { file_path: 'a.ts' }), end('s2'),
    ])
    for (let i = 0; i < 5; i++) t = fold([start(`x${i}`, 'Bash', { command: String(i) }), { kind: 'update', at: at(), agent: 'main', update: { note: `n${i}`, artifact: { title: `r${i}`, kind: 'result' } } }], t)
    const s = summary(t)
    expect(s.running.map((a) => a.id)).toEqual(['a1'])
    expect(s.finished).toBe(1)
    expect(s.steps).toBe(7)
    expect(s.errors).toBe(1)
    expect(s.changed).toBe(1)
    expect(s.latest.map((x) => x.id)).toEqual(['x4', 'x3', 'x2', 'x1'])
    expect(s.notes.map((n) => n.text)).toEqual(['n4', 'n3', 'n2'])
    expect(s.artifacts.map((a) => a.title)).toEqual(['r4', 'r3', 'r2'])
  })
})
