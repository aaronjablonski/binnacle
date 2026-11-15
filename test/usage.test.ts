import { describe, expect, it } from 'vitest'

import type { Budget, Ev, Timeline, UiState } from '../mod/types'
import {
  MAX_DISMISSED, MAX_MODEL, MAX_NOTIFIED, MAX_QUERY, MAX_RESULT, MAX_TOASTED, MAX_WINDOWS,
} from '../mod/hooks/model/limits'
import { empty, reduce } from '../mod/hooks/model/reduce'
import { boundUi, budgetOf, usageOf } from '../mod/hooks/model/usage'

const fold = (evs: Ev[], from: Timeline = empty): Timeline => evs.reduce(reduce, from)
let clock = 2_000_000
const at = () => ++clock
const start = (id: string, tool: string, input: Record<string, unknown> = {}, agent = 'main'): Ev =>
  ({ kind: 'step.start', at: at(), id, agent, tool, input })
const end = (id: string, status: 'done' | 'error' | 'denied' = 'done'): Ev => ({ kind: 'step.end', at: at(), id, status })
const agent = (id: string, extra: Partial<Extract<Ev, { kind: 'agent.start' }>> = {}): Ev =>
  ({ kind: 'agent.start', at: at(), id, parent: 'main', type: 'Explore', description: id, ...extra })
const usage = (who: string, tokensIn: number, tokensOut: number, model?: string): Ev => {
  const ev: Extract<Ev, { kind: 'usage' }> = { kind: 'usage', at: at(), agent: who, tokensIn, tokensOut }
  if (model !== undefined) ev.model = model
  return ev
}

describe('step.ask', () => {
  it('marks a running step with when it was asked, keeps the first, and step.end clears it', () => {
    const t = fold([start('s1', 'Bash', { command: 'ls' }), { kind: 'step.ask', at: 7, id: 's1' }, { kind: 'step.ask', at: 9, id: 's1' }])
    expect(t.steps[0]!.asking).toBe(7)
    const ended = fold([end('s1')], t)
    expect(ended.steps[0]!.asking).toBeUndefined()
    expect('asking' in ended.steps[0]!).toBe(false)
  })

  it('ignores a step that is unknown or no longer running', () => {
    const t = fold([start('s1', 'Bash', { command: 'ls' }), end('s1')])
    expect(fold([{ kind: 'step.ask', at: at(), id: 's1' }, { kind: 'step.ask', at: at(), id: 'nope' }], t)).toEqual(t)
  })

  it("a turn's end that interrupts the step clears it too", () => {
    const t = fold([
      start('s1', 'Bash', { command: 'ls' }),
      { kind: 'step.ask', at: at(), id: 's1' },
      { kind: 'turn.end', at: at(), turnId: 'x', agent: 'main', answer: '', failed: false },
    ])
    expect(t.steps[0]).toMatchObject({ status: 'interrupted' })
    expect(t.steps[0]!.asking).toBeUndefined()
  })
})

describe('usage', () => {
  it('accumulates per agent and keeps the latest model', () => {
    const t = fold([
      agent('a1'),
      usage('a1', 1000, 200, 'claude-sonnet-5-5'),
      usage('a1', 500, 50),
      usage('main', 10, 1, 'claude-haiku-5-5'),
      usage('main', 20, 2, 'claude-opus-5-5'),
    ])
    expect(t.agents.a1).toMatchObject({ model: 'claude-sonnet-5-5', tokensIn: 1500, tokensOut: 250 })
    expect(t.agents.main).toMatchObject({ model: 'claude-opus-5-5', tokensIn: 30, tokensOut: 3 })
  })

  it('ignores counts that are not finite and non-negative', () => {
    const t = fold([agent('a1'), usage('a1', 5, 5), usage('a1', Number.NaN, -3)])
    expect(t.agents.a1).toMatchObject({ tokensIn: 5, tokensOut: 5 })
  })

  it('agent.model sets the model, cut to MAX_MODEL', () => {
    const t = fold([agent('a1'), { kind: 'agent.model', id: 'a1', model: 'claude-sonnet-5-5' }])
    expect(t.agents.a1!.model).toBe('claude-sonnet-5-5')
    const long = fold([{ kind: 'agent.model', id: 'a1', model: 'm'.repeat(500) }], t)
    expect(long.agents.a1!.model!.length).toBe(MAX_MODEL)
  })

  it('usageOf sums the input side of a TurnUsage, caches included', () => {
    expect(usageOf({ input_tokens: 6, output_tokens: 1530, cache_read_input_tokens: 118293, cache_creation_input_tokens: 43295, model: 'claude-haiku-5-5' }))
      .toEqual({ model: 'claude-haiku-5-5', tokensIn: 161594, tokensOut: 1530 })
    expect(usageOf({ input_tokens: 3, output_tokens: 4 })).toEqual({ tokensIn: 3, tokensOut: 4 })
    expect(usageOf(undefined)).toBeUndefined()
    expect(usageOf({ model: 'x' })).toBeUndefined()
  })
})

describe('lastStepAt', () => {
  it('is when the agent last started a step', () => {
    const t = fold([agent('a1'), start('s1', 'Read', { file_path: 'a' }, 'a1'), start('s2', 'Read', { file_path: 'b' }, 'a1'), end('s1')])
    expect(t.agents.a1!.lastStepAt).toBe(t.steps[1]!.startedAt)
  })
})

describe('StructuredOutput result', () => {
  it("sets a workflow agent's result to its input on one line, cut to MAX_RESULT", () => {
    const t = fold([
      agent('w1', { runId: 'r1', agentIndex: 1, type: 'workflow-subagent' }),
      start('so', 'StructuredOutput', { name: 'mission-control', source: 'C:\\r\\package.json', notes: 'line one\n  line two' }, 'w1'),
    ])
    expect(t.agents.w1!.result).toBe('name: mission-control · source: C:\\r\\package.json · notes: line one line two')
    const big = fold([start('so2', 'StructuredOutput', { verdict: 'x'.repeat(1000), findings: [{ a: 1 }] }, 'w1')], t)
    expect(big.agents.w1!.result!.length).toBe(MAX_RESULT)
    expect(big.agents.w1!.result!.startsWith('verdict: xxx')).toBe(true)
  })

  it('writes nested values as JSON', () => {
    const t = fold([agent('w1', { runId: 'r1' }), start('so', 'StructuredOutput', { ok: true, n: 3, list: [1, 'a'], obj: { k: 'v' } }, 'w1')])
    expect(t.agents.w1!.result).toBe('ok: true · n: 3 · list: [1,"a"] · obj: {"k":"v"}')
  })

  it('leaves the result of main and of agents outside a workflow alone', () => {
    const t = fold([agent('a1'), start('so', 'StructuredOutput', { x: 'y' }, 'a1'), start('sm', 'StructuredOutput', { x: 'y' })])
    expect(t.agents.a1!.result).toBeUndefined()
    expect(t.agents.main!.result).toBeUndefined()
  })
})

describe('measure', () => {
  const b1: Budget = { contextPct: 4, windows: [{ name: 'seven_day', pct: 21, resetsAt: 1_795_000_000_000 }], costUsd: 0.0058, at: 1 }
  const b2: Budget = { windows: [{ name: 'five_hour', pct: 40 }], at: 2 }

  it('replaces the budget whole', () => {
    const t = fold([{ kind: 'measure', at: 10, budget: b1 }, { kind: 'measure', at: 20, budget: b2 }])
    expect(t.budget).toEqual({ windows: [{ name: 'five_hour', pct: 40 }], at: 20 })
  })

  it('keeps at most MAX_WINDOWS windows and drops malformed ones', () => {
    const windows = Array.from({ length: 12 }, (_, i) => ({ name: `w${i}`, pct: i }))
    const bad = [{ name: 'nan', pct: Number.NaN }, { name: 3, pct: 1 }] as unknown as Budget['windows']
    const t = fold([{ kind: 'measure', at: 10, budget: { windows: [...bad, ...windows], at: 0 } }])
    expect(t.budget!.windows).toHaveLength(MAX_WINDOWS)
    expect(t.budget!.windows[0]).toEqual({ name: 'w0', pct: 0 })
  })

  it('budgetOf reads session.measure: context percent, windows by kind with resetsAt in ms, cost', () => {
    const e = {
      context: { tokens: 43437, window: 1000000, percent: 4 },
      rateLimits: [{ kind: 'seven_day', percentUsed: 21, resetsAt: '2026-11-19T09:00:00.000Z' }, { kind: 'five_hour', percentUsed: 7.5 }],
      cost: { usd: 0.0058 },
      changed: ['context', 'rateLimits', 'cost'],
    }
    expect(budgetOf(e, 99)).toEqual({
      contextPct: 4,
      windows: [{ name: 'seven_day', pct: 21, resetsAt: Date.parse('2026-11-19T09:00:00.000Z') }, { name: 'five_hour', pct: 7.5 }],
      costUsd: 0.0058,
      at: 99,
    })
    expect(budgetOf({ context: { window: 200000 }, rateLimits: [{ kind: 'x', percentUsed: 1, resetsAt: 'not a date' }], changed: ['rateLimits'] }, 5))
      .toEqual({ windows: [{ name: 'x', pct: 1 }], at: 5 })
    expect(budgetOf(null, 5)).toEqual({ windows: [], at: 5 })
  })
})

describe('boundUi', () => {
  const base: UiState = {
    tab: 'overview', filter: { kind: 'all' }, agentsMode: 'list', folded: [], openTurns: [],
    dismissed: [], query: '', runningOnly: false, notified: [], toasted: [],
  }

  it('keeps the newest entries of each list and cuts the query', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => `k${i}`)
    const u = boundUi({ ...base, dismissed: many(250), notified: many(250), toasted: many(60), query: 'q'.repeat(300) })
    expect(u.dismissed).toHaveLength(MAX_DISMISSED)
    expect(u.dismissed[0]).toBe('k50')
    expect(u.notified).toHaveLength(MAX_NOTIFIED)
    expect(u.toasted).toHaveLength(MAX_TOASTED)
    expect(u.toasted.at(-1)).toBe('k59')
    expect(u.query).toHaveLength(MAX_QUERY)
  })

  it('fills a list or query a partial value lacks', () => {
    const partial = { tab: 'timeline', filter: { kind: 'all' } } as unknown as UiState
    expect(boundUi(partial)).toEqual({ ...partial, dismissed: [], query: '', runningOnly: false, notified: [], toasted: [] })
  })

  it('returns the same value when nothing is over', () => {
    const u = { ...base, dismissed: ['a'], query: 'x', run: 'r1' }
    expect(boundUi(u)).toBe(u)
  })
  it('cuts the deep-search hits to 200, keeps a short list, and drops a bad value', () => {
    const ids = Array.from({ length: 250 }, (_, i) => `s${i}`)
    const cut = boundUi({ ...base, hits: ids })
    expect(cut.hits).toHaveLength(200)
    expect(cut.hits?.[0]).toBe('s0')
    const ok = { ...base, hits: ['a'] }
    expect(boundUi(ok)).toBe(ok)
    const bad = boundUi({ ...base, hits: 'nope' as unknown as string[] })
    expect('hits' in bad).toBe(false)
  })
})
