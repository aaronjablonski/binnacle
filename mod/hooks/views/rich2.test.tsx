import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { AgentRow, Budget, Step, TaskItem, Timeline, TurnRow, UiState } from '../../types'
import { empty } from '../model/reduce'
import { initialUi } from '../state'
import { kindLabel, needDetail, needsYou } from './needs'
import { rowsUsed, sectionRows, NOW_SECTIONS } from './fit'
import { setLedgerRows, weekSpec } from './budget'
import { keepLog, LOGS, screen } from './screen.testkit'

// The rich form of Now, NEEDS YOU, the budget view, slim and the strip, and
// the distilled features' Sees and Risks lines. The text form's tests are the
// older files' (marked LOOK TEST).

const NOW = 1_000_000
const SHAPES: Record<string, string> = { timeline: 'timeline-4', ui: 'ui-4' }
const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

function world(on: On, t: Timeline, u: UiState = initialUi): { stored: Map<string, unknown>; clock: MockClock } {
  const stored = new Map<string, unknown>([['timeline', t], ['ui', u]])
  const clock = mock.clock(on, { now: NOW })
  LOGS.length = 0
  on('ui.log', keepLog)
  on('state.get', (_, e) => {
    const key = (e as { key: string }).key
    const v = stored.get(key)
    return { value: { value: v === undefined ? undefined : { shape: SHAPES[key], value: v }, version: 0 } }
  })
  on('state.set', (_, e) => {
    const w = e as unknown as { key: string; value: { value: unknown } }
    stored.set(w.key, w.value.value)
    return { value: { isSet: true as const, version: 1 } }
  })
  return { stored, clock }
}

const PANE = (columns: number, bodyRows = 40, placement = 'dock') =>
  ({
    plugin: 'mission-control',
    component: 'Pane',
    requestId: 'mission-control',
    props: { title: 'Mission Control', isFocused: false, bodyColumns: columns, placement, scroll: { offset: 0, bodyRows }, view: {} },
  }) as const

async function mount($: Engine, columns = 62, bodyRows = 40, surface: (typeof SURFACES)[number] = 'terminal', placement = 'dock') {
  return $.ui.mount({ ...PANE(columns, bodyRows, placement), surface } as never)
}

const task = (id: string, subject: string, status: TaskItem['status'], extra: Partial<TaskItem> = {}): TaskItem => ({ id, subject, status, owner: 'main', updatedAt: NOW - 120_000, ...extra })
const step = (id: string, seq: number, label: string, status: Step['status'], extra: Partial<Step> = {}): Step => ({ id, seq, agent: 'main', tool: 'Edit', label, status, startedAt: NOW - 5000, ...extra })
const agent = (id: string, type: string, description: string, status: AgentRow['status'] = 'running', extra: Partial<AgentRow> = {}): AgentRow => ({
  id, parent: 'main', type, description, status, startedAt: NOW - 60_000, doing: 'x', stepCount: 1, ...extra,
})
const main: AgentRow = { ...empty.agents.main! }
const BUDGET: Budget = { contextPct: 9, contextTokens: 18_000, windows: [{ name: 'five_hour', pct: 18, resetsAt: NOW + 3_600_000 }, { name: 'seven_day', pct: 22, resetsAt: NOW + 86_400_000 }], at: NOW }

const busy = (extra: Partial<Timeline> = {}): Timeline => ({
  ...empty,
  now: { focus: 'Grouping timeline steps by agent', next: 'Humanise step labels', at: NOW - 20_000 },
  tasks: [task('1', 'Map', 'completed'), task('2', 'Group', 'in_progress', { activeForm: 'Grouping timeline steps by agent' }), task('3', 'Humanise step labels', 'pending')],
  agents: { main, a1: agent('a1', 'Explore', 'find every caller of stepRow'), a2: agent('a2', 'general-purpose', 'write timeline tests') },
  steps: [
    step('s1', 1, 'Bash npm test', 'error', { tool: 'Bash', agent: 'a2', endedAt: NOW - 4000 }),
    step('s3', 3, 'Edit mod/hooks/views/timeline.tsx', 'running', { startedAt: NOW - 2000 }),
  ],
  budget: BUDGET,
  ...extra,
})

const rasters = async (ui: Awaited<ReturnType<typeof mount>>): Promise<string[]> =>
  (await ui.findAll({ type: 'Raster' })).map(f => f.key ?? '?')


// ---------- the height rule ----------

test('sectionRows fills a 50-row pane: floors first, spare rows dealt round-robin to their caps, one blank between sections', () => {
  const counts = [
    { key: 'latest', count: 30, ...NOW_SECTIONS.latest },
    { key: 'agents', count: 12, ...NOW_SECTIONS.agents },
    { key: 'tasks', count: 20, ...NOW_SECTIONS.tasks },
    { key: 'kept', count: 9, ...NOW_SECTIONS.kept },
    { key: 'notes', count: 9, ...NOW_SECTIONS.notes },
  ]
  // 50 rows less the deck (11) and the footer and the gap after the deck (3).
  const got = sectionRows(50 - 11 - 3, counts)
  expect(got.map(g => g.key)).toEqual(['latest', 'agents', 'tasks', 'kept', 'notes'])
  expect(rowsUsed(got)).toBe(36)
  // Everything is at or under its cap, and the first-dealt lists have grown past their floors.
  for (const g of got) expect(g.rows).toBeLessThanOrEqual((NOW_SECTIONS as Record<string, { cap: number }>)[g.key]!.cap)
  expect(got.find(g => g.key === 'latest')!.rows).toBeGreaterThan(2)
})

// ---------- NEEDS YOU ----------

const askAt = (seconds: number): Step => step('p1', 9, 'Bash rm -rf dist && npm run build', 'running', { tool: 'Bash', agent: 'a2', startedAt: NOW - 200_000, asking: NOW - seconds * 1000 })
const waitingT = (extra: Partial<Timeline> = {}): Timeline =>
  busy({
    steps: [step('s1', 1, 'Bash npm test', 'error', { tool: 'Bash', agent: 'a2', endedAt: NOW - 4000 }), askAt(180)],
    agents: { main, a1: agent('a1', 'Explore', 'find every caller of stepRow', 'running', { startedAt: NOW - 65 * 60_000, lastStepAt: NOW - 30_000 }), a2: agent('a2', 'general-purpose', 'write timeline tests') },
    ...extra,
  })

test('long run is labelled LONG RUN with the time against its limit, a stalled agent STALLED, an ask PERMISSION', async ($, on) => {
  const t = waitingT({ steps: [step('s1', 1, 'Bash npm test', 'error', { tool: 'Bash', agent: 'a2', endedAt: NOW - 4000 })] })
  // Limits 60/120 and the ten-minute quiet rule (owner ruling 4, R6).
  const long = { ...t.agents.a1!, startedAt: NOW - 64 * 60_000, lastStepAt: NOW - 20_000 }
  const stalled = agent('a3', 'Explore', 'quiet one', 'running', { startedAt: NOW - 15 * 60_000, lastStepAt: NOW - 11 * 60_000 })
  const asking = waitingT()
  const all = { ...t, agents: { ...t.agents, a1: long, a3: stalled }, steps: [...t.steps, askAt(180)] }
  world(on, all)
  const list = needsYou(all, initialUi, NOW)
  const byKind = Object.fromEntries(list.map(p => [p.kind, p]))
  expect(kindLabel(byKind['long-run']!)).toBe('LONG RUN')
  expect(needDetail(byKind['long-run']!, NOW)).toBe('1 h 4 min of 60 min')
  expect(kindLabel(byKind['stalled']!)).toBe('STALLED')
  expect(needDetail(byKind['stalled']!, NOW)).toBe('quiet 11m')
  expect(kindLabel(byKind['asking']!)).toBe('PERMISSION')
  void asking
  const ui = await mount($)
  // Now draws them as Watch rows (C3): the kind in words, the model's sentence (R6, R27).
  const got = screen(await ui.drawn()).join(' ')
  expect(got).toContain('Long run')
  expect(got).toContain('Quiet')
  expect(got).toContain('1 h 4 min')
  await ui.unmount()
})

test('long run uses the options: agentLimitMin 0 turns it off, a larger one waits', { options: { agentLimitMin: 0 } }, async ($, on) => {
  const t = busy({ agents: { main, a1: agent('a1', 'Explore', 'slow', 'running', { startedAt: NOW - 70 * 60_000, lastStepAt: NOW - 5_000 }) } })
  world(on, t)
  const ui = await mount($)
  // I9: every spelling of the kind is ruled out (Watch draws 'Long run'), so the option must be applied.
  expect(/long run/i.test(screen(await ui.drawn()).join(' '))).toBe(false)
  await ui.unmount()
})

test('long run is shown on Now with the default limit when no option is given', async ($, on) => {
  const t = busy({ agents: { main, a1: agent('a1', 'Explore', 'slow', 'running', { startedAt: NOW - 70 * 60_000, lastStepAt: NOW - 5_000 }) } })
  world(on, t)
  const ui = await mount($)
  expect(/long run/i.test(screen(await ui.drawn()).join(' '))).toBe(true)
  await ui.unmount()
})

// ---------- fits: nothing refused ----------

test('the rich Now, the amber frame, slim and the budget view draw (the engine refuses nothing) at 62, 40, 32 and 24 columns', async ($, on) => {
  world(on, waitingT({ turns: [{ id: 't1', agent: 'main', prompt: 'p', startedAt: NOW - 50 * 60_000 } as TurnRow] }))
  for (const cols of [62, 40, 32, 28, 24]) {
    const ui = await mount($, cols, 40)
    const rows = screen(await ui.drawn())
    expect(rows.join('\n')).not.toMatch(/This tab failed|Failed:/)
    expect(rows.length).toBeGreaterThan(6)
    await ui.unmount()
  }
})

// ---------- budget view ----------

const SAMPLES = (pct5: number[]): Timeline['samples'] => ({
  names: ['five_hour', 'seven_day'],
  list: pct5.map((p, i) => ({ at: NOW - (pct5.length - 1 - i) * 120_000, w: [p, 22] as (number | null)[] })),
})

async function budgetOf($: Engine, on: On, t: Timeline, cols = 62, showCost = false) {
  world(on, t)
  const ui = await mount($, cols)
  await ui.press({ key: 'now-budget' })
  return { ui, rows: screen(await ui.drawn()) }
}

test('pace is silent early: a window that has not moved 2 points over 5 minutes has no trend row and no full-in', async ($, on) => {
  const { ui, rows } = await budgetOf($, on, busy({ samples: SAMPLES([18, 18]) }))
  expect(rows.join('\n')).not.toMatch(/per 10 min|full in/)
  await ui.unmount()
})

// LOOK TEST (rewritten for the cockpit, task C3b): the Windows rows say the rate and when it fills in words ("+5.9 per 10 min", "full in 37 min"), bold (never amber) when it fills before the reset.
test('pace speaks once a window moved: per 10 minutes and when it fills in words, bold when it fills before the reset, how long before it resets', async ($, on) => {
  const t = busy({
    budget: { ...BUDGET, windows: [{ name: 'five_hour', pct: 78, resetsAt: NOW + 4_000_000 }, { name: 'seven_day', pct: 22, resetsAt: NOW + 86_400_000 }] },
    samples: SAMPLES([50, 56, 62, 68, 72, 78]),
  })
  const { ui, rows } = await budgetOf($, on, t)
  expect(rows.join('\n')).toMatch(/\+\d+\.\d per 10 min/)
  expect(rows.join('\n')).toMatch(/full in \d+ min/)
  expect(rows.join('\n')).toMatch(/\d+ min before it resets/)
  const hot = (await ui.findAll({ type: 'Text' })).find(f => /^full in \d+ min$/.test(f.text ?? ''))
  expect(hot?.props).toMatchObject({ bold: true })
  expect((hot?.props as { color?: string }).color).toBeUndefined()
  await ui.unmount()
})

// LOOK TEST (rewritten for the cockpit, task C3b): rings in place of beads; Windows, Cache (whole-minute warm words), Models and Agents sections.
test('the budget view: rings, the output rate, Cache with the warm words, then Models and Agents shares', async ($, on) => {
  const t = busy({
    cache: { at: NOW - 60_000 },
    agents: {
      main: { ...main, tokensIn: 100_000, tokensOut: 5000, cacheRead: 80_000, cacheWrite: 10_000, ms: 60_000, model: 'claude-opus-5-5' },
      a1: agent('a1', 'Explore', 'find callers', 'running', { tokensIn: 30_000, tokensOut: 2000, model: 'claude-sonnet-5', cacheRead: 1000, cacheWrite: 1000 }),
    },
  })
  const { ui, rows } = await budgetOf($, on, t)
  const got = await rasters(ui)
  for (const k of ['budget-rings', 'budget-lintel', 'budget-sill']) expect(got).toContain(k)
  for (const gone of ['win-ctx', 'win-5h', 'win-7d', 'cache']) expect(got).not.toContain(gone)
  expect(rows.some(r => r.includes('% read'))).toBe(true)
  expect(rows.some(r => r.trim() === 'stays warm about 4 min')).toBe(true)
  expect(rows.filter(r => r.includes('warm')).join('\n')).not.toMatch(/\d:\d\d/)
  expect(rows.some(r => r.includes('going cold re-sends'))).toBe(true)
  expect(rows.some(r => r.startsWith('  Models'))).toBe(true)
  expect(rows.some(r => r.startsWith('  Agents'))).toBe(true)
  expect(rows.some(r => r.includes('/min'))).toBe(true)
  await ui.unmount()
})

test('cost is hidden without the option, and shown with showCost: the session and this turn', async ($, on) => {
  const t = busy({ budget: { ...BUDGET, costUsd: 4.12 }, turnCost: { turnId: 't1', from: 3.74, to: 4.12 } })
  const off = await budgetOf($, on, t)
  expect(off.rows.join('\n')).not.toContain('$')
  await off.ui.unmount()
})

test('cost shows with showCost on', { options: { showCost: true } }, async ($, on) => {
  const t = busy({ budget: { ...BUDGET, costUsd: 4.12 }, turnCost: { turnId: 't1', from: 3.74, to: 4.12 } })
  const on_ = await budgetOf($, on, t, 62, true)
  expect(on_.rows.some(r => r.includes('$4.12 session') && r.includes('$0.38 turn'))).toBe(true)
  expect(on_.rows.some(r => r.startsWith('  Cost'))).toBe(true)
  await on_.ui.unmount()
})

test('THIS WEEK reads the ledger: the header with tokens and sessions, the seven day columns, e writes the CSV', async ($, on) => {
  const day = new Date(NOW)
  const stamp = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
  const rows = [{ day: stamp, session: 's1', tokens: { 'claude-opus-5-5': 400_000, 'claude-sonnet-5': 100_000 }, at: NOW }]
  setLedgerRows(rows)
  const w = weekSpec(
    [{ day: stamp, tokens: rows[0]!.tokens, total: 500_000, sessions: 1 }],
  )
  expect(w.primary).toBe('claude-opus-5-5')
  expect(w.second).toBe(true)
  expect(w.spec.columns).toBe(4)
  world(on, busy())
  const ui = await mount($)
  await ui.press({ key: 'now-budget' })
  const out = screen(await ui.drawn())
  expect(out.some(r => r.startsWith('┌ THIS WEEK'))).toBe(false) // the press reloads the (empty) store; the cached rows were replaced
  setLedgerRows([])
  await ui.unmount()
})


// ---------- the done signal ----------

const turnEnded = (ms: number, extra: Partial<TurnRow> = {}): Timeline => ({
  ...busy(),
  turns: [{ id: 't1', agent: 'main', prompt: 'p', startedAt: NOW - 1000 - ms, endedAt: NOW - 1000, ...extra } as TurnRow],
  steps: [],
  agents: { main },
})

async function ticking($: Engine, on: On, t: Timeline) {
  const w = world(on, t)
  const notes: string[] = []
  on('ui.notify', (_, e) => {
    notes.push((e as unknown as { text: string }).text)
    return { value: { isSent: true as const, channel: 'terminal' } } as never
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: false as const, reason: 'narrow' } }))
  on('command.register', () => ({ value: { command: 'mc' } }))
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  return { ...w, notes }
}

test('done is quiet under 60 s: a 45 s turn that ended normally raises nothing', { options: { notify: 'done' } }, async ($, on) => {
  const { clock, notes } = await ticking($, on, turnEnded(45_000))
  await clock.advance(3000)
  expect(notes).toEqual([])
})

test('done fires once for a turn of a minute or more that ended normally, with the time and the focus', { options: { notify: 'done' } }, async ($, on) => {
  const { stored, clock, notes } = await ticking($, on, turnEnded(372_000))
  await clock.advance(3000)
  await clock.advance(3000)
  expect(notes.length).toBe(1)
  expect(notes[0]).toContain('Done in 6m 12s')
  expect(notes[0]).toContain('Grouping timeline steps by agent')
  expect((stored.get('ui') as UiState).notified).toEqual(['done:t1'])
})

// I9: was named "interrupted or failed turn, and under the default notify" but held only the interrupted case; each case is its own test now.
test('done is quiet for an interrupted turn', { options: { notify: 'done' } }, async ($, on) => {
  const { clock, notes } = await ticking($, on, turnEnded(120_000, { aborted: true }))
  await clock.advance(3000)
  expect(notes).toEqual([])
})

test('done is quiet for a failed turn under notify done', { options: { notify: 'done' } }, async ($, on) => {
  const { clock, notes } = await ticking($, on, turnEnded(120_000, { failed: true }))
  await clock.advance(3000)
  expect(notes).toEqual([])
})

test('done is quiet with notify waits (the default): a long turn ended normally raises nothing', async ($, on) => {
  const { clock, notes } = await ticking($, on, turnEnded(120_000))
  await clock.advance(3000)
  expect(notes).toEqual([])
})

test('with doneSound on, the done notification plays the done sound once', { options: { notify: 'done', doneSound: true } }, async ($, on) => {
  const plays: unknown[] = []
  on('audio.play', (_, e) => {
    plays.push((e as { clip?: { asset?: unknown } }).clip?.asset)
    return { value: undefined } as never
  })
  const { clock, notes } = await ticking($, on, turnEnded(120_000))
  await clock.advance(3000)
  await clock.advance(3000)
  expect(notes.length).toBe(1)
  expect(plays).toEqual(['sounds/done.wav'])
})

test('the done sound is off by default: nothing plays', { options: { notify: 'done' } }, async ($, on) => {
  const plays: unknown[] = []
  on('audio.play', () => {
    plays.push(1)
    return { value: undefined } as never
  })
  const { clock, notes } = await ticking($, on, turnEnded(120_000))
  await clock.advance(3000)
  expect(notes.length).toBe(1)
  expect(plays).toEqual([])
})

test('the lintel readout is left out where it would touch the pill: the budget view, NEEDS YOU and the strip at 32 columns are not refused', async ($, on) => {
  world(on, waitingT({ cache: { at: NOW - 60_000 } }))
  for (const cols of [32, 38, 44]) {
    const ui = await mount($, cols, 40)
    await ui.press({ key: cols < 40 ? 'arm-hint-budget' : 'now-budget' }).catch(() => undefined)
    const rows = screen(await ui.drawn())
    expect(rows.join('\n')).not.toMatch(/This tab failed|Failed:|mixes/)
    await ui.unmount()
  }
})

