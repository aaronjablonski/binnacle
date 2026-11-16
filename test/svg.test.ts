import { expect, test } from 'vitest'

import type { AgentRow, Ev, Step, TaskItem, Timeline, UiState } from '../mod/types'
import { CHECKING_TEXT, watch } from '../mod/hooks/model/alerts'
import { empty, reduce } from '../mod/hooks/model/reduce'
import { bandAlt, bandSvg, deckModel, nowDeckAlt, nowDeckSvg, SVG_MAX } from '../mod/hooks/views/svg'
import type { DeckHead } from '../mod/hooks/views/svg'

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

/**
 * The header's words the pane's own functions would hand the Svg (svgview.tsx `deckHead`, which vitest cannot load:
 * it imports the engine). The real words are tested in the engine, mod/hooks/views/svgheader.test.tsx.
 */
const head = (over: Partial<DeckHead> = {}): DeckHead => ({
  pill: 'WORKING',
  tone: 'iris',
  meta: [{ text: '10 min this turn', dim: true }],
  kicker: 'Working on',
  lead: 'working',
  goal: { text: 'Wiring the limiter into the middleware chain', isIdle: false },
  budget: [{ text: '9% of 1M', dim: true }],
  gauges: [{ pct: 9, label: 'context' }, { pct: 78, label: '5 hours' }, { pct: 22, label: 'this week' }],
  ...over,
})

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

test('the model reads the timeline and the header words: pill, goal, rings, counts, crew', () => {
  const m = deckModel(busy(), u, NOW, head())
  expect(m.pill).toEqual({ word: 'WORKING', hue: 'iris' })
  expect(m.focus).toBe('Wiring the limiter into the middleware chain')
  expect(m.rings.map(r => [r.name, r.pct])).toEqual([['context', 9], ['5 hours', 78], ['this week', 22]])
  expect([m.tasks.done, m.tasks.total]).toEqual([2, 4])
  expect([m.agents.working, m.agents.waiting, m.agents.failed]).toEqual([2, 0, 1])
  // I4: the header holds no crew line-up and no plan strip; the pane's sections carry both.
  for (const k of ['crew', 'more', 'live', 'failed']) expect(k in m).toBe(false)
  expect('plan' in m.tasks).toBe(false)
  // The cockpit header holds no step line, turn counter, Next, trace or cache.
  for (const k of ['step', 'right', 'next', 'cache', 'steps']) expect(k in m).toBe(false)
})

test('the deck Svg shows the model\'s values as text and titles', () => {
  const s = nowDeckSvg(busy(), u, NOW, 62, head())
  expect(s.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
  expect(s.endsWith('</svg>')).toBe(true)
  for (const want of ['WORKING', 'Wiring the limiter', 'Working on', '10 min this turn']) {
    expect(s).toContain(want)
  }
  // I4: no Agents row, no To do row, no plan strip, no failed badge, no hairline between a header and a second block.
  for (const gone of ['>Agents<', '>To do<', '2/4', '1 failed', 'stroke-dasharray="1 5"']) expect(s).not.toContain(gone)
  expect(s).toContain('height="132"')
  // R26 / review I-4: the cockpit removed Next, "n live", the Steps trace with its error count and the Cache row.
  for (const gone of ['>Next<', 'Run the upload tests on staging', ' live', ' errors', '% read', '>Steps<', '>Cache<', 'Edit rateLimit.ts', '▸', 'turn ']) {
    expect(s).not.toContain(gone)
  }
  expect(s).toContain('<title>context: 9% used</title>')
  expect(s).toContain('<title>5 hours: 78% used</title>')
  // No animation, no glow, no gradient (R32), and the cockpit palette: the ground, the accent, no ember.
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

// R3-B I4 changed this test's meaning (the header no longer draws a crew line-up, so there is no `z` to read); the mop-up restores a real stalled agent behind it: the alert model must mark it stalled, and the header Svg must still carry no amber.
test('Watch never turns anything amber: a really stalled step adds no amber to the header Svg', () => {
  const MIN = 60_000
  const call = { command: 'npm test' }
  const t = [
    { kind: 'step.start', at: NOW - 40 * MIN, id: 'w1', agent: 'main', tool: 'Bash', input: call },
    { kind: 'step.end', at: NOW - 38 * MIN, id: 'w1', status: 'done' },
    { kind: 'step.start', at: NOW - 38 * MIN, id: 'w2', agent: 'main', tool: 'Bash', input: call },
    { kind: 'step.end', at: NOW - 36 * MIN, id: 'w2', status: 'done' },
    { kind: 'step.start', at: NOW - 20 * MIN, id: 'w3', agent: 'main', tool: 'Bash', input: call },
  ].reduce((acc, ev) => reduce(acc, ev as Ev), busy())
  expect(watch(t, NOW).some(w => w.kind === 'stalled')).toBe(true)
  const s = nowDeckSvg(t, u, NOW, 62, head())
  expect(s).not.toContain('fill="#e3b04b"')
})

test('an idle session draws a quiet deck with no rings it has no figure for', () => {
  const quiet = head({ pill: 'IDLE', tone: 'mute', meta: [], kicker: 'Ready', lead: 'done', goal: { text: 'Idle. Nothing running yet.', isIdle: true }, budget: [{ text: 'no budget reading yet', dim: true }], gauges: [] })
  const m = deckModel(empty, u, NOW, quiet)
  expect(m.pill.word).toBe('IDLE')
  expect(m.rings).toEqual([])
  const s = nowDeckSvg(empty, u, NOW, 40, quiet)
  expect(s).toContain('IDLE')
  expect(s).not.toContain('<animate')
  expect(s.length).toBeLessThan(SVG_MAX)
})

test('a waiting header is the amber pill with its wait beside it', () => {
  const waiting = head({ pill: 'WAITING FOR YOU', tone: 'amber', meta: [{ text: '1 min', dim: true }], kicker: 'Paused on' })
  const s = nowDeckSvg(busy(), u, NOW, 62, waiting)
  expect(s).toContain('WAITING FOR YOU')
  expect(s).toContain('1 min')
  expect(s).toContain('fill="#e3b04b"')
})

test('text from the model is escaped and nothing scripted is written', () => {
  const t = busy()
  t.now = { focus: 'Fix <script> & "quotes"', at: NOW }
  const s = nowDeckSvg(t, u, NOW, 62, head({ goal: { text: 'Fix <script> & "quotes"', isIdle: false } }))
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
    expect(nowDeckSvg(t, u, NOW, cols, head({ goal: { text: 'y'.repeat(5000), isIdle: false } })).length).toBeLessThan(SVG_MAX)
    expect(bandSvg(t, u, NOW, cols).length).toBeLessThan(SVG_MAX)
  }
})

test('the alts say the deck and the band in words', () => {
  const a = nowDeckAlt(busy(), u, NOW, head())
  expect(a).toContain('WORKING, 10 min this turn')
  expect(a).toContain('Working on: Wiring')
  expect(a).toContain('Wiring the limiter into the middleware chain')
  expect(a).toContain('2 of 4 tasks done')
  expect(a).toContain('context 9%, 5 hours 78%')
  // M15: the pane's own words, "2 working · 1 failed", and no keyboard hints on a clicked surface.
  expect(a).toContain('2 working · 1 failed')
  expect(a).not.toMatch(/agents working|esc |press /)
  expect(a).not.toMatch(/live|Next:|steps, d+ errors|Cache|Running|turn d/)
  expect(bandAlt(busy(), u, NOW)).toContain('Working on Wiring the limiter into the middleware chain')
  expect(bandAlt(busy(), u, NOW)).toContain('2 of 4 done')
  expect(nowDeckAlt(empty, u, NOW, head()).length).toBeGreaterThan(0)
})

test('the desktop band says "Checking a permission" in the checking gap, never "nothing needs you"', () => {
  const ask: Timeline = { ...busy(), autoAsk: true, steps: [{ ...step(5, 'running', NOW - 5000, 'Bash rm -rf build'), tool: 'Bash', asking: NOW - 2000 }] }
  const s = bandSvg(ask, u, NOW, 100)
  expect(s).toContain(CHECKING_TEXT)
  expect(s).not.toContain('nothing needs you')
})
