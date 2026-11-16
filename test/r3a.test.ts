import { describe, expect, it } from 'vitest'

import type { Ev, Timeline } from '../mod/types'
import { agentName } from '../mod/hooks/model/alerts'
import { MAX_TURNS } from '../mod/hooks/model/limits'
import { empty, reduce } from '../mod/hooks/model/reduce'
import { stepGroups, summary } from '../mod/hooks/model/select'
import { EFFORT_LATER_TEXT, effortCountedLater, todoBlock } from '../mod/hooks/model/todo'
import { headline, IDLE_HEADLINE } from '../mod/hooks/views/bandmodel'

// Fix round R3-A: sessions built by the real reducer from events, never by hand.

const fold = (evs: Ev[], from: Timeline = empty): Timeline => evs.reduce(reduce, from)

let clock = 1_000_000
const at = (): number => (clock += 1000)

const turnStart = (turnId: string, prompt: string, agent = 'main'): Ev => ({ kind: 'turn.start', at: at(), turnId, agent, prompt })
const turnEnd = (turnId: string, agent = 'main'): Ev => ({ kind: 'turn.end', at: at(), turnId, agent, answer: '', failed: false })
const start = (id: string, tool: string, input: Record<string, unknown> = {}, agent = 'main'): Ev => ({ kind: 'step.start', at: at(), id, agent, tool, input })
const end = (id: string, result?: unknown): Ev => ({ kind: 'step.end', at: at(), id, status: 'done', result })
const create = (stepId: string, taskId: string, subject: string, agent = 'main'): Ev[] => [start(stepId, 'TaskCreate', { subject }, agent), end(stepId, { task: { id: taskId } })]
const setStatus = (stepId: string, taskId: string, status: string): Ev[] => [start(stepId, 'TaskUpdate', { taskId, status }), end(stepId, {})]
const focus = (text: string): Ev => ({ kind: 'update', at: at(), agent: 'main', update: { focus: text } })
const clear = (): Ev => ({ kind: 'clear', at: at() })

/** A request that stops with 2 of 5 tasks done, one in progress, the headline set. */
function leftOpen(): Timeline {
  return fold([
    turnStart('t1', 'add rate limiting to the upload'),
    focus('Wiring the limiter into the middleware chain'),
    ...create('c1', '1', 'Read the upload route'),
    ...create('c2', '2', 'Write the limiter'),
    ...create('c3', '3', 'Wire the limiter into the chain'),
    ...create('c4', '4', 'Test it'),
    ...create('c5', '5', 'Document it'),
    ...setStatus('u1', '1', 'completed'),
    ...setStatus('u2', '2', 'completed'),
    ...setStatus('u3', '3', 'in_progress'),
    turnEnd('t1'),
  ])
}

describe('C1: /clear folds the cleared conversation away', () => {
  it('after /clear and a new prompt, Now has no headline, no current task and no list from the cleared conversation', () => {
    const base = leftOpen()
    const t = fold([clear(), turnStart('t2', 'why is the build slow on CI?')], base)
    expect(t.now).toBeUndefined()
    const todo = todoBlock(t)
    expect(todo.empty).toBe(true)
    expect(todo.current).toBeUndefined()
    // The cleared list is kept, folded away as "Earlier", whatever its states.
    expect(todo.earlier.map(x => x.subject)).toEqual(['Read the upload route', 'Write the limiter', 'Wire the limiter into the chain', 'Test it', 'Document it'])
    expect(headline(t)).toEqual({ text: IDLE_HEADLINE, isIdle: true })
    expect(summary(t).current).toBeUndefined()
    expect(summary(t).total).toBe(0)
    // Steps stay for the Steps tab.
    expect(t.steps.length).toBe(base.steps.length)
  })

  it('task ids restarting at 1 after /clear are new tasks: none inherits the old task\'s state, and the count is the new list\'s', () => {
    const base = leftOpen()
    const t = fold([
      clear(),
      turnStart('t2', 'why is the build slow on CI?'),
      ...create('n1', '1', 'Cache the node_modules layer'),
      ...create('n2', '2', 'Profile the CI build'),
      ...setStatus('n3', '2', 'in_progress'),
    ], base)
    const todo = todoBlock(t)
    expect(todo.items.map(x => [x.subject, x.status])).toEqual([
      ['Cache the node_modules layer', 'pending'],
      ['Profile the CI build', 'in_progress'],
    ])
    expect([todo.done, todo.total]).toEqual([0, 2])
    expect(todo.current?.subject).toBe('Profile the CI build')
    // The old tasks 1 and 2 are untouched and still folded away.
    const old = t.tasks.filter(x => x.subject === 'Read the upload route' || x.subject === 'Write the limiter')
    expect(old.map(x => x.status)).toEqual(['completed', 'completed'])
    expect(todo.earlier).toHaveLength(5)
  })

  it('/clear settles what was running, ends open turns and drops the failure and the asks', () => {
    const t0 = fold([
      turnStart('t1', 'go'),
      { kind: 'agent.start', at: at(), id: 'a1', parent: 'main', type: 'Explore', description: 'look' },
      turnStart('r1', 'look', 'a1'),
      start('s1', 'Bash', { command: 'npm test' }, 'a1'),
      { kind: 'turn.fail', agent: 'main', reason: 'Rate limited' },
    ])
    const t = fold([clear()], t0)
    expect(t.turns.every(x => x.endedAt !== undefined)).toBe(true)
    expect(t.steps.find(s => s.id === 's1')?.status).toBe('interrupted')
    expect(t.agents.a1?.status).toBe('done')
    expect(t.failure).toBeUndefined()
    expect(t.clearedAt).toBeDefined()
  })

  it('the update tool\'s `tasks` list works again after /clear in a conversation that used the task tools', () => {
    const base = leftOpen()
    const t = fold([
      clear(),
      turnStart('t2', 'next'),
      { kind: 'update', at: at(), agent: 'main', update: { tasks: [{ title: 'Look at CI', state: 'doing' }] } },
    ], base)
    expect(todoBlock(t).items.map(x => x.subject)).toEqual(['Look at CI'])
  })
})

describe('C2: Steps files subagent runs under the request they serve', () => {
  /** The lead's turn, an Explorer and a General run, and the lead's Edit still running: all by the real reducer. */
  function withCrew(): Timeline {
    return fold([
      turnStart('t0', 'an earlier request'),
      start('o1', 'Read', { file_path: 'a.ts' }),
      end('o1'),
      turnEnd('t0'),
      turnStart('t1', 'add rate limiting to the upload'),
      start('m1', 'Read', { file_path: 'src/upload.ts' }),
      end('m1'),
      { kind: 'agent.start', at: at(), id: 'e1', parent: 'main', type: 'Explore', description: 'find callers' },
      turnStart('re1', 'Find every caller of upload()', 'e1'),
      start('e-1', 'Grep', { pattern: 'upload(' }, 'e1'),
      end('e-1'),
      turnEnd('re1', 'e1'),
      { kind: 'agent.start', at: at(), id: 'g1', parent: 'main', type: 'general-purpose', description: 'write tests' },
      turnStart('rg1', 'Write tests for the rate limiter', 'g1'),
      start('g-1', 'Edit', { file_path: 'test/rateLimit.test.ts' }, 'g1'),
      end('g-1'),
      start('g-2', 'Bash', { command: 'npm test upload' }, 'g1'),
      start('m2', 'Edit', { file_path: 'middleware/index.ts' }),
    ])
  }

  it('a subagent run records the main turn it serves', () => {
    const t = withCrew()
    expect(t.turns.find(x => x.id === 're1')?.lead).toBe('t1')
    expect(t.turns.find(x => x.id === 'rg1')?.lead).toBe('t1')
    // The steps keep their own run's turn (the Watch loop rule keys on it).
    expect(t.steps.find(s => s.id === 'g-2')?.turnId).toBe('rg1')
  })

  it('with subagents running, the newest group is the lead\'s running turn holding main, Explorer and General steps; the earlier request is the only earlier group', () => {
    const groups = stepGroups(withCrew(), { kind: 'all' })
    expect(groups.map(g => g.turn?.id)).toEqual(['t1', 't0'])
    expect(groups[0]!.steps.map(s => s.id)).toEqual(['m2', 'g-2', 'g-1', 'e-1', 'm1'])
  })

  it('a timeline an earlier version stored (no `lead`) is filed by time', () => {
    const t = withCrew()
    const old: Timeline = { ...t, turns: t.turns.map(({ lead: _l, ...x }) => x) }
    expect(stepGroups(old, { kind: 'all' }).map(g => g.turn?.id)).toEqual(['t1', 't0'])
  })

  it('a subagent run no main turn was open for stays a group of its own', () => {
    const t = fold([
      { kind: 'agent.start', at: at(), id: 'b1', parent: 'main', type: 'Explore', description: 'x' },
      turnStart('rb', 'background', 'b1'),
      start('b-1', 'Read', { file_path: 'x.ts' }, 'b1'),
    ])
    expect(stepGroups(t, { kind: 'all' }).map(g => g.turn?.id)).toEqual(['rb'])
  })
})

describe('M3: an open turn is never dropped', () => {
  it('after more than MAX_TURNS subagent runs in one request, the lead\'s running turn is still held', () => {
    const evs: Ev[] = [turnStart('lead', 'a long request')]
    for (let i = 0; i < MAX_TURNS + 20; i++) evs.push(turnStart(`r${i}`, 'run', `a${i}`), turnEnd(`r${i}`, `a${i}`))
    const t = fold(evs)
    expect(t.turns.length).toBe(MAX_TURNS)
    expect(t.turns.some(x => x.id === 'lead' && x.endedAt === undefined)).toBe(true)
  })
})

describe('I3: the headline belongs to the current request', () => {
  it('a reply with no tools after a finished request never shows the last request\'s focus', () => {
    const t = fold([
      turnStart('t1', 'add rate limiting'),
      focus('Rate limiting is wired in and tested'),
      turnEnd('t1'),
      turnStart('t2', 'what does HTTP 429 mean?'),
    ])
    expect(headline(t).text).not.toBe('Rate limiting is wired in and tested')
    expect(headline(t)).toEqual({ text: IDLE_HEADLINE, isIdle: true })
  })

  it('between requests the last request\'s goal stands, marked past for the views to dim', () => {
    const t = fold([turnStart('t1', 'add rate limiting'), focus('Adding rate limiting'), turnEnd('t1')])
    expect(headline(t)).toMatchObject({ text: 'Adding rate limiting', isIdle: false, isPast: true })
  })

  it('with no focus the headline is the current task, never a step label', () => {
    const t = fold([
      turnStart('t1', 'go'),
      ...create('c1', '1', 'Wire the limiter'),
      ...setStatus('u1', '1', 'in_progress'),
      start('s1', 'Edit', { file_path: 'src/server/middleware/rateLimit.test.ts' }),
    ])
    expect(headline(t)).toEqual({ text: 'Wire the limiter', isIdle: false })
  })

  it('with no focus and no task the headline is the idle words, not the running step', () => {
    const t = fold([turnStart('t1', 'go'), start('s1', 'Edit', { file_path: 'src/rateLimit.test.ts' })])
    expect(headline(t)).toEqual({ text: IDLE_HEADLINE, isIdle: true })
  })
})

describe('M6: names drop a plugin\'s prefix', () => {
  it('superpowers:code-reviewer is "Code reviewer"', () => {
    const t = fold([{ kind: 'agent.start', at: at(), id: 'r1', parent: 'main', type: 'superpowers:code-reviewer', description: 'review' }])
    expect(agentName(t, 'r1')).toBe('Code reviewer')
  })
})

describe('M14: effort is counted when the turn ends', () => {
  it('while the lead\'s turn runs with a task in progress the model says its tokens come later; once it ends, not', () => {
    const running = fold([turnStart('t1', 'go'), ...create('c1', '1', 'Wire it'), ...setStatus('u1', '1', 'in_progress')])
    expect(effortCountedLater(running)).toBe(true)
    expect(EFFORT_LATER_TEXT).toBe('counted when the turn ends')
    expect(effortCountedLater(fold([turnEnd('t1')], running))).toBe(false)
  })
})
