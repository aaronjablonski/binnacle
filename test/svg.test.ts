import { expect, test } from 'vitest'

import type { AgentRow, Step, TaskItem, Timeline, UiState } from '../mod/types'
import { empty } from '../mod/hooks/model/reduce'
import { bandAlt, bandSvg, deckModel, nowDeckAlt, nowDeckSvg, SVG_MAX } from '../mod/hooks/views/svg'

const NOW = 10_000_000
// state.ts imports claude-code, which vitest cannot load: the pane's initial state, as initialUi has it.
const u: UiState = {
  tab: 'overview',
  filter: { kind: 'all' },
  agentsMode: 'list',
  folded: [],
  openTurns: [],
  dismissed: [],
  query: '',
  runningOnly: false,
  notified: [],
  toasted: [],
  slim: false,
}

const agent = (id: string, status: AgentRow['status'], type = 'Explore', extra: Partial<AgentRow> = {}): AgentRow => ({
  id, parent: 'main', type, description: `agent ${id}`, status, startedAt: NOW - 120_000, doing: '', stepCount: 1, ...extra,
})
const step = (seq: number, status: Step['status'], at: number, label = `Edit file${seq}.ts`): Step => ({
  id: `s${seq}`, seq, agent: 'main', tool: 'Edit', label, status, startedAt: at, ...(status === 'running' ? {} : { endedAt: at + 1000 }),
})
const task = (id: string, status: TaskItem['status'], tokens = 0): TaskItem => ({
  id, subject: `task ${id}`, status, owner: 'main', updatedAt: NOW - 1000, tokens,
})

/** A busy session: a focus, a running step, three windows, crew, tasks, errors, cache counts. */
function busy(): Timeline {
  return {
    ...empty,
    now: { focus: 'Wiring the limiter into the middleware chain', next: 'Run the upload tests on staging', at: NOW - 60_000 },
    turns: [{ id: 't1', agent: 'main', prompt: 'add rate limiting', startedAt: NOW - 600_000 }],
    agents: {
      ...empty.agents,
      main: { ...empty.agents.main!, status: 'running', cacheRead: 780, cacheWrite: 120, tokensIn: 1000 },
      a1: agent('a1', 'running', 'Explore'),
      a2: agent('a2', 'running', 'general-purpose'),
      a3: agent('a3', 'error', 'code-reviewer'),
      a4: agent('a4', 'done', 'Explore'),
    },
    tasks: [task('1', 'completed', 31_000), task('2', 'completed', 52_000), task('3', 'in_progress', 18_000), task('4', 'pending')],
    steps: [step(1, 'done', NOW - 500_000), step(2, 'error', NOW - 400_000), step(3, 'error', NOW - 300_000), step(4, 'running', NOW - 12_000, 'Edit rateLimit.ts')],
    budget: { contextPct: 9, windows: [{ name: 'five_hour', pct: 78 }, { name: 'seven_day', pct: 22 }], at: NOW },
    cache: { at: NOW - 60_000 },
  }
}

test('the model reads the timeline: pill, focus, running step, rings, counts', () => {
  const m = deckModel(busy(), u, NOW)
  expect(m.pill.word).toBe('WORKING')
  expect(m.focus).toBe('Wiring the limiter into the middleware chain')
  expect(m.step?.label).toBe('Edit rateLimit.ts')
  expect(m.rings.map(r => [r.name, r.pct])).toEqual([['CTX', 9], ['5H', 78], ['7D', 22]])
  expect(m.next).toBe('Run the upload tests on staging')
  expect([m.tasks.done, m.tasks.total]).toEqual([2, 4])
  expect([m.steps.count, m.steps.errors]).toEqual([4, 2])
  expect([m.live, m.failed]).toEqual([2, 1])
  expect(m.crew.length).toBe(4)
  expect(m.crew[0]!.state).toBe('working')
  expect(m.cache?.readPct).toBe(78)
})

test('the deck Svg shows the model\'s values as text and titles', () => {
  const s = nowDeckSvg(busy(), u, NOW, 62)
  expect(s.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
  expect(s.endsWith('</svg>')).toBe(true)
  for (const want of ['WORKING', 'Wiring the limiter', 'Edit rateLimit.ts', '>Next<', 'Run the upload tests on staging', '2/4', '>4<', '2 errors', '2 live', '1 failed', '78% read']) {
    expect(s).toContain(want)
  }
  expect(s).toContain('<title>CTX: 9% used</title>')
  expect(s).toContain('<title>5H: 78% used</title>')
  // No animation, no glow, no gradient (R32), and the cockpit palette: the ground, the accent, no ember in the plan strip.
  expect(s).not.toContain('<animate')
  expect(s).not.toContain('filter=')
  expect(s).not.toContain('linearGradient')
  expect(s).toContain('fill="#15171c"')
  expect(s).toContain('#8f9eff')
  expect(s.length).toBeLessThan(SVG_MAX)
})

// LOOK TEST (rewritten for the cockpit, C6): the band Svg is the band's two rows (goal and gauges, bar and words); the pill, the crew row, NEXT, the rings and `/mc` are gone (`/mc` is the Button beside the Svg).
test('the band Svg carries the goal, the gauges, the bar and its words, and the one critter', () => {
  const s = bandSvg(busy(), u, NOW, 120)
  for (const want of ['Working on', 'Wiring the limiter', 'context ', 'week ', '2</tspan>', ' of 4 done', '2 agents working', 'nothing needs you', '<title>2 of 4 done</title>', '<title>the lead</title>']) expect(s).toContain(want)
  expect(s).not.toContain('/mc')
  expect(s).not.toContain('<animate')
  expect(s.length).toBeLessThan(SVG_MAX)
})

test('the band Svg asks in amber with the asker as its critter, and an idle session is one line', () => {
  const t = busy()
  t.steps = [...t.steps, { ...step(5, 'running', NOW - 60_000, 'Bash npm run deploy'), tool: 'Bash', agent: 'a1', asking: NOW - 50_000 }]
  const s = bandSvg(t, u, NOW, 120)
  expect(s).toContain('Needs you')
  expect(s).toContain('answer below ↓')
  expect(s).toContain('1 waiting')
  expect(s).toContain('fill="#e3b04b"')
  expect(s).toContain('<title>Explorer is waiting for you</title>')
  const idle = bandSvg(empty, u, NOW, 120)
  expect(idle).toContain('height="34"')
  expect(bandSvg({ ...busy(), turns: [{ id: 't1', agent: 'main', prompt: 'x', startedAt: NOW - 600_000, endedAt: NOW - 1000, failed: true }], agents: { ...empty.agents }, steps: [] }, u, NOW, 120)).toContain('Stopped')
})

test('R2 through deckModel: an ask in auto mode shows after its 20 s, a permission outside auto at once (the same default problems() has)', () => {
  const ask = (at: number): Timeline => ({ ...busy(), autoAsk: true, steps: [{ ...step(5, 'running', at - 5000, 'Bash rm -rf build'), tool: 'Bash', asking: at }] })
  expect(deckModel(ask(NOW - 5_000), u, NOW).pill.word).toBe('WORKING')
  expect(deckModel(ask(NOW - 30_000), u, NOW).pill).toEqual({ word: 'WAITING', hue: 'amber' })
  expect(deckModel({ ...ask(NOW - 5_000), autoAsk: false }, u, NOW).pill.word).toBe('WAITING')
})

test('Watch never turns the pill amber: a stalled agent is a z on its critter and the pill stays WORKING', () => {
  const t = busy()
  t.agents = { ...t.agents, a1: { ...agent('a1', 'running', 'Explore'), startedAt: NOW - 90 * 60_000, lastStepAt: NOW - 20 * 60_000 } }
  const m = deckModel(t, u, NOW)
  expect(m.pill.word).toBe('WORKING')
  expect(m.crew.find(c => c.title.startsWith('agent a1'))?.state).toBe('stalled')
})

test('an idle session draws a quiet deck with no rings it has no figure for', () => {
  const m = deckModel(empty, u, NOW)
  expect(m.pill.word).toBe('IDLE')
  expect(m.rings).toEqual([])
  const s = nowDeckSvg(empty, u, NOW, 40)
  expect(s).toContain('IDLE')
  expect(s).not.toContain('<animate')
  expect(s.length).toBeLessThan(SVG_MAX)
})

test('a problem turns the pill amber WAITING', () => {
  const t = busy()
  t.steps = [...t.steps, { ...step(5, 'running', NOW - 60_000, 'Bash rm -rf build'), asking: NOW - 50_000 }]
  expect(deckModel(t, u, NOW).pill).toEqual({ word: 'WAITING', hue: 'amber' })
})

test('text from the model is escaped and nothing scripted is written', () => {
  const t = busy()
  t.now = { focus: 'Fix <script> & "quotes"', at: NOW }
  const s = nowDeckSvg(t, u, NOW, 62)
  expect(s).not.toContain('<script')
  expect(s).toContain('&lt;script&gt;')
  expect(s).toContain('&amp;')
  expect(/\son[a-z]+=/i.test(s)).toBe(false)
})

test('a huge session stays under the Svg limit', () => {
  const t = busy()
  const agents: Record<string, AgentRow> = { ...t.agents }
  for (let i = 0; i < 300; i++) agents[`x${i}`] = agent(`x${i}`, i % 3 === 0 ? 'running' : 'done', ['Explore', 'Plan', 'code-reviewer'][i % 3])
  t.agents = agents
  t.tasks = Array.from({ length: 200 }, (_, i) => task(String(i), i % 2 ? 'completed' : 'pending', i * 1000))
  t.steps = Array.from({ length: 2000 }, (_, i) => step(i + 1, i % 7 ? 'done' : 'error', NOW - 2_000_000 + i * 900, 'x'.repeat(400)))
  t.now = { focus: 'y'.repeat(5000), next: 'z'.repeat(5000), at: NOW }
  for (const cols of [30, 62, 200, 600]) {
    expect(nowDeckSvg(t, u, NOW, cols).length).toBeLessThan(SVG_MAX)
    expect(bandSvg(t, u, NOW, cols).length).toBeLessThan(SVG_MAX)
  }
})

test('the alts say the deck and the band in words', () => {
  const a = nowDeckAlt(busy(), u, NOW)
  expect(a).toContain('WORKING')
  expect(a).toContain('Wiring the limiter into the middleware chain')
  expect(a).toContain('2 of 4 tasks done')
  expect(a).toContain('CTX 9%')
  expect(a).toContain('4 steps, 2 errors')
  expect(bandAlt(busy(), u, NOW)).toContain('Working on Wiring the limiter into the middleware chain')
  expect(bandAlt(busy(), u, NOW)).toContain('2 of 4 done')
  expect(nowDeckAlt(empty, u, NOW).length).toBeGreaterThan(0)
})
