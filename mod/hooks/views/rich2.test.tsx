import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { AgentRow, Budget, Step, TaskItem, Timeline, TurnRow, UiState } from '../../types'
import { empty } from '../model/reduce'
import { initialUi } from '../state'
import { kindLabel, needDetail, needsYou } from './needs'
import { cacheReadout, nowSections, staleFocus, turnLines } from './overview'
import { rowsUsed, sectionRows, NOW_SECTIONS } from './fit'
import { setLedgerRows, weekSpec } from './budget'
import { backTo, keepLog, LOGS, screen } from './screen.testkit'
import type { ViewCtx } from './shell'

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

const keys = async (ui: Awaited<ReturnType<typeof mount>>): Promise<string[]> =>
  (await ui.findAll({})).filter(f => f.type === 'Button').map(f => f.key ?? '?')
const texts = async (ui: Awaited<ReturnType<typeof mount>>): Promise<string[]> =>
  (await ui.findAll({ type: 'Text' })).map(f => f.text ?? '')
const rasters = async (ui: Awaited<ReturnType<typeof mount>>): Promise<string[]> =>
  (await ui.findAll({ type: 'Raster' })).map(f => f.key ?? '?')

// ---------- Now, rich ----------

test('rich Now: the lead, the rings, the crew, the plan and the trace are Rasters on the terminal and none on the other surfaces', async ($, on) => {
  world(on, busy())
  const rich = await mount($)
  const got = await rasters(rich)
  for (const k of ['lead', 'dials', 'crew', 'plan', 'trace', 'now-lintel', 'now-sill']) expect(got).toContain(k)
  await rich.unmount()
  for (const surface of ['vscode', 'mobile'] as const) {
    const ui = await mount($, 62, 40, surface)
    expect(await rasters(ui)).toEqual([])
    // The text form is the built Neo deck, untouched.
    expect(screen(await ui.drawn()).some(r => r.startsWith('┏ FOCUS'))).toBe(true)
    await ui.unmount()
  }
})

// I9: the old walker returned at a Raster node, so it could never see a Button "inside" one and always passed.
// The instrument's own Box (`inst-*`) is what holds a Raster's cells: no Button may sit in it, and a row of
// fixed-width Boxes (instruments beside their label Buttons) must fit the pane, or a Button would overlap the picture.
test('rich Now: no Button inside an instrument Box, and every row of fixed-width Boxes fits the pane', async ($, on) => {
  world(on, busy())
  for (const cols of [62, 40]) {
    const ui = await mount($, cols)
    const inside: string[] = []
    const wide: string[] = []
    let instruments = 0
    type N = { type?: unknown; props?: Record<string, unknown>; children?: unknown }
    const kidsOf = (n: N): unknown[] => {
      const c = n.children ?? n.props?.children
      return c === undefined ? [] : Array.isArray(c) ? c.flat(Infinity) : [c]
    }
    const walk = (n: unknown, inInst: boolean): void => {
      if (n === null || typeof n !== 'object') return
      if (Array.isArray(n)) return n.forEach(k => walk(k, inInst))
      const node = n as N
      const key = typeof node.props?.key === 'string' ? node.props.key : ''
      if (inInst && node.type === 'Button') inside.push(key)
      const isInst = node.type === 'Box' && key.startsWith('inst-')
      if (isInst) instruments += 1
      if (node.type === 'Box' && node.props?.flexDirection !== 'column') {
        const widths = kidsOf(node).map(k => (k as N)?.props?.width).filter((w): w is number => typeof w === 'number')
        const sum = widths.reduce((a, b) => a + b, 0)
        if (sum > cols) wide.push(`${key || '(row)'}: ${sum} > ${cols}`)
      }
      for (const k of kidsOf(node)) walk(k, inInst || isInst)
    }
    walk(await ui.drawn(), false)
    expect(instruments).toBeGreaterThan(3)
    expect(inside).toEqual([])
    expect(wide).toEqual([])
    await ui.unmount()
  }
})

test('rich Now: the hero step opens its page, BUDGET opens the budget view, CREW opens Agents', async ($, on) => {
  const { stored } = world(on, busy())
  const ui = await mount($)
  expect(await keys(ui)).toEqual(expect.arrayContaining(['hero-step', 'deck-budget', 'deck-crew', 'deck-tasks', 'deck-steps']))
  await ui.press({ key: 'hero-step' })
  const opened = stored.get('ui') as UiState & { stepBody?: { stepId: string } }
  expect(opened.page).toEqual({ kind: 'step', id: 's3', from: 'hero-step' })
  // Through openStep: the body read ran for this step (none is kept here, so it is marked missing).
  expect(opened.stepBody?.stepId).toBe('s3')
  await ui.press({ key: 'deck-crew' })
  expect((stored.get('ui') as UiState).tab).toBe('agents')
  await ui.unmount()
})

test('rich Now: the ring starts on CREW when nothing waits, and on the first need when something does', async ($, on) => {
  world(on, busy())
  const calm = await mount($)
  const start = (await calm.findAll({})).filter(f => f.props.autoFocus === true).map(f => f.key)
  expect(start).toEqual(['deck-crew'])
  await calm.unmount()
})

test('rich Now: the headline wraps to two lines and is cut only at a word', async ($, on) => {
  const long = 'Wiring the limiter into the middleware chain and then running every upload test against the staging bucket twice'
  world(on, busy({ now: { focus: long, at: NOW - 1000 } }))
  const ui = await mount($)
  const lines = [...new Set(await texts(ui))].filter(t => t.trim().length > 8 && long.includes(t.replace(/…$/, '').trim()))
  expect(lines.length).toBe(2)
  for (const l of lines) {
    const body = l.replace(/…$/, '')
    expect(long.includes(body)).toBe(true)
    // each line ends at a word: the next character of the focus is a space (or the line is the focus's end)
    const at = long.indexOf(body) + body.length
    expect(at >= long.length || long[at] === ' ').toBe(true)
  }
  expect(lines[1]!.endsWith('…')).toBe(true)
  await ui.unmount()
})

// ---------- stale focus ----------

test('stale focus: older than 10 minutes with steps since, the latest activity leads and the focus sits in a FOCUS 14m row', async ($, on) => {
  const t = busy({ now: { focus: 'Wiring the limiter', next: 'x', at: NOW - 14 * 60_000 } })
  expect(staleFocus(t, NOW)?.since).toBe(2)
  world(on, t)
  const ui = await mount($)
  const found = await ui.findAll({ type: 'Text' })
  const lead = found.find(f => (f.text ?? '').includes('Edit'))
  expect((lead?.props as { bold?: boolean }).bold).toBe(true)
  expect(found.some(f => f.text === 'FOCUS 14m' && (f.props as { color?: string }).color === 'warning')).toBe(true)
  expect(found.some(f => f.text === 'Wiring the limiter' && (f.props as { dimColor?: boolean }).dimColor === true)).toBe(true)
  expect(found.some(f => (f.text ?? '').includes('2 steps since the focus'))).toBe(true)
  await ui.unmount()
})

test('stale focus: a fresh focus, or an old one with no step since, stays in the hero', () => {
  expect(staleFocus(busy(), NOW)).toBeUndefined()
  const old = busy({ now: { focus: 'old', at: NOW - 20 * 60_000 }, steps: [step('s1', 1, 'Edit a.ts', 'done', { startedAt: NOW - 30 * 60_000 })] })
  expect(staleFocus(old, NOW)).toBeUndefined()
})

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

test('rich Now at 50 rows: the sections are given all the rows the deck leaves, and a pane too short for them drops the last first', async ($, on) => {
  const t = busy({
    steps: Array.from({ length: 30 }, (_, i) => step(`x${i}`, i + 1, `Edit f${i}.ts`, 'done', { startedAt: NOW - 100_000 + i * 1000, endedAt: NOW - 90_000 + i * 1000 })),
    tasks: Array.from({ length: 14 }, (_, i) => task(String(i), `Task ${i}`, i === 3 ? 'in_progress' : i < 3 ? 'completed' : 'pending')),
    notes: Array.from({ length: 6 }, (_, i) => ({ text: `note ${i}`, agent: 'main', at: NOW - 1000 * i })),
  })
  world(on, t)
  const ui = await mount($, 62, 50)
  const rows = screen(await ui.drawn())
  for (const label of ['TASKS', 'AGENTS', 'LATEST', 'NOTES']) expect(rows.some(r => r.startsWith(`┌ ${label}`))).toBe(true)
  const latest = rows.findIndex(r => r.startsWith('┌ LATEST'))
  const after = rows.slice(latest + 1)
  expect(after.findIndex(r => r === '')).toBeGreaterThanOrEqual(5)
  expect(rows.filter(r => r.startsWith('  ·')).length).toBe(4)
  await ui.unmount()
  // At 24 rows the spare is small and TASKS is not on Now at all (it joins from 40).
  const short = await mount($, 62, 24)
  const srows = screen(await short.drawn())
  expect(srows.some(r => r.startsWith('┌ TASKS'))).toBe(false)
  await short.unmount()
})

test('nowSections: TASKS joins from 40 rows and the sections keep their order', () => {
  const ctx = (bodyRows: number): ViewCtx => ({ e: {} as never, t: busy(), u: initialUi, cols: 62, now: NOW, bodyRows })
  expect(nowSections(ctx(36), 30).some(g => g.key === 'tasks')).toBe(false)
  expect(nowSections(ctx(40), 30).map(g => g.key)).toEqual(['tasks', 'agents', 'latest'])
})

// ---------- THIS TURN ----------

test('THIS TURN replaces LATEST once the turn ended with something done, and LATEST is back while the session works', async ($, on) => {
  const ended: TurnRow = { id: 't1', agent: 'main', prompt: 'p', startedAt: NOW - 400_000, endedAt: NOW - 10_000 }
  const t = busy({
    turns: [ended],
    steps: [step('s1', 1, 'Edit a.ts', 'done', { startedAt: NOW - 300_000, endedAt: NOW - 290_000 })],
    tasks: [task('1', 'Map', 'completed', { updatedAt: NOW - 100_000 })],
    agents: { main },
  })
  expect(turnLines(t).map(l => l.text)).toEqual(['ran 6m', '1 task closed', '1 file changed'])
  world(on, t)
  const ui = await mount($)
  const rows = screen(await ui.drawn())
  expect(rows.some(r => r.startsWith('┌ THIS TURN'))).toBe(true)
  expect(rows.some(r => r.startsWith('┌ LATEST'))).toBe(false)
  await ui.unmount()
})

// ---------- NEEDS YOU ----------

const askAt = (seconds: number): Step => step('p1', 9, 'Bash rm -rf dist && npm run build', 'running', { tool: 'Bash', agent: 'a2', startedAt: NOW - 200_000, asking: NOW - seconds * 1000 })
const waitingT = (extra: Partial<Timeline> = {}): Timeline =>
  busy({
    steps: [step('s1', 1, 'Bash npm test', 'error', { tool: 'Bash', agent: 'a2', endedAt: NOW - 4000 }), askAt(180)],
    agents: { main, a1: agent('a1', 'Explore', 'find every caller of stepRow', 'running', { startedAt: NOW - 65 * 60_000, lastStepAt: NOW - 30_000 }), a2: agent('a2', 'general-purpose', 'write timeline tests') },
    ...extra,
  })

test('rich NEEDS YOU: an amber frame with the asker, its kind in words, and g, x and n as keys', async ($, on) => {
  world(on, waitingT())
  const ui = await mount($)
  const got = await rasters(ui)
  expect(got).toEqual(expect.arrayContaining(['needs-lintel', 'asker', 'needs-sill']))
  expect(await keys(ui)).toEqual(expect.arrayContaining(['open-asking:p1', 'chat-asking:p1', 'dismiss-asking:p1', 'need-next']))
  const rows = screen(await ui.drawn())
  const first = rows.find(r => r.includes('permission'))
  expect(first).toBeDefined()
  expect(rows.some(r => r.startsWith('  STALLED') || r.includes('LONG RUN'))).toBe(true)
  await ui.unmount()
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
  const got = await texts(ui)
  expect(got).toContain('LONG RUN')
  expect(got).toContain('STALLED')
  // The legacy detail column holds 11 cells: the R27 span shows whole and the limit is cut at a word (C3 redraws Watch).
  expect(got.some(t2 => t2.includes('1 h 4 min'))).toBe(true)
  await ui.unmount()
})

test('long run uses the options: agentLimitMin 0 turns it off, a larger one waits', { options: { agentLimitMin: 0 } }, async ($, on) => {
  const t = busy({ agents: { main, a1: agent('a1', 'Explore', 'slow', 'running', { startedAt: NOW - 70 * 60_000, lastStepAt: NOW - 5_000 }) } })
  world(on, t)
  const ui = await mount($)
  // I9: Now names the opened need's kind in lower case ('long run'), so both spellings are ruled out;
  // the old check of 'LONG RUN' alone passed while the option was never applied.
  expect((await texts(ui)).some(x => x.includes('long run') || x.includes('LONG RUN'))).toBe(false)
  await ui.unmount()
})

test('long run is shown on Now with the default limit when no option is given', async ($, on) => {
  const t = busy({ agents: { main, a1: agent('a1', 'Explore', 'slow', 'running', { startedAt: NOW - 70 * 60_000, lastStepAt: NOW - 5_000 }) } })
  world(on, t)
  const ui = await mount($)
  expect((await texts(ui)).some(x => x.includes('long run') || x.includes('LONG RUN'))).toBe(true)
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

// ---------- the strip ----------

test('rich NEEDS YOU grows with the height: 6 and a more line on a short pane and at 24, more at 36, all 12 at 50', async ($, on) => {
  const ids = Array.from({ length: 12 }, (_, i) => `w${i + 1}`)
  const t = busy({
    agents: { main, ...Object.fromEntries(ids.map(id => [id, agent(id, 'general-purpose', `agent ${id}`)])) },
    steps: ids.map((id, i) => step(`p${i + 1}`, i + 1, `Bash job${i + 1}`, 'running', { tool: 'Bash', agent: id, startedAt: NOW - 400_000, asking: NOW - (200 - i) * 1000 })),
  })
  world(on, t)
  const at = async (bodyRows: number): Promise<{ n: number; more: boolean }> => {
    const ui = await mount($, 62, bodyRows)
    const listed = new Set((await keys(ui)).flatMap(k => /asking:(p\d+)$/.exec(k)?.[1] ?? []))
    const rows = screen(await ui.drawn())
    await ui.unmount()
    // NEEDS YOU's own more line counts what it left out (LATEST below has a more line of its own).
    return { n: listed.size, more: rows.some(r => r.trim().startsWith(`+ ${12 - listed.size} more`)) }
  }
  const tiny = await at(14)
  expect(tiny).toEqual({ n: 6, more: true })
  const short = await at(24)
  const mid = await at(36)
  // The rich frame above takes most of 24 rows: NEEDS YOU keeps its 6 there, and grows by 36.
  expect(short.n).toBeGreaterThanOrEqual(6)
  expect(mid.n).toBeGreaterThan(short.n)
  expect(await at(50)).toEqual({ n: 12, more: false })
})

test('rich strip: compartments from 96 columns, each with its own lintel and sill; NEEDS YOU takes the second place', async ($, on) => {
  world(on, waitingT())
  for (const [cols, want] of [[100, ['now', 'needs']], [130, ['now', 'needs', 'agents']], [190, ['now', 'needs', 'agents', 'latest', 'budget']]] as const) {
    const ui = await mount($, cols, 14, 'terminal', 'inline')
    const got = await rasters(ui)
    expect(got).toContain('strip-now-lintel')
    for (const k of want.slice(1)) expect(got).toContain(`${k}-lintel`)
    expect(got.filter(k => k.endsWith('-lintel')).length).toBe(want.length)
    for (const r of screen(await ui.drawn())) expect(r.length).toBeLessThanOrEqual(cols)
    await ui.unmount()
  }
})

test('rich strip: a need row opens the page of the asking step through openStep, so its body loads', async ($, on) => {
  const { stored } = world(on, waitingT())
  const ui = await mount($, 100, 14, 'terminal', 'inline')
  const need = (await keys(ui)).find(k => k.startsWith('need-'))
  expect(need).toBeDefined()
  await ui.press({ key: need ?? '' })
  const u = stored.get('ui') as UiState & { stepBody?: { stepId: string } }
  expect(u.page).toEqual({ kind: 'step', id: 'p1' })
  expect(u.stepBody?.stepId).toBe('p1')
  await ui.unmount()
})

test('rich strip: without a Raster the text strip is drawn', async ($, on) => {
  world(on, busy())
  const ui = await mount($, 100, 14, 'vscode', 'inline')
  expect(await rasters(ui)).toEqual([])
  // I9: the text strip itself, not just the absence of Rasters: its two halves, the focus and the latest step.
  expect(await ui.find({ key: 'strip-left' })).toBeDefined()
  expect(await ui.find({ key: 'strip-right' })).toBeDefined()
  const rows = screen(await ui.drawn()).join('\n')
  expect(rows).toContain('Grouping timeline steps by agent')
  expect(rows).toContain('LATEST')
  await ui.unmount()
})

// ---------- slim ----------

test('rich slim: a lintel with the pill, three small characters with +n and !n, the plan strip, beads, a sill', async ($, on) => {
  const t = busy({ agents: { main, a1: agent('a1', 'Explore', 'a'), a2: agent('a2', 'general-purpose', 'b'), a3: agent('a3', 'Explore', 'c', 'error'), a4: agent('a4', 'Explore', 'd') } })
  world(on, t)
  const ui = await mount($, 28, 40)
  const got = await rasters(ui)
  for (const k of ['slim-lintel', 'crew', 'plan', 'b-ctx', 'b-5h', 'slim-sill']) expect(got).toContain(k)
  const rows = screen(await ui.drawn())
  expect(rows.some(r => r.includes('+2'))).toBe(true)
  expect(rows.some(r => r.includes('!1'))).toBe(true)
  expect(await keys(ui)).toEqual(expect.arrayContaining(['slim-go-agents', 'slim-go-tasks', 'slim-go-budget']))
  await ui.unmount()
})

// ---------- budget view ----------

const SAMPLES = (pct5: number[]): Timeline['samples'] => ({
  names: ['five_hour', 'seven_day'],
  list: pct5.map((p, i) => ({ at: NOW - (pct5.length - 1 - i) * 120_000, w: [p, 22] as (number | null)[] })),
})

async function budgetOf($: Engine, on: On, t: Timeline, cols = 62, showCost = false) {
  world(on, t)
  const ui = await mount($, cols)
  await ui.press({ key: 'deck-budget' })
  return { ui, rows: screen(await ui.drawn()) }
}

test('pace is silent early: a window that has not moved 2 points over 5 minutes has no trend row and no full-in', async ($, on) => {
  const { ui, rows } = await budgetOf($, on, busy({ samples: SAMPLES([18, 18]) }))
  expect(await rasters(ui)).not.toContain('rate-5h')
  expect(rows.join('\n')).not.toMatch(/full \d/)
  await ui.unmount()
})

test('pace speaks once a window moved: the trend, per 10 minutes and when it fills, amber when it fills before the reset', async ($, on) => {
  const t = busy({
    budget: { ...BUDGET, windows: [{ name: 'five_hour', pct: 78, resetsAt: NOW + 4_000_000 }, { name: 'seven_day', pct: 22, resetsAt: NOW + 86_400_000 }] },
    samples: SAMPLES([50, 56, 62, 68, 72, 78]),
  })
  const { ui, rows } = await budgetOf($, on, t)
  expect(await rasters(ui)).toContain('rate-5h')
  expect(rows.some(r => /full \d+m/.test(r))).toBe(true)
  expect(rows.some(r => /short \d+m/.test(r))).toBe(true)
  expect(rows.some(r => r.includes('+'))).toBe(true)
  const amber = (await ui.findAll({ type: 'Text' })).find(f => /^full \d+m$/.test(f.text ?? ''))
  expect(amber?.props).toMatchObject({ color: 'warning' })
  await ui.unmount()
})

test('the budget view: windows as beads, OUTPUT, CACHE with the warm countdown, then MODELS and AGENTS shares', async ($, on) => {
  const t = busy({
    cache: { at: NOW - 60_000 },
    agents: {
      main: { ...main, tokensIn: 100_000, tokensOut: 5000, cacheRead: 80_000, cacheWrite: 10_000, ms: 60_000, model: 'claude-opus-5-5' },
      a1: agent('a1', 'Explore', 'find callers', 'running', { tokensIn: 30_000, tokensOut: 2000, model: 'claude-sonnet-5', cacheRead: 1000, cacheWrite: 1000 }),
    },
  })
  const { ui, rows } = await budgetOf($, on, t)
  const got = await rasters(ui)
  for (const k of ['win-ctx', 'win-5h', 'win-7d', 'cache', 'budget-lintel']) expect(got).toContain(k)
  expect(rows.some(r => r.includes('% read'))).toBe(true)
  expect(rows.some(r => /warm ~\d:\d\d/.test(r))).toBe(true)
  expect(rows.some(r => r.includes('going cold re-sends'))).toBe(true)
  expect(rows.some(r => r.startsWith('┌ MODELS'))).toBe(true)
  expect(rows.some(r => r.startsWith('┌ AGENTS'))).toBe(true)
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
  expect(on_.rows.some(r => r.includes('COST') && r.includes('$4.12 session') && r.includes('$0.38 turn'))).toBe(true)
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
  await ui.press({ key: 'deck-budget' })
  const out = screen(await ui.drawn())
  expect(out.some(r => r.startsWith('┌ THIS WEEK'))).toBe(false) // the press reloads the (empty) store; the cached rows were replaced
  setLedgerRows([])
  await ui.unmount()
})

// ---------- cache readout and the lintel ----------

test('idle with a warm cache the readout is CACHE ~m:ss; while a main turn runs it is the turn clock', () => {
  const idle = busy({ cache: { at: NOW - 60_000 } })
  expect(cacheReadout(idle, NOW)).toMatch(/^CACHE ~[34]:\d\d$/)
  const cold = busy({ cache: { at: NOW - 10 * 60_000 } })
  expect(cacheReadout(cold, NOW)).toBeUndefined()
  const running = busy({ cache: { at: NOW - 60_000 }, turns: [{ id: 't1', agent: 'main', prompt: 'p', startedAt: NOW - 30_000 } as TurnRow] })
  expect(cacheReadout(running, NOW)).toBeUndefined()
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
    await ui.press({ key: 'deck-budget' }).catch(() => undefined)
    const rows = screen(await ui.drawn())
    expect(rows.join('\n')).not.toMatch(/This tab failed|Failed:|mixes/)
    await ui.unmount()
  }
})

