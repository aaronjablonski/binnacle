import { describe, expect, it } from 'vitest'

import type { AgentRow, Ev, Timeline } from '../mod/types'
import { MAX_SAMPLES } from '../mod/hooks/model/limits'
import { cacheLine, doneTurn, notifies, pace, roles, runLevel, taskMeter, thisTurn, turnShare, usualMs } from '../mod/hooks/model/meter'
import { empty, reduce } from '../mod/hooks/model/reduce'
import { problems } from '../mod/hooks/model/select'
import { usageOf } from '../mod/hooks/model/usage'

const fold = (evs: Ev[], from: Timeline = empty): Timeline => evs.reduce(reduce, from)
const MIN = 60_000
const T0 = 1_800_000_000_000

const measure = (at: number, windows: { name: string; pct: number; resetsAt?: number }[], contextPct?: number, costUsd?: number): Ev => {
  const budget: Extract<Ev, { kind: 'measure' }>['budget'] = { windows, at }
  if (contextPct !== undefined) budget.contextPct = contextPct
  if (costUsd !== undefined) budget.costUsd = costUsd
  return { kind: 'measure', at, budget }
}
const fiveHour = (at: number, pct: number, resetsAt?: number) =>
  measure(at, [resetsAt === undefined ? { name: 'five_hour', pct } : { name: 'five_hour', pct, resetsAt }])
const turnStart = (at: number, turnId: string, agent = 'main'): Ev => ({ kind: 'turn.start', at, turnId, agent, prompt: turnId })
const turnEnd = (at: number, turnId: string, opts: { agent?: string; failed?: boolean; aborted?: boolean } = {}): Ev => {
  const ev: Extract<Ev, { kind: 'turn.end' }> = { kind: 'turn.end', at, turnId, agent: opts.agent ?? 'main', answer: '', failed: opts.failed === true }
  if (opts.aborted !== undefined) ev.aborted = opts.aborted
  return ev
}
const usage = (at: number, agent: string, u: { in?: number; out?: number; read?: number; write?: number; ms?: number; turnId?: string; model?: string }): Ev => {
  const ev: Extract<Ev, { kind: 'usage' }> = { kind: 'usage', at, agent, tokensIn: (u.in ?? 0) + (u.read ?? 0) + (u.write ?? 0), tokensOut: u.out ?? 0 }
  if (u.read !== undefined) ev.cacheRead = u.read
  if (u.write !== undefined) ev.cacheWrite = u.write
  if (u.ms !== undefined) ev.ms = u.ms
  if (u.turnId !== undefined) ev.turnId = u.turnId
  if (u.model !== undefined) ev.model = u.model
  return ev
}
const agentStart = (at: number, id: string, type = 'Explore', parent = 'main'): Ev => ({ kind: 'agent.start', at, id, parent, type, description: `desc ${id}` })
const step = (at: number, id: string, tool: string, input: Record<string, unknown> = {}, agent = 'main'): Ev => ({ kind: 'step.start', at, id, agent, tool, input })
const stepEnd = (at: number, id: string, result: unknown = {}, status: 'done' | 'error' = 'done'): Ev => ({ kind: 'step.end', at, id, status, result })
const todo = (at: number, items: { content: string; status: string }[], agent = 'main'): Ev => step(at, `todo-${at}`, 'TodoWrite', { todos: items }, agent)

describe('usage', () => {
  it("usageOf keeps the cache read and write counts beside the input total", () => {
    const u = usageOf({ input_tokens: 4, output_tokens: 193, cache_read_input_tokens: 33638, cache_creation_input_tokens: 40757, model: 'm' })
    expect(u).toEqual({ model: 'm', tokensIn: 74399, tokensOut: 193, cacheRead: 33638, cacheWrite: 40757 })
  })

  it('sums cache read, cache write and duration on the agent', () => {
    const t = fold([
      usage(T0, 'a1', { in: 10, out: 5, read: 100, write: 50, ms: 2000 }),
      usage(T0 + 1, 'a1', { in: 1, out: 2, read: 300, write: 0, ms: 1000 }),
    ])
    const a = t.agents.a1!
    expect(a.tokensIn).toBe(461)
    expect(a.tokensOut).toBe(7)
    expect(a.cacheRead).toBe(400)
    expect(a.cacheWrite).toBe(50)
    expect(a.ms).toBe(3000)
  })
})

describe('pace', () => {
  it('shows nothing until a window has moved 2 points over 5 minutes', () => {
    // 1.9 points over 10 minutes: not yet.
    let t = fold([fiveHour(T0, 10), fiveHour(T0 + 5 * MIN, 11), fiveHour(T0 + 10 * MIN, 11.9)])
    expect(pace(t, T0 + 10 * MIN).windows).toEqual([])
    // 3 points, but over 4 minutes: not yet.
    t = fold([fiveHour(T0, 10), fiveHour(T0 + 2 * MIN, 11), fiveHour(T0 + 4 * MIN, 13)])
    expect(pace(t, T0 + 4 * MIN).windows).toEqual([])
    // 2 points over 5 minutes: shown.
    t = fold([fiveHour(T0, 10), fiveHour(T0 + 5 * MIN, 12)])
    const p = pace(t, T0 + 5 * MIN)
    expect(p.windows).toHaveLength(1)
    expect(p.windows[0]!.name).toBe('five_hour')
    expect(p.windows[0]!.pct).toBe(12)
    expect(p.windows[0]!.per10).toBeCloseTo(4)
    // 88 points left at 4 per 10 minutes: 220 minutes.
    expect(p.windows[0]!.fullIn).toBe(220 * MIN)
  })

  it('reads only the last 30 minutes', () => {
    // A burst 40 minutes ago, flat since: no pace.
    const t = fold([fiveHour(T0, 10), fiveHour(T0 + 2 * MIN, 20), fiveHour(T0 + 10 * MIN, 20), fiveHour(T0 + 40 * MIN, 20.5)])
    expect(pace(t, T0 + 40 * MIN).windows).toEqual([])
  })

  it('says how much sooner than its reset a window fills', () => {
    const resets = T0 + 10 * MIN + 300 * MIN
    const t = fold([fiveHour(T0, 50, resets), fiveHour(T0 + 10 * MIN, 60, resets)])
    const w = pace(t, T0 + 10 * MIN).windows[0]!
    // 40 points left at 10 per 10 minutes: full in 40 minutes, 260 before the reset.
    expect(w.fullIn).toBe(40 * MIN)
    expect(w.beforeReset).toBe(true)
    expect(w.shortBy).toBe(260 * MIN)
  })

  it('starts again after a window resets (its pct drops)', () => {
    const t = fold([fiveHour(T0, 80), fiveHour(T0 + 5 * MIN, 95), fiveHour(T0 + 6 * MIN, 1), fiveHour(T0 + 8 * MIN, 4)])
    expect(pace(t, T0 + 8 * MIN).windows).toEqual([])
  })

  it('gives the context the same row, and output tokens per minute', () => {
    let t = fold([measure(T0, [], 10), measure(T0 + 10 * MIN, [], 30)])
    t = fold([usage(T0, 'main', { out: 3000, ms: 2 * MIN }), usage(T0, 'a1', { out: 1000, ms: 2 * MIN })], t)
    const p = pace(t, T0 + 10 * MIN)
    expect(p.context?.per10).toBeCloseTo(20)
    expect(p.context?.fullIn).toBe(35 * MIN)
    expect(p.outPerMin).toBe(1000)
  })

  it('keeps at most 30 samples, consecutive ones at least a minute apart', () => {
    const evs: Ev[] = []
    for (let i = 0; i < 100; i++) evs.push(fiveHour(T0 + i * 20_000, i / 10))
    const t = fold(evs)
    const list = t.samples!.list
    expect(list.length).toBeLessThanOrEqual(MAX_SAMPLES)
    for (let i = 1; i < list.length - 1; i++) expect(list[i]!.at - list[i - 1]!.at).toBeGreaterThanOrEqual(MIN)
    expect(list.at(-1)!.at).toBe(T0 + 99 * 20_000)
    expect(t.samples!.names).toEqual(['five_hour'])
  })

  it('gives a 10-point trend over the range it read', () => {
    const t = fold([fiveHour(T0, 10), fiveHour(T0 + 5 * MIN, 12), fiveHour(T0 + 10 * MIN, 14)])
    const w = pace(t, T0 + 10 * MIN).windows[0]!
    expect(w.trend).toHaveLength(10)
    expect(w.trend[0]).toBe(10)
    expect(w.trend[9]).toBe(14)
  })
})

describe('cacheLine', () => {
  it('shares of read, written and fresh input over the agents that report them', () => {
    const t = fold([
      usage(T0, 'main', { in: 100, read: 700, write: 200 }),
      usage(T0, 'a1', { in: 0, read: 0, write: 1000 }),
    ])
    const c = cacheLine(t)
    expect(c.read).toBe(700)
    expect(c.write).toBe(1200)
    expect(c.fresh).toBe(100)
    expect(c.readShare).toBeCloseTo(0.35)
    expect(c.byAgent.find((r) => r.id === 'a1')?.readShare).toBe(0)
  })

  it('assumes 5 minutes warm from the last main-loop reply', () => {
    const t = fold([turnStart(T0, 't1'), turnEnd(T0 + MIN, 't1'), usage(T0 + MIN, 'main', { in: 10, read: 0, write: 500, turnId: 't1' })])
    const c = cacheLine(t)
    expect(c.ttlMs).toBe(5 * MIN)
    expect(c.warmUntil).toBe(T0 + MIN + 5 * MIN)
  })

  it('switches to 1 hour for the session when a turn after a longer gap still reads from cache', () => {
    const t = fold([
      turnStart(T0, 't1'), turnEnd(T0 + MIN, 't1'), usage(T0 + MIN, 'main', { in: 10, write: 50_000, turnId: 't1' }),
      // 20 minutes later, a one-request turn reads the prefix from the cache.
      turnStart(T0 + 21 * MIN, 't2'), turnEnd(T0 + 22 * MIN, 't2'), usage(T0 + 22 * MIN, 'main', { in: 10, read: 50_000, write: 100, turnId: 't2' }),
    ])
    const c = cacheLine(t)
    expect(c.ttlMs).toBe(60 * MIN)
    expect(c.warmUntil).toBe(T0 + 22 * MIN + 60 * MIN)
  })

  it('stays at 5 minutes when the turn after the gap wrote the prefix again', () => {
    const t = fold([
      turnStart(T0, 't1'), turnEnd(T0 + MIN, 't1'), usage(T0 + MIN, 'main', { in: 10, write: 50_000, turnId: 't1' }),
      turnStart(T0 + 21 * MIN, 't2'),
      step(T0 + 21 * MIN + 1, 's1', 'Bash', { command: 'ls' }), stepEnd(T0 + 21 * MIN + 2, 's1'),
      turnEnd(T0 + 22 * MIN, 't2'),
      // Cold: the first request wrote the prefix, the second read it back.
      usage(T0 + 22 * MIN, 'main', { in: 10, read: 50_000, write: 50_200, turnId: 't2' }),
    ])
    expect(cacheLine(t).ttlMs).toBe(5 * MIN)
  })

  it("keeps the context's token count as what going cold re-sends", () => {
    const ev = measure(T0, [], 9)
    ;(ev as Extract<Ev, { kind: 'measure' }>).budget.contextTokens = 92_000
    expect(cacheLine(fold([ev])).resend).toBe(92_000)
  })
})

describe('taskMeter', () => {
  it("gives agents' tokens to the task they spawned under and main's turns to the task in progress at its end", () => {
    const t = fold([
      todo(T0, [{ content: 'one', status: 'in_progress' }, { content: 'two', status: 'pending' }]),
      agentStart(T0 + 1, 'a1'),
      usage(T0 + 2, 'a1', { in: 1000, out: 500, ms: 30_000 }),
      turnEnd(T0 + MIN, 'm1'),
      usage(T0 + MIN, 'main', { in: 200, out: 100, ms: MIN }),
      todo(T0 + 2 * MIN, [{ content: 'one', status: 'completed' }, { content: 'two', status: 'in_progress' }]),
      usage(T0 + 3 * MIN, 'main', { in: 10, out: 10, ms: 20_000 }),
    ])
    const m = taskMeter(t)
    const one = m.rows.find((r) => r.task.subject === 'one')!
    const two = m.rows.find((r) => r.task.subject === 'two')!
    expect(one.tokens).toBe(1800)
    expect(one.ms).toBe(MIN)
    expect(one.agents).toBe(1)
    expect(two.tokens).toBe(20)
    expect(two.ms).toBe(20_000)
    expect(m.heaviest).toBe(`main:${one.task.id}`)
  })

  it('a turn that closed the task it worked on goes to that task', () => {
    const t = fold([
      todo(T0, [{ content: 'one', status: 'in_progress' }]),
      todo(T0 + 30_000, [{ content: 'one', status: 'completed' }]),
      usage(T0 + MIN, 'main', { in: 50, out: 50, ms: MIN }),
    ])
    expect(taskMeter(t).rows[0]!.tokens).toBe(100)
  })

  it('keys tasks by owner and id: main and a subagent that both hold task 1 keep their own tokens', () => {
    const agent = (id: string, parent: string, tokens: number): AgentRow => ({
      id, parent, type: 'Explore', description: id, status: 'done', startedAt: T0, doing: '', stepCount: 1, taskId: '1', tokensIn: tokens, tokensOut: 0,
    })
    const t: Timeline = {
      ...empty,
      tasks: [
        { id: '1', subject: 'main one', status: 'in_progress', owner: 'main', updatedAt: T0 },
        { id: '1', subject: 'sub one', status: 'in_progress', owner: 'a1', updatedAt: T0 },
      ],
      // a1 spawned under main's task 1; b1 under a1's own task 1.
      agents: { main: empty.agents.main!, a1: agent('a1', 'main', 100), b1: agent('b1', 'a1', 7000) },
    }
    const m = taskMeter(t)
    const mainOne = m.rows.find((r) => r.task.owner === 'main')!
    const subOne = m.rows.find((r) => r.task.owner === 'a1')!
    expect([mainOne.tokens, mainOne.agents]).toEqual([100, 1])
    expect([subOne.tokens, subOne.agents]).toEqual([7000, 1])
    expect(m.heaviest).toBe('a1:1')
  })

  it('counts the live agents of the active task', () => {
    const t = fold([
      todo(T0, [{ content: 'one', status: 'in_progress' }]),
      agentStart(T0 + 1, 'a1'), agentStart(T0 + 2, 'a2'),
      usage(T0 + 3, 'a1', { in: 100, out: 0 }),
      turnEnd(T0 + 4, 'x', { agent: 'a1' }),
      usage(T0 + 5, 'a2', { in: 60, out: 0 }),
    ])
    const r = taskMeter(t).rows[0]!
    expect(r.running).toBe(1)
    expect(r.runningTokens).toBe(60)
  })
})

describe('long run', () => {
  const working = (startAt: number, lastStep: number): Ev[] => [
    agentStart(startAt, 'a1', 'Explore'),
    step(lastStep, 's1', 'Bash', { command: 'npm test' }, 'a1'),
  ]

  it('flags a busy agent past its limit once, with the limit and the usual time', () => {
    const t = fold([
      agentStart(T0, 'old1', 'Explore'), turnEnd(T0 + 10 * MIN, 'o1', { agent: 'old1' }),
      agentStart(T0, 'old2', 'Explore'), turnEnd(T0 + 14 * MIN, 'o2', { agent: 'old2' }),
      agentStart(T0, 'old3', 'Explore'), turnEnd(T0 + 30 * MIN, 'o3', { agent: 'old3' }),
      ...working(T0 + 100 * MIN, T0 + 123 * MIN),
    ])
    const now = T0 + 124 * MIN
    const got = problems(t, now, [], { agentLimitMin: 20 }).filter((p) => p.kind === 'long-run')
    expect(got).toHaveLength(1)
    expect(got[0]!.key).toBe('long-run:a1')
    expect(got[0]!.limitMs).toBe(20 * MIN)
    expect(got[0]!.usualMs).toBe(14 * MIN)
    // Dismissed, it does not come back as time goes on.
    const later = problems(t, now + 30 * MIN, ['long-run:a1'], { agentLimitMin: 20 })
    expect(later.some((p) => p.kind === 'long-run')).toBe(false)
  })

  it('is off at 0, and quiet under the limit', () => {
    const t = fold(working(T0, T0 + 24 * MIN))
    expect(problems(t, T0 + 25 * MIN, [], { agentLimitMin: 0 }).some((p) => p.kind === 'long-run')).toBe(false)
    expect(problems(t, T0 + 19 * MIN, [], { agentLimitMin: 20 }).some((p) => p.kind === 'long-run')).toBe(false)
  })

  it('defaults to 20 minutes for an agent', () => {
    const t = fold(working(T0, T0 + 20 * MIN))
    expect(problems(t, T0 + 21 * MIN, []).some((p) => p.kind === 'long-run')).toBe(true)
  })

  it('leaves a silent agent to stalled', () => {
    const t = fold(working(T0, T0 + MIN))
    const got = problems(t, T0 + 25 * MIN, [])
    expect(got.some((p) => p.kind === 'stalled')).toBe(true)
    expect(got.some((p) => p.kind === 'long-run')).toBe(false)
  })

  it('flags a main turn past its own limit (60 minutes by default), 0 off', () => {
    const t = fold([turnStart(T0, 'm1')])
    expect(problems(t, T0 + 59 * MIN, []).some((p) => p.kind === 'long-run')).toBe(false)
    const got = problems(t, T0 + 61 * MIN, []).filter((p) => p.kind === 'long-run')
    expect(got.map((p) => [p.key, p.agent])).toEqual([['long-run:turn:m1', 'main']])
    expect(problems(t, T0 + 61 * MIN, [], { turnLimitMin: 0 }).some((p) => p.kind === 'long-run')).toBe(false)
  })

  it('runLevel: near at 80 % of the limit (no row), over past it, ok at 0', () => {
    expect(runLevel(15 * MIN, 20)).toBe('ok')
    expect(runLevel(16 * MIN, 20)).toBe('near')
    expect(runLevel(21 * MIN, 20)).toBe('over')
    expect(runLevel(500 * MIN, 0)).toBe('ok')
    const t = fold(working(T0, T0 + 16 * MIN))
    expect(problems(t, T0 + 17 * MIN, []).some((p) => p.kind === 'long-run')).toBe(false)
  })
})

describe('roles', () => {
  it('counts, tokens and median time per subagent type', () => {
    const t = fold([
      agentStart(T0, 'a1', 'Explore'), usage(T0, 'a1', { in: 100, out: 10 }), turnEnd(T0 + 2 * MIN, 'x1', { agent: 'a1' }),
      agentStart(T0, 'a2', 'Explore'), usage(T0, 'a2', { in: 50, out: 0 }), turnEnd(T0 + 4 * MIN, 'x2', { agent: 'a2' }),
      agentStart(T0, 'a3', 'Explore'),
      agentStart(T0, 'b1', 'Plan'), turnEnd(T0 + 9 * MIN, 'x3', { agent: 'b1' }),
    ])
    const r = roles(t)
    expect(r.map((x) => x.type)).toEqual(['Explore', 'Plan'])
    expect(r[0]).toEqual({ type: 'Explore', count: 3, running: 1, tokens: 160, medianMs: 3 * MIN })
    expect(r[1]!.medianMs).toBe(9 * MIN)
    expect(usualMs(t, 'Plan')).toBe(9 * MIN)
    expect(usualMs(t, 'nobody')).toBeUndefined()
  })
})

describe('done turns', () => {
  it('a main turn over 60 s that ended normally is done', () => {
    const t = fold([turnStart(T0, 'm1'), turnEnd(T0 + 61_000, 'm1', { aborted: false })])
    expect(doneTurn(t)).toEqual({ turn: t.turns[0], ms: 61_000 })
  })

  it('is quiet under 60 s', () => {
    const t = fold([turnStart(T0, 'm1'), turnEnd(T0 + 59_000, 'm1')])
    expect(doneTurn(t)).toBeUndefined()
  })

  it('is quiet on an interrupted turn and on a failed one', () => {
    let t = fold([turnStart(T0, 'm1'), turnEnd(T0 + 5 * MIN, 'm1', { aborted: true })])
    expect(t.turns[0]!.aborted).toBe(true)
    expect(doneTurn(t)).toBeUndefined()
    t = fold([turnStart(T0, 'm1'), turnEnd(T0 + 5 * MIN, 'm1', { failed: true })])
    expect(doneTurn(t)).toBeUndefined()
  })

  it('is quiet while the turn runs and for a subagent', () => {
    expect(doneTurn(fold([turnStart(T0, 'm1')]))).toBeUndefined()
    const t = fold([turnStart(T0, 'x', 'a1'), turnEnd(T0 + 5 * MIN, 'x', { agent: 'a1' })])
    expect(doneTurn(t)).toBeUndefined()
  })

  it('notify: done adds finished turns to waits; all adds failures too', () => {
    expect(notifies('off', 'wait')).toBe(false)
    expect(notifies('waits', 'wait')).toBe(true)
    expect(notifies('waits', 'done')).toBe(false)
    expect(notifies('done', 'done')).toBe(true)
    expect(notifies('done', 'failed')).toBe(false)
    expect(notifies('all', 'done')).toBe(true)
    expect(notifies('all', 'failed')).toBe(true)
    expect(notifies(undefined, 'wait')).toBe(true)
  })

  it('thisTurn: tasks closed, agents finished and files changed in the newest main turn', () => {
    const t = fold([
      todo(T0 - 10, [{ content: 'old', status: 'completed' }, { content: 'one', status: 'in_progress' }]),
      turnStart(T0, 'm1'),
      todo(T0 + 1, [{ content: 'old', status: 'completed' }, { content: 'one', status: 'completed' }]),
      agentStart(T0 + 2, 'a1'), turnEnd(T0 + 3, 'x', { agent: 'a1' }),
      step(T0 + 4, 'e1', 'Edit', { file_path: 'C:/r/a.ts' }), stepEnd(T0 + 5, 'e1'),
      step(T0 + 6, 'e2', 'Write', { file_path: 'C:/r/a.ts' }), stepEnd(T0 + 7, 'e2'),
      step(T0 + 8, 'e3', 'Edit', { file_path: 'C:/r/b.ts' }), stepEnd(T0 + 9, 'e3'),
      step(T0 + 10, 'e4', 'Edit', { file_path: 'C:/r/c.ts' }), stepEnd(T0 + 11, 'e4', {}, 'error'),
      turnEnd(T0 + 2 * MIN, 'm1'),
    ])
    const got = thisTurn(t)!
    expect(got.turn.id).toBe('m1')
    expect(got.ms).toBe(2 * MIN)
    expect(got.tasksClosed.map((x) => x.subject)).toEqual(['one'])
    expect(got.agentsFinished.map((a) => a.id)).toEqual(['a1'])
    expect(got.files).toBe(2)
    expect(got.errors).toBe(1)
  })
})

describe('session cost', () => {
  it("a turn's share is the cost at its end less the cost at its start", () => {
    const t = fold([
      measure(T0, [], undefined, 1.25),
      turnStart(T0 + 1, 'm1'),
      measure(T0 + 2, [], undefined, 1.5),
      measure(T0 + 3, [], undefined, 1.75),
      turnEnd(T0 + 4, 'm1'),
      measure(T0 + 5, [], undefined, 2),
    ])
    expect(t.turnCost).toEqual({ turnId: 'm1', from: 1.25, to: 1.75 })
    expect(turnShare(t)).toBeCloseTo(0.5)
  })

  it('no share without a cost', () => {
    expect(turnShare(fold([turnStart(T0, 'm1'), turnEnd(T0 + 1, 'm1')]))).toBeUndefined()
  })
})

describe('lastExport', () => {
  it('records when and where /mc export wrote', () => {
    const t = fold([{ kind: 'export', at: T0, path: 'C:/x/export.md' }])
    expect(t.lastExport).toEqual({ at: T0, path: 'C:/x/export.md' })
  })

  it('cuts a long path and ignores a bad one', () => {
    const t = fold([{ kind: 'export', at: T0, path: 'p'.repeat(5000) }])
    expect(t.lastExport!.path.length).toBe(1000)
    expect(fold([{ kind: 'export', at: T0, path: '' }]).lastExport).toBeUndefined()
  })
})
