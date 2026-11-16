import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { AgentRow, Budget, Step, TaskItem, Timeline, UiState } from '../../types'
import { empty } from '../model/reduce'
import { initialUi } from '../state'
import { colOf, screen } from './screen.testkit'

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
const NOW = 1_000_000
const SHAPES: Record<string, string> = { timeline: 'timeline-4', ui: 'ui-4' }

type Stored = Map<string, unknown>

function world(on: On, t: Timeline, u: UiState = initialUi): Stored {
  const stored: Stored = new Map()
  stored.set('timeline', t)
  stored.set('ui', u)
  const versions = new Map<string, number>()
  mock.clock(on, { now: NOW })
  mock.env(on, {})
  on('ui.log', () => ({ value: undefined }))
  on('state.get', (_, e) => {
    const key = (e as { key: string }).key
    const v = stored.get(key)
    return { value: { value: v === undefined ? undefined : { shape: SHAPES[key], value: v }, version: versions.get(key) ?? 0 } }
  })
  on('state.set', (_, e) => {
    const w = e as unknown as { key: string; value: { value: unknown } }
    const version = (versions.get(w.key) ?? 0) + 1
    versions.set(w.key, version)
    stored.set(w.key, w.value.value)
    return { value: { isSet: true as const, version } }
  })
  return stored
}

const PANE = (columns: number, bodyRows = 60, isFocused = false) =>
  ({
    plugin: 'mission-control',
    component: 'Pane',
    requestId: 'mission-control',
    props: {
      title: 'Mission Control',
      isFocused,
      bodyColumns: columns,
      placement: 'dock',
      scroll: { offset: 0, bodyRows },
      view: {},
    },
  }) as const

async function mount($: Engine, surface: (typeof SURFACES)[number], columns: number, bodyRows = 60, isFocused = false) {
  return $.ui.mount({ ...PANE(columns, bodyRows, isFocused), surface })
}
const rowsOf = async (ui: Awaited<ReturnType<typeof mount>>): Promise<string[]> => screen(await ui.drawn())

const task = (id: string, subject: string, status: TaskItem['status'], extra: Partial<TaskItem> = {}): TaskItem => ({
  id, subject, status, owner: 'main', updatedAt: NOW - 120_000, ...extra,
})
const step = (id: string, seq: number, label: string, status: Step['status'], extra: Partial<Step> = {}): Step => ({
  id, seq, agent: 'main', tool: 'Bash', label, status, startedAt: NOW - 5000, ...extra,
})
const agent = (id: string, description: string, status: AgentRow['status'] = 'running'): AgentRow => ({
  id, parent: 'main', type: 'Explore', description, status, startedAt: NOW - 60_000, doing: '', stepCount: 1,
})
const main: AgentRow = { ...empty.agents.main! }

const BUDGET: Budget = {
  contextPct: 9,
  windows: [
    { name: 'five_hour', pct: 18, resetsAt: NOW + 3_600_000 },
    { name: 'seven_day', pct: 22, resetsAt: NOW + 86_400_000 },
  ],
  at: NOW,
}

const FOCUS = 'Grouping timeline steps by agent'

// A busy session with one thing waiting: focus, a task, two live agents, a
// budget, a failed step and a kept one.
const busy = (extra: Partial<Timeline> = {}): Timeline => ({
  ...empty,
  seq: 4,
  now: { focus: FOCUS, next: 'Humanise step labels', at: NOW - 20_000 },
  tasks: [task('1', 'Map', 'completed'), task('2', 'Group', 'in_progress', { activeForm: FOCUS }), task('3', 'Humanise step labels', 'pending')],
  agents: { main, a1: agent('a1', 'find every caller of stepRow'), a2: agent('a2', 'write timeline tests') },
  steps: [
    step('s1', 1, 'Bash npm test -- timeline', 'error', { endedAt: NOW - 4000 }),
    step('s2', 2, 'Edit the label helper', 'done', { tool: 'Edit', pin: 'the label helper' }),
    step('s3', 3, 'Bash rm -rf build --dry-run', 'running', { asking: NOW - 30_000 }),
  ],
  budget: BUDGET,
  ...extra,
})

// Every word the fixtures can put on a row, and the labels slim draws.
const WORDS = new Set(
  [
    FOCUS, 'Humanise step labels', 'find every caller of stepRow', 'write timeline tests', 'npm test -- timeline', 'the label helper',
    'rm -rf build --dry-run', 'NEEDS YOU TASKS AGENTS BUDGET LATEST CTX 5H 7D 9% 18% 22% 1/3 2 live ✖ 1 g: chat x: dismiss',
    'Now Tasks Agents Steps Artifacts STEPS ARTIFACTS Map Group Nothing yet. ↵ open esc prompt b: back › ┌ ▍ ▸ ○ ✖ ★ ? ✓ WAITING WORKING IDLE CREW',
  ]
    .join(' ')
    .split(/\s+/),
)

// The last token of a row is a whole word, or a whole word and `…`.
function endsInWord(r: string): boolean {
  const last = r.trim().split(/\s+/).pop() ?? ''
  if (last === '' || /^[━─▁-█▮▯▪▸▫◇◈◆○◉●□▣■△◬▲!?z+0-9]+$/.test(last)) return true
  const bare = last.endsWith('…') ? last.slice(0, -1) : last
  return WORDS.has(bare) || /^\d+%$/.test(bare)
}

// ---------- the cockpit slim (CockpitSlim; the 26-column board is in now.fidelity.test.tsx) ----------

const calm = (extra: Partial<Timeline> = {}): Timeline => busy({ steps: busy().steps.filter(s => s.asking === undefined), ...extra })

// LOOK TEST (rewritten for the cockpit): the compact header, then the stack in Now's order.
test('slim: the compact header, the needs slot, To do, Agents, Budget, Notes in that order, from column 1, at 20 to 31 columns', { options: { look: 'text' } }, async ($, on) => {
  world(on, calm())
  for (const cols of [20, 22, 24, 26, 28, 31]) {
    const ui = await mount($, 'terminal', cols)
    const rows = await rowsOf(ui)
    const at = (s: string): number => rows.findIndex(r => r.startsWith(s))
    const order = [at(' ✓ Nothing needs'), at(' To do'), at(' Agents'), at(' Budget')]
    const shape = rows[0]!.startsWith('┏━━') && rows[1]!.startsWith('  WORKING') && at(' Working on') > 0 && order.every(i => i > 0)
    // On a mismatch the received value is the drawing.
    expect(shape ? 'ok' : [cols, ...rows].join('\n')).toBe('ok')
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    for (const r of rows) expect(r.length).toBeLessThanOrEqual(cols)
    // Nothing in column 0 but the marker (slim's gutter is one column).
    for (const r of rows.slice(2)) expect(r[0] === undefined || r[0] === ' ' || r[0] === '▍' || r[0] === '─' || r[0] === '┏').toBe(true)
    await ui.unmount()
  }
})

test('slim: each title is one plain Button with › in the last content column, and opens its tab or the budget view', async ($, on) => {
  const stored = world(on, calm())
  const ui = await mount($, 'terminal', 26)
  const rows = await rowsOf(ui)
  for (const t of [' To do', ' Agents', ' Budget']) {
    const r = rows.find(x => x.startsWith(t))!
    expect(r.endsWith('›')).toBe(true)
    expect(r.length).toBe(25)
  }
  await ui.press({ key: 'slim-go-tasks' })
  expect((stored.get('ui') as UiState).tab).toBe('tasks')
  await ui.unmount()
})

test('slim: To do is the bar, the current task and the next (wrapped to two lines each), then + n more', { options: { look: 'text' } }, async ($, on) => {
  world(on, calm({ tasks: [task('1', 'Map', 'completed'), task('2', 'Group the timeline steps by the agent that ran them', 'in_progress'), task('3', 'Humanise step labels', 'pending'), task('4', 'Ship', 'pending'), task('5', 'Tell', 'pending')] }))
  const ui = await mount($, 'terminal', 26)
  const rows = await rowsOf(ui)
  const head = rows.findIndex(r => r.startsWith(' To do'))
  expect(rows[head]).toContain('1 of 5')
  expect(rows[head + 1]!.trim()).toMatch(/^[━ ]+$/)
  expect(rows[head + 3]!.startsWith(' ▸ Group the timeline')).toBe(true)
  expect(rows[head + 4]!.startsWith('   ')).toBe(true)
  expect(rows[head + 5]!.startsWith(' ○ Humanise step labels')).toBe(true)
  expect(rows[head + 6]!.trim()).toBe('+ 2 more')
  await ui.unmount()
})

test('slim: a need takes the slot under the header: amber head and count, who asks, the command wrapped, the words in place of a button (R3), autoFocus', async ($, on) => {
  world(on, busy())
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE(24, 60, true), props: { ...PANE(24, 60, true).props, isPromptCovered: true }, surface })
    const rows = await rowsOf(ui)
    const head = rows.findIndex(r => r.startsWith(' Needs you'))
    // The slot is the row after the blank under the sill, as on Now.
    // (lintel, pill, blank, kicker, two headline lines, sill, blank: row 8)
    expect(head === 8 ? 'ok' : [surface, ...rows].join('\n')).toBe('ok')
    expect(rows[head]!.endsWith('1')).toBe(true)
    const marked = rows.slice(head + 1).filter(r => r.startsWith('▍ '))
    expect(marked[0]).toContain('asks to run')
    expect(marked.some(r => r.includes('rm -rf build'))).toBe(true)
    expect(marked[marked.length - 1]).toContain('esc  to the prompt')
    const found = await ui.findAll({ type: 'Text' })
    expect(found.filter(f => f.text === 'Needs you').every(f => (f.props as { color?: string }).color === 'warning')).toBe(true)
    expect((await ui.find({ key: 'open-asking:s3' }))?.props).toMatchObject({ autoFocus: true })
    // No `x` on a need (owner ruling 4), no Button pretending to hand the keys back (R3).
    expect((await ui.findAll({ type: 'Button' })).some(b => (b.props as { hotkey?: string }).hotkey === 'x')).toBe(false)
    expect(rows.join(' ')).not.toContain('go to prompt')
    await ui.unmount()
  }
})

test('slim: a short pane drops whole parts from the bottom: Notes, Budget, an agent, the agents, To do\'s tasks; Needs you stays', { options: { look: 'text' } }, async ($, on) => {
  world(on, busy({ notes: [{ text: 'keep it', agent: 'main', at: NOW }] }))
  const at = async (bodyRows: number): Promise<string[]> => {
    const ui = await $.ui.mount({ ...PANE(26, bodyRows, true), props: { ...PANE(26, bodyRows, true).props, isPromptCovered: true }, surface: 'terminal' })
    const rows = screen(await ui.drawn())
    await ui.unmount()
    return rows
  }
  const tall = await at(60)
  expect(tall.some(r => r.startsWith(' Budget'))).toBe(true)
  const short = await at(30)
  expect(short.some(r => r.startsWith(' Needs you'))).toBe(true)
  expect(short.some(r => r.startsWith(' To do'))).toBe(true)
  expect(short.some(r => r.startsWith(' Notes'))).toBe(false)
  expect(short.length).toBeLessThanOrEqual(30)
})

test('slim: the footer sits on the last row while the pane has the keys, the keys in the accent (R28)', async ($, on) => {
  world(on, calm())
  const plain = await mount($, 'terminal', 26, 46)
  expect((await rowsOf(plain)).some(r => r.includes('esc prompt'))).toBe(false)
  await plain.unmount()
  const ui = await mount($, 'terminal', 26, 46, true)
  const rows = await rowsOf(ui)
  expect(rows.length).toBe(46)
  expect(rows[45]).toBe(' ↵ open   esc prompt')
  const found = await ui.findAll({ type: 'Text' })
  expect(found.filter(f => f.text === 'esc').every(f => (f.props as { color?: string }).color === 'suggestion')).toBe(true)
  await ui.unmount()
})

test('pressing a label opens that tab in slim form with b: back on its first row', async ($, on) => {
  const stored = world(on, busy())
  for (const surface of SURFACES) {
    const ui = await mount($, surface, 24)
    await ui.press({ key: 'slim-go-agents' })
    expect((stored.get('ui') as UiState).tab).toBe('agents')
    await ui.unmount()
    const open = await mount($, surface, 24)
    const rows = await rowsOf(open)
    expect(rows[0]).toContain('b: back')
    expect(rows.some(r => r === ' Agents')).toBe(true)
    // R3-B I6: meaning changed. A slim agent row said only the job ("find every caller…"); it now says the agent's name first ("Explorer find every…") so the row tells who and what.
    expect(rows.some(r => colOf(r, 'Explorer find') === 4)).toBe(true)
    for (const r of rows) expect(r.length).toBeLessThanOrEqual(24)
    expect(await open.find({ key: 'tab-overview' })).toBe(undefined)
    await open.press({ key: 'slim-back' })
    expect((stored.get('ui') as UiState).tab).toBe('overview')
    await open.unmount()
    const back = await mount($, surface, 24)
    expect((await rowsOf(back)).some(r => r.startsWith(' Budget'))).toBe(true)
    await back.unmount()
  }
})

test('every tab has a slim list that fits', async ($, on) => {
  const stored = world(on, busy({ artifacts: [{ id: 'r1', kind: 'page', title: 'Rate limit design for everyone', agent: 'main', count: 1, updatedAt: NOW }] }))
  for (const tab of ['tasks', 'agents', 'timeline', 'artifacts'] as const) {
    stored.set('ui', { ...initialUi, tab })
    const ui = await mount($, 'terminal', 22)
    const rows = await rowsOf(ui)
    expect(rows[0]).toContain('b: back')
    expect(rows.length >= 3).toBe(true)
    for (const r of rows) expect(r.length).toBeLessThanOrEqual(22)
    expect(rows.filter(r => !(endsInWord(r) || tab === 'artifacts'))).toEqual([])
    await ui.unmount()
  }
})

test('pressing BUDGET opens the budget view with b: back, and back returns', async ($, on) => {
  world(on, busy())
  const ui = await mount($, 'terminal', 24)
  await ui.press({ key: 'slim-go-budget' })
  const rows = await rowsOf(ui)
  expect(rows[0]).toContain('b: back')
  // BEHAVIOUR CHANGE (task C3b): was the reset words at 8 or 26; the cockpit's narrow budget is a word, a figure and a full-width bar per window, then the Windows rows.
  expect(rows.some(r => r.includes('5 hours') && r.includes('%'))).toBe(true)
  expect(rows.some(r => /^ *━{10,}$/.test(r))).toBe(true)
  for (const r of rows) expect(r.length).toBeLessThanOrEqual(24)
  await ui.press({ key: 'budget-back' })
  expect((await rowsOf(ui)).some(r => r.startsWith(' To do'))).toBe(true)
  await ui.unmount()
})
