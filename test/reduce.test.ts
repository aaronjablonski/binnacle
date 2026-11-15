import { describe, expect, it } from 'vitest'

import type { Ev, Timeline } from '../mod/types'
import { MAX_LINE, MAX_NOTES, MAX_STEPS } from '../mod/hooks/model/limits'
import { empty, reduce, settle } from '../mod/hooks/model/reduce'
import { sigOf } from '../mod/hooks/model/label'

const fold = (evs: Ev[], from: Timeline = empty): Timeline => evs.reduce(reduce, from)

let clock = 1000
const at = () => ++clock

const start = (id: string, tool: string, input: Record<string, unknown> = {}, agent = 'main'): Ev =>
  ({ kind: 'step.start', at: at(), id, agent, tool, input })
const end = (id: string, result?: unknown, status: 'done' | 'error' | 'denied' = 'done'): Ev =>
  ({ kind: 'step.end', at: at(), id, status, result })
const agentStart = (id: string, parent = 'main', extra: Partial<Extract<Ev, { kind: 'agent.start' }>> = {}): Ev =>
  ({ kind: 'agent.start', at: at(), id, parent, type: 'Explore', description: 'look', ...extra })
const update = (update: Record<string, unknown>, agent = 'main'): Ev =>
  ({ kind: 'update', at: at(), agent, update: update as never })

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v)
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k])
  }
  return v
}

describe('reduce', () => {
  it('appends a step and updates the agent', () => {
    const t = fold([start('s1', 'Bash', { command: 'npm test' })])
    expect(t.steps).toHaveLength(1)
    expect(t.steps[0]).toMatchObject({ id: 's1', seq: 1, agent: 'main', tool: 'Bash', label: 'Bash npm test', status: 'running' })
    expect(t.seq).toBe(1)
    expect(t.agents.main).toMatchObject({ stepCount: 1, doing: 'Bash npm test' })
  })

  it('creates an unknown agent on the fly', () => {
    const t = fold([start('s1', 'Read', { file_path: 'C:/r/src/a.ts' }, 'a1')])
    expect(t.agents.a1).toMatchObject({ id: 'a1', type: 'unknown', description: '', parent: 'main', status: 'running', stepCount: 1, doing: 'Read src/a.ts' })
  })

  it("TodoWrite replaces that agent's tasks", () => {
    const t = fold([
      start('s1', 'TodoWrite', { todos: [{ content: 'one', status: 'pending', activeForm: 'Doing one' }, { content: 'two', status: 'in_progress' }] }),
      start('s2', 'TodoWrite', { todos: [{ content: 'other', status: 'completed' }] }, 'a1'),
      start('s3', 'TodoWrite', { todos: [{ content: 'three', status: 'completed' }] }),
    ])
    expect(t.tasks.map((x) => [x.id, x.subject, x.status, x.owner])).toEqual([
      ['todo:a1:0', 'other', 'completed', 'a1'],
      ['todo:main:0', 'three', 'completed', 'main'],
    ])
  })

  it('TaskCreate adds a task from its result id', () => {
    const t = fold([
      start('s1', 'TaskCreate', { subject: 'Task A', description: 'Task A', activeForm: 'Doing A' }),
      end('s1', { task: { id: '1', subject: 'Task A', description: 'Task A' } }),
    ])
    expect(t.tasks).toEqual([{ id: '1', subject: 'Task A', activeForm: 'Doing A', status: 'pending', owner: 'main', updatedAt: expect.any(Number) }])
    expect(t.steps[0]!.pending).toBeUndefined()
    expect(t.steps[0]!.status).toBe('done')
  })

  it('TaskUpdate for an unseen id creates a placeholder', () => {
    const t = fold([
      start('s1', 'TaskUpdate', { taskId: '7', status: 'in_progress' }),
      end('s1', { success: true, taskId: '7', updatedFields: ['status'] }),
    ])
    expect(t.tasks).toEqual([{ id: '7', subject: 'Task 7', status: 'in_progress', owner: 'main', updatedAt: expect.any(Number) }])
  })

  it('TaskUpdate deleted removes the task', () => {
    const t = fold([
      start('s1', 'TaskCreate', { subject: 'A' }),
      end('s1', { task: { id: '1' } }),
      start('s2', 'TaskUpdate', { taskId: '1', subject: 'A2', status: 'completed' }),
      end('s2', { success: true }),
    ])
    expect(t.tasks[0]).toMatchObject({ id: '1', subject: 'A2', status: 'completed' })
    const u = fold([start('s3', 'TaskUpdate', { taskId: '1', status: 'deleted' }), end('s3', { success: true })], t)
    expect(u.tasks).toEqual([])
  })

  it('TodoWrite and Task tools share one list', () => {
    const t = fold([
      start('s1', 'TodoWrite', { todos: [{ content: 'todo', status: 'pending' }] }),
      start('s2', 'TaskCreate', { subject: 'made' }, 'a1'),
      end('s2', { task: { id: '1' } }),
      start('s3', 'TaskUpdate', { taskId: '1', status: 'in_progress' }, 'a1'),
      end('s3', { success: true }),
    ])
    expect(t.tasks.map((x) => [x.id, x.status, x.owner])).toEqual([
      ['todo:main:0', 'pending', 'main'],
      ['1', 'in_progress', 'a1'],
    ])
  })

  it('writing a .md adds a document artifact and a second write bumps its count', () => {
    const t = fold([
      start('s1', 'Write', { file_path: 'C:/r/docs/plan.md', content: 'x' }),
      end('s1', {}),
      start('s2', 'Edit', { file_path: 'C:/r/docs/plan.md', old_string: 'x', new_string: 'y' }),
      end('s2', {}),
    ])
    expect(t.artifacts).toEqual([{ id: 'doc:C:/r/docs/plan.md', kind: 'document', title: 'docs/plan.md', ref: 'C:/r/docs/plan.md', stepId: 's2', agent: 'main', count: 2, updatedAt: expect.any(Number) }])
    expect(t.changed).toEqual([])
  })

  it('editing a .ts adds to changed and not to artifacts', () => {
    const t = fold([
      start('s1', 'Edit', { file_path: 'C:/r/src/a.ts' }),
      end('s1', {}),
      start('s2', 'Write', { file_path: 'C:/r/src/a.ts' }),
      end('s2', {}),
      start('s3', 'Write', { file_path: 'C:/r/src/b.ts' }),
      end('s3', {}, 'error'),
    ])
    expect(t.changed).toEqual(['C:/r/src/a.ts'])
    expect(t.artifacts).toEqual([])
  })

  it('an Artifact result url adds a page', () => {
    const t = fold([
      start('s1', 'Artifact', { file_path: 'C:/tmp/report.html' }),
      end('s1', { url: 'https://claude.ai/artifact/x' }),
      start('s2', 'Artifact', { file_path: 'C:/tmp/report.html', title: 'Report' }),
      end('s2', { url: 'https://claude.ai/artifact/x' }),
    ])
    expect(t.artifacts).toHaveLength(1)
    expect(t.artifacts[0]).toMatchObject({ id: 'page:https://claude.ai/artifact/x', kind: 'page', ref: 'https://claude.ai/artifact/x', title: 'Report', count: 2, stepId: 's2' })
    const u = fold([start('s3', 'Artifact', {}), end('s3', { url: 'https://claude.ai/artifact/y' })])
    expect(u.artifacts[0]!.title).toBe('Page')
    const v = fold([start('s4', 'Artifact', { file_path: 'C:\\tmp\\a.html' }), end('s4', { url: 'u' })])
    expect(v.artifacts[0]!.title).toBe('a.html')
  })

  it('Workflow result names the run', () => {
    const t = fold([
      start('w', 'Workflow', { script: '...' }),
      end('w', { status: 'async_launched', workflowName: 'read-package-name', runId: 'wf_1' }),
      agentStart('a1', 'main', { type: 'workflow-subagent', runId: 'wf_1', agentIndex: 1 }),
    ])
    expect(t.runs.wf_1).toMatchObject({ runId: 'wf_1', name: 'read-package-name', parent: 'main' })
    expect(t.agents.a1).toMatchObject({ runId: 'wf_1', agentIndex: 1, parent: 'main' })
    // agent first, then the Workflow step ends: the name is replaced
    const u = fold([
      start('w2', 'Workflow', {}, 'a9'),
      agentStart('b1', 'a9', { runId: 'wf_2', agentIndex: 1 }),
    ])
    expect(u.runs.wf_2).toMatchObject({ name: 'workflow', parent: 'a9' })
    const v = fold([end('w2', { runId: 'wf_2', workflowName: 'named' })], u)
    expect(v.runs.wf_2).toMatchObject({ name: 'named', parent: 'a9' })
  })

  it('agent.start links the in-progress task', () => {
    const t = fold([
      start('s1', 'TodoWrite', { todos: [{ content: 'one', status: 'completed' }, { content: 'two', status: 'in_progress' }] }),
      start('s2', 'TodoWrite', { todos: [{ content: 'theirs', status: 'in_progress' }] }, 'other'),
      agentStart('a1'),
    ])
    expect(t.agents.a1!.taskId).toBe('todo:main:1')
    const u = fold([agentStart('a2', 'nobody')])
    expect(u.agents.a2!.taskId).toBeUndefined()
  })

  it('a main update sets now', () => {
    const t = fold([update({ focus: '  Fixing   the parser ', next: 'run tests' })])
    expect(t.now).toEqual({ focus: 'Fixing the parser', next: 'run tests', at: expect.any(Number) })
  })

  it('next alone keeps the focus', () => {
    const t = fold([update({ focus: 'Fixing the parser', next: 'a' }), update({ next: 'b' })])
    expect(t.now).toMatchObject({ focus: 'Fixing the parser', next: 'b' })
  })

  it('a subagent focus sets its doing, not now', () => {
    const t = fold([agentStart('a1'), update({ focus: 'Reading files' }, 'a1')])
    expect(t.now).toBeUndefined()
    expect(t.agents.a1!.doing).toBe('Reading files')
  })

  it("a subagent focus is cut to 80 like its doing's other sources", () => {
    const t = fold([agentStart('a1'), update({ focus: 'f'.repeat(300) }, 'a1')])
    expect(t.agents.a1!.doing).toBe('f'.repeat(79) + '…')
  })

  it('an update note is cut to MAX_LINE and one line', () => {
    const t = fold([update({ note: 'line one\nline two ' + 'x'.repeat(500) })])
    expect(t.notes).toHaveLength(1)
    const n = t.notes[0]!
    expect(n.text.length).toBeLessThanOrEqual(MAX_LINE)
    expect(n.text).not.toMatch(/\n/)
    expect(n.text.startsWith('line one line two x')).toBe(true)
    expect(n).toMatchObject({ agent: 'main' })
  })

  it('an empty or mistyped update is a no-op', () => {
    const t = fold([start('s1', 'Bash', { command: 'ls' })])
    for (const u of [{}, { focus: '   ' }, { focus: 3, note: null }, { artifact: { title: '', kind: 'link' } }, { artifact: { title: 'x', kind: 'page' } }, { artifact: 'x' }]) {
      expect(reduce(t, update(u))).toBe(t)
    }
  })

  it('a declared link artifact is added once and updated on repeat', () => {
    const t = fold([
      update({ artifact: { title: 'PR', kind: 'link', ref: 'https://x/pr/1', summary: 'first' } }),
      update({ artifact: { title: 'PR #1', kind: 'link', ref: 'https://x/pr/1', summary: 'second' } }),
      update({ artifact: { title: 'Finding', kind: 'result' } }),
    ])
    expect(t.artifacts).toHaveLength(2)
    expect(t.artifacts[0]).toMatchObject({ id: 'link:https://x/pr/1', kind: 'link', title: 'PR #1', ref: 'https://x/pr/1', summary: 'second', count: 2, agent: 'main' })
    expect(t.artifacts[1]).toMatchObject({ id: 'result:Finding', kind: 'result', count: 1 })
  })

  it('turn.end interrupts running steps', () => {
    const t = fold([
      { kind: 'turn.start', at: at(), turnId: 't1', agent: 'main', prompt: 'go' },
      start('s1', 'Bash', { command: 'a' }),
      start('s2', 'Bash', { command: 'b' }),
      end('s2', {}),
      start('s3', 'Read', { file_path: 'x' }, 'a1'),
      { kind: 'turn.end', at: at(), turnId: 't1', agent: 'main', answer: 'ok', failed: false },
    ])
    expect(t.steps.map((s) => s.status)).toEqual(['interrupted', 'done', 'running'])
    expect(t.steps[0]!.turnId).toBe('t1')
    expect(t.turns[0]!.endedAt).toBeDefined()
    expect(t.agents.main!.status).toBe('running')
  })

  it("turn.end sets doing to the answer's first line", () => {
    const t = fold([
      agentStart('a1'),
      start('s1', 'Read', { file_path: 'x' }, 'a1'),
      { kind: 'turn.end', at: at(), turnId: 't2', agent: 'a1', answer: '  ' + 'y'.repeat(100) + '\nsecond', failed: false },
    ])
    expect(t.agents.a1).toMatchObject({ status: 'done', doing: 'y'.repeat(79) + '…' })
    expect(t.agents.a1!.endedAt).toBeDefined()
    const u = fold([{ kind: 'turn.end', at: at(), turnId: 't3', agent: 'a1', answer: '', failed: true }], t)
    expect(u.agents.a1).toMatchObject({ status: 'error', doing: 'y'.repeat(79) + '…' })
  })

  it('drops oldest unpinned past MAX_STEPS and keeps pins', () => {
    let t = fold([start('first', 'Bash', { command: 'a' }), start('second', 'Bash', { command: 'b' })])
    t = reduce(t, { kind: 'pin', id: 'first', note: '' })
    for (let i = 0; i < MAX_STEPS; i++) t = reduce(t, start(`n${i}`, 'Bash', { command: 'x' }))
    expect(t.steps).toHaveLength(MAX_STEPS)
    expect(t.steps[0]).toMatchObject({ id: 'first', pin: '' })
    expect(t.steps.some((s) => s.id === 'second')).toBe(false)
    expect(t.steps.some((s) => s.id === 'n0')).toBe(false)
    expect(t.steps.at(-1)!.id).toBe(`n${MAX_STEPS - 1}`)
  })

  it('keeps only the newest MAX_NOTES notes', () => {
    let t = empty
    for (let i = 0; i < MAX_NOTES + 5; i++) t = reduce(t, update({ note: `n${i}` }))
    expect(t.notes).toHaveLength(MAX_NOTES)
    expect(t.notes[0]!.text).toBe('n5')
    expect(t.notes.at(-1)!.text).toBe(`n${MAX_NOTES + 4}`)
  })

  it('unknown ids are no-ops', () => {
    const t = fold([start('s1', 'Bash', { command: 'a' })])
    expect(reduce(t, { kind: 'pin', id: 'nope', note: 'x' })).toBe(t)
    expect(reduce(t, { kind: 'unpin', id: 'nope' })).toBe(t)
    expect(reduce(t, end('nope', {}))).toBe(t)
    const p = reduce(t, { kind: 'pin', id: 's1', note: 'look' })
    expect(p.steps[0]!.pin).toBe('look')
    expect(reduce(p, { kind: 'unpin', id: 's1' }).steps[0]!.pin).toBeUndefined()
  })

  it('never mutates its input', () => {
    const base = fold([
      { kind: 'turn.start', at: at(), turnId: 't1', agent: 'main', prompt: 'go' },
      start('s1', 'TodoWrite', { todos: [{ content: 'one', status: 'in_progress' }] }),
      start('s2', 'Write', { file_path: 'a/b.md' }),
      start('s3', 'TaskCreate', { subject: 'A' }),
      start('w', 'Workflow', {}),
      start('pinned', 'Bash', { command: 'p' }),
      { kind: 'pin', id: 'pinned', note: 'keep' },
    ])
    const t = deepFreeze(base)
    const snapshot = JSON.stringify(t)
    const evs: Ev[] = [
      start('s4', 'Bash', { command: 'x' }, 'a1'),
      end('s2', {}),
      end('s3', { task: { id: '1' } }),
      end('w', { runId: 'r', workflowName: 'n' }),
      agentStart('a2', 'main', { runId: 'r2', agentIndex: 1 }),
      update({ focus: 'f', note: 'n', artifact: { title: 'x', kind: 'result' } }),
      update({ focus: 'g' }, 'a1'),
      { kind: 'pin', id: 's1', note: 'p' },
      { kind: 'unpin', id: 'pinned' },
      { kind: 'turn.start', at: at(), turnId: 't2', agent: 'a1', prompt: 'p' },
      { kind: 'turn.end', at: at(), turnId: 't1', agent: 'main', answer: 'done', failed: false },
      start('s5', 'TodoWrite', { todos: [] }),
    ]
    // reduce swallows errors, so a write to a frozen value would come back as `t`:
    // every event here must produce a new value.
    for (const ev of evs) expect(reduce(t, ev)).not.toBe(t)
    expect(JSON.stringify(t)).toBe(snapshot)
  })

  it('a step keeps the sig of its call', () => {
    const t = fold([start('s1', 'Bash', { command: 'npm test' })])
    expect(t.steps[0]!.sig).toBe(sigOf('Bash', { command: 'npm test' }))
  })
})

describe('asks cleared on evidence the call went ahead', () => {
  const ask = (id: string): Ev => ({ kind: 'step.ask', at: at(), id })

  it('step.unask clears the mark and leaves the step running', () => {
    const t = fold([start('call', 'Agent', { subagent_type: 'Explore', description: 'look' }), ask('call'), { kind: 'step.unask', id: 'call' }])
    expect(t.steps[0]!.asking).toBeUndefined()
    expect(t.steps[0]!.status).toBe('running')
  })

  it('step.unask of an unknown or unmarked step is a no-op', () => {
    const t = fold([start('s1', 'Bash', { command: 'a' })])
    expect(reduce(t, { kind: 'step.unask', id: 'nope' })).toBe(t)
    expect(reduce(t, { kind: 'step.unask', id: 's1' })).toBe(t)
  })

  it('agent.start keeps the step that spawned it', () => {
    const t = fold([agentStart('a1', 'main', { spawnStep: 'call' })])
    expect(t.agents.a1!.spawnStep).toBe('call')
  })

  it("the first step of a spawned agent clears its spawning call's ask", () => {
    const t = fold([
      start('call', 'Workflow', { script: 'x' }), ask('call'),
      agentStart('w1', 'main', { spawnStep: 'call', runId: 'r1', agentIndex: 1 }),
    ])
    expect(t.steps[0]!.asking).toBeDefined()
    const u = fold([start('w1s1', 'Read', { file_path: 'a.ts' }, 'w1')], t)
    expect(u.steps[0]!.asking).toBeUndefined()
    expect(u.steps[0]!.status).toBe('running')
  })
})

describe('settle: a snapshot folded through an interrupt pass', () => {
  it('interrupts running steps and drops their asks, and ends running subagents at the last activity', () => {
    const t = fold([
      { kind: 'turn.start', at: at(), turnId: 't1', agent: 'main', prompt: 'go' },
      start('s1', 'Bash', { command: 'npm test' }), { kind: 'step.ask', at: at(), id: 's1' },
      agentStart('a1'), start('a1s1', 'Read', { file_path: 'x' }, 'a1'),
      agentStart('a2'), { kind: 'turn.end', at: at(), turnId: 'ta2', agent: 'a2', answer: 'ok', failed: false },
      start('done', 'Bash', { command: 'ls' }), end('done', {}),
    ])
    const last = t.steps.find((s) => s.id === 'done')!.endedAt!
    const a2End = t.agents.a2!.endedAt
    const s = settle(t)
    expect(s.steps.find((x) => x.id === 's1')).toMatchObject({ status: 'interrupted', endedAt: last })
    expect(s.steps.find((x) => x.id === 's1')!.asking).toBeUndefined()
    expect(s.steps.find((x) => x.id === 'a1s1')!.status).toBe('interrupted')
    expect(s.steps.find((x) => x.id === 'done')!.status).toBe('done')
    expect(s.agents.a1).toMatchObject({ status: 'done', endedAt: last })
    expect(s.agents.a2).toMatchObject({ status: 'done', endedAt: a2End })
    expect(s.agents.main!.status).toBe('running')
  })

  it('a settled timeline holds nothing running but main', () => {
    const t = deepFreeze(fold([agentStart('a1'), start('s1', 'Bash', { command: 'x' }, 'a1')]))
    const s = settle(t)
    expect(s.steps.every((x) => x.status !== 'running')).toBe(true)
    expect(Object.values(s.agents).filter((a) => a.status === 'running').map((a) => a.id)).toEqual(['main'])
  })
})
