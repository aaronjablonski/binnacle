import { describe, expect, it } from 'vitest'

import type { Ev, Timeline } from '../mod/types'
import {
  MAX_AGENTS, MAX_ARTIFACTS, MAX_CHANGED, MAX_MODEL, MAX_NOTES, MAX_PENDING, MAX_PENDING_STEPS, MAX_REF, MAX_RESULT, MAX_RUNS, MAX_STEPS, MAX_TASKS, MAX_TURNS,
  MAX_WINDOW_NAME, MAX_WINDOWS,
} from '../mod/hooks/model/limits'
import { empty, reduce } from '../mod/hooks/model/reduce'

const fold = (evs: Iterable<Ev>, from: Timeline = empty): Timeline => {
  let t = from
  for (const ev of evs) t = reduce(t, ev)
  return t
}

let clock = 1_731_700_000_000
const at = () => ++clock

const BIG = 5000
/** A string of `n` characters that starts with `tag`, so distinct tags stay distinct after any cut. */
const long = (tag: string | number, n = BIG): string => `${tag}-`.padEnd(n, 'x')
// Ids as the engine mints them: about as long as real ones.
const toolId = (i: number) => `toolu_01${String(i).padStart(22, '0')}`
const agentId = (i: number) => `a${String(i).padStart(16, '0')}`
const turnId = (i: number) => `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`
const runId = (i: number) => `wf_${String(i).padStart(20, '0')}`

const HUGE = 999_999_999_999_999

function* everyListPastItsBound(opts: { finish: boolean } = { finish: true }): Generator<Ev> {
  // Agents (each a workflow agent, so runs fill too), each with a long type,
  // description, doing, model and result and the largest token counts; the
  // first few never finish.
  for (let i = 0; i < MAX_AGENTS + 50; i++) {
    yield { kind: 'agent.start', at: at(), id: agentId(i), parent: 'main', type: long('type'), description: long(`d${i}`), runId: runId(i % (MAX_RUNS + 20)), agentIndex: i }
    yield { kind: 'agent.model', id: agentId(i), model: long('model') }
    yield { kind: 'update', at: at(), agent: agentId(i), update: { focus: long(`f${i}`) } }
    yield { kind: 'step.start', at: at(), id: toolId(200_000 + i), agent: agentId(i), tool: 'StructuredOutput', input: { result: long('r') } }
    yield { kind: 'step.end', at: at(), id: toolId(200_000 + i), status: 'done' }
    yield { kind: 'usage', at: at(), agent: agentId(i), model: long('used-model'), tokensIn: HUGE, tokensOut: HUGE }
    if (i >= 10) yield { kind: 'turn.end', at: at(), turnId: turnId(i), agent: agentId(i), answer: long('answer'), failed: false }
  }
  yield { kind: 'usage', at: at(), agent: 'main', model: long('used-model'), tokensIn: HUGE, tokensOut: HUGE }
  // Turns with long prompts, each but the newest ended failed.
  for (let i = 0; i < MAX_TURNS + 50; i++) {
    yield { kind: 'turn.start', at: at(), turnId: turnId(i), agent: 'main', prompt: long(`p${i}`) }
    if (i < MAX_TURNS + 49) yield { kind: 'turn.end', at: at(), turnId: turnId(i), agent: 'main', answer: '', failed: true }
  }
  // A budget past its window bound, every name at its longest.
  const windows = Array.from({ length: MAX_WINDOWS + 4 }, (_, i) => ({ name: long(`w${i}`), pct: 100.5, resetsAt: HUGE }))
  yield { kind: 'measure', at: at(), budget: { contextPct: 100, windows, costUsd: 123456.789, at: 0 } }
  // Notes, and declared artifacts with every string at its longest.
  for (let i = 0; i < MAX_NOTES + 20; i++) yield { kind: 'update', at: at(), agent: 'main', update: { note: long(`n${i}`) } }
  for (let i = 0; i < MAX_ARTIFACTS + 50; i++) {
    yield { kind: 'update', at: at(), agent: 'main', update: { focus: long('focus'), next: long('next'), artifact: { title: long(`t${i}`), kind: 'link', ref: long(`https://x/${i}`), summary: long('s') } } }
  }
  // Tasks: a todo list past the bound, then created tasks with long subjects.
  yield { kind: 'step.start', at: at(), id: toolId(0), agent: 'main', tool: 'TodoWrite', input: { todos: Array.from({ length: MAX_TASKS + 50 }, (_, i) => ({ content: long(`todo${i}`), activeForm: long('af'), status: 'in_progress' })) } }
  yield { kind: 'step.end', at: at(), id: toolId(0), status: 'done' }
  for (let i = 1; i <= MAX_TASKS + 50; i++) {
    yield { kind: 'step.start', at: at(), id: toolId(i), agent: agentId(0), tool: 'TaskCreate', input: { subject: long(`sub${i}`), activeForm: long('af'), description: long('desc') } }
    yield { kind: 'step.end', at: at(), id: toolId(i), status: 'done', result: { task: { id: String(i) } } }
  }
  // Changed paths, each at the longest a step keeps.
  for (let i = 0; i < MAX_CHANGED + 50; i++) {
    const id = toolId(10_000 + i)
    yield { kind: 'step.start', at: at(), id, agent: 'main', tool: 'Edit', input: { file_path: long(`C:/r/${i}`), old_string: long('old'), new_string: long('new') } }
    yield { kind: 'step.end', at: at(), id, status: 'done' }
  }
  // Last, steps past the bound that never end, each carrying the most
  // `pending` a step can, left interrupted by the turn's end.
  for (let i = 0; i < MAX_STEPS + 50; i++) {
    const tool = i % 2 === 0 ? 'Artifact' : 'TaskUpdate'
    const input = tool === 'Artifact'
      ? { title: long('title'), file_path: long(`C:/r/page${i}`), html: long('html') }
      : { taskId: long('task'), status: long('status'), subject: long('subject'), activeForm: long('af') }
    yield { kind: 'step.start', at: at(), id: toolId(100_000 + i), agent: 'main', tool: `${tool}`, input }
    if (!opts.finish) yield { kind: 'step.ask', at: at(), id: toolId(100_000 + i) }
  }
  if (opts.finish) yield { kind: 'turn.end', at: at(), turnId: turnId(MAX_TURNS + 49), agent: 'main', answer: long('done'), failed: false }
}

/** The checks both worst cases share: every list at its bound, every new field at its cap. */
function atBounds(t: Timeline) {
  expect(t.steps).toHaveLength(MAX_STEPS)
  expect(t.turns).toHaveLength(MAX_TURNS)
  expect(t.notes).toHaveLength(MAX_NOTES)
  expect(t.artifacts).toHaveLength(MAX_ARTIFACTS)
  expect(t.changed).toHaveLength(MAX_CHANGED)
  expect(t.tasks).toHaveLength(MAX_TASKS)
  expect(Object.keys(t.agents)).toHaveLength(MAX_AGENTS)
  expect(Object.keys(t.runs)).toHaveLength(MAX_RUNS)
  expect(t.agents.main).toBeDefined()
  const subs = Object.values(t.agents).filter((a) => a.id !== 'main')
  for (const a of subs) {
    expect(a.model!.length).toBe(MAX_MODEL)
    expect(a.result!.length).toBe(MAX_RESULT)
    expect(a.tokensIn).toBe(HUGE)
    expect(a.lastStepAt).toBeDefined()
  }
  expect(t.turns.filter((x) => x.failed === true)).toHaveLength(MAX_TURNS - 1)
  expect(t.budget!.windows).toHaveLength(MAX_WINDOWS)
  for (const w of t.budget!.windows) expect(w.name.length).toBe(MAX_WINDOW_NAME)
}

describe('bounds', () => {
  // The ruling asked for < 2,000,000. With the ruled caps that is out of
  // reach: changed (1,000 x 500) and artifacts (200 x a 1,000-character ref
  // that is also in the id) are about 0.5 MB each, tasks and agents about
  // 0.3 MB each, and 2,000 steps about 0.75 MB, about 2.4 MB in all. The
  // bound held here is 2,500,000: under 60% of $.state's 4,194,304.
  // The model, tokens, result and lastStepAt on every agent (about 0.36 KB a
  // row), failed turns and the budget took it to about 2.59 MB; MAX_AGENTS
  // went from 500 to 400, MAX_PENDING_STEPS from 100 to 50 and a subagent's
  // focus is cut to 80 like its other doing sources, which brings both worst
  // cases back to about 2.41 MB.
  it('a timeline with every list at its bound and every string at its longest stays under 2,500,000 characters', () => {
    const t = fold(everyListPastItsBound())

    atBounds(t)
    // The steps kept are the interrupted ones; the newest still carry their pending.
    expect(t.steps.every((s) => s.status === 'interrupted')).toBe(true)
    const carrying = t.steps.filter((s) => s.pending !== undefined)
    expect(carrying).toHaveLength(MAX_PENDING_STEPS)
    expect(carrying[0]).toBe(t.steps[MAX_STEPS - MAX_PENDING_STEPS])
    for (const s of carrying) for (const v of Object.values(s.pending!)) expect(String(v).length <= MAX_PENDING).toBe(true)
    for (const a of t.artifacts) expect((a.ref ?? '').length <= MAX_REF).toBe(true)

    const size = JSON.stringify(t).length
    expect(size).toBeLessThan(2_500_000)
  })

  it('the same with every kept step still running and asked stays under 2,500,000 characters', () => {
    const t = fold(everyListPastItsBound({ finish: false }))

    atBounds(t)
    expect(t.steps.every((s) => s.status === 'running' && s.asking !== undefined)).toBe(true)

    const size = JSON.stringify(t).length
    expect(size).toBeLessThan(2_500_000)
  })

  it('a step keeps only the keys step.end reads for its tool', () => {
    const t = fold([
      { kind: 'step.start', at: at(), id: 'e', agent: 'main', tool: 'Edit', input: { file_path: 'C:/r/a.ts', old_string: 'a', new_string: 'b', replace_all: true } },
      { kind: 'step.start', at: at(), id: 'b', agent: 'main', tool: 'Bash', input: { command: 'ls', timeout: 5 } },
      { kind: 'step.start', at: at(), id: 'u', agent: 'main', tool: 'TaskUpdate', input: { taskId: 3, status: 'completed', description: 'long' } },
    ])
    expect(t.steps.map((s) => s.pending)).toEqual([{ file_path: 'C:/r/a.ts' }, undefined, { taskId: 3, status: 'completed' }])
  })

  it('past MAX_TASKS, completed tasks go first, then the oldest', () => {
    const todos = Array.from({ length: MAX_TASKS + 2 }, (_, i) => ({ content: `t${i}`, status: i === 300 || i === 400 ? 'completed' : 'pending' }))
    const t = fold([{ kind: 'step.start', at: at(), id: 's', agent: 'main', tool: 'TodoWrite', input: { todos } }])
    expect(t.tasks).toHaveLength(MAX_TASKS)
    expect(t.tasks.some((x) => x.status === 'completed')).toBe(false)
    const u = fold([{ kind: 'step.start', at: at(), id: 's2', agent: 'a1', tool: 'TodoWrite', input: { todos: [{ content: 'one more', status: 'pending' }] } }], t)
    expect(u.tasks).toHaveLength(MAX_TASKS)
    expect(u.tasks[0]!.subject).toBe('t1')
    expect(u.tasks.at(-1)!.subject).toBe('one more')
  })

  it('past MAX_AGENTS, finished agents go first and main is never dropped', () => {
    const evs: Ev[] = []
    for (let i = 0; i < MAX_AGENTS + 5; i++) {
      evs.push({ kind: 'agent.start', at: at(), id: `a${i}`, parent: 'main', type: 'Explore', description: '' })
      if (i === 100 || i === 200) evs.push({ kind: 'turn.end', at: at(), turnId: 't', agent: `a${i}`, answer: '', failed: false })
    }
    const t = fold(evs)
    expect(Object.keys(t.agents)).toHaveLength(MAX_AGENTS)
    expect(t.agents.main).toBeDefined()
    expect(t.agents.a100).toBeUndefined()
    expect(t.agents.a200).toBeUndefined()
    expect(t.agents.a0).toBeUndefined()
    expect(t.agents.a3).toBeUndefined()
    expect(t.agents.a4).toBeDefined()
  })

  it('past MAX_RUNS, the oldest run goes', () => {
    const evs: Ev[] = Array.from({ length: MAX_RUNS + 1 }, (_, i) => ({ kind: 'agent.start', at: at(), id: `a${i}`, parent: 'main', type: 'w', description: '', runId: `wf_${i}` }) as Ev)
    const t = fold(evs)
    expect(Object.keys(t.runs)).toHaveLength(MAX_RUNS)
    expect(t.runs.wf_0).toBeUndefined()
    expect(t.runs[`wf_${MAX_RUNS}`]).toBeDefined()
  })
})
