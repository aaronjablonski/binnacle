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
    'STEPS ARTIFACTS Map Group Nothing yet. ↵ open esc prompt b: back › ┌ ▍ ▸ ○ ✖ ★ ? ✓ WAITING WORKING IDLE CREW',
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

// LOOK TEST (edited for Rich): the Neo text form, drawn where there is no Raster and with the look option on text; the rich form is tested in rich2.test.tsx.
test('text form: slim at 22: a left-only bracket holds the state pill and the focus wrapped to 2 lines, and every section label is drawn below it', { options: { look: 'text' } }, async ($, on) => {
  world(on, busy())
  for (const surface of SURFACES) {
    const ui = await mount($, surface, 22)
    const rows = await rowsOf(ui)
    // busy() has an ask waiting 30 s: the pill says so and the bracket is warning.
    expect(rows[0]).toBe('┏  WAITING')
    expect(rows[1]).toBe('┃ Grouping timeline')
    expect(rows[2]).toBe('┗ steps by agent')
    expect(rows.slice(0, 3).some(r => r.includes('┓') || r.includes('┛'))).toBe(false)
    const found = await ui.findAll({ type: 'Text' })
    expect(found.find(f => f.text === ' WAITING ' && (f.props as { backgroundColor?: string }).backgroundColor !== undefined)?.props).toMatchObject({ backgroundColor: 'warning', color: 'inverseText', bold: true })
    expect((found.find(f => f.text === '┏ ')?.props as { color?: string }).color).toBe('warning')
    const at = ['NEEDS YOU', 'CREW', 'TASKS', 'BUDGET', 'LATEST'].map(l => rows.findIndex(r => r.startsWith(`┌ ${l}`)))
    expect(at.every(i => i > 2)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    // No tab bar: nothing to press but the slim parts.
    expect(await ui.find({ key: 'tab-overview' })).toBe(undefined)
    expect(rows.some(r => r.includes('1: '))).toBe(false)
    // The data is there: no large empty area.
    expect(rows.length > 14).toBe(true)
    expect(rows.filter(r => r === '').length <= 6).toBe(true)
    await ui.unmount()
  }
})

// LOOK TEST (edited for Rich): the Neo text form, drawn where there is no Raster and with the look option on text; the rich form is tested in rich2.test.tsx.
test('text form: the slim pill is WORKING in the accent while nothing waits, with the bracket in the accent', { options: { look: 'text' } }, async ($, on) => {
  world(on, busy({ steps: [step('s1', 1, 'Bash npm test -- timeline', 'error', { endedAt: NOW - 4000 })] }))
  const ui = await mount($, 'terminal', 24)
  const rows = await rowsOf(ui)
  expect(rows[0]).toBe('┏  WORKING')
  const found = await ui.findAll({ type: 'Text' })
  expect(found.find(f => f.text === ' WORKING ' && (f.props as { backgroundColor?: string }).backgroundColor !== undefined)?.props).toMatchObject({ backgroundColor: 'suggestion', color: 'inverseText' })
  expect((found.find(f => f.text === '┏ ')?.props as { color?: string }).color).toBe('suggestion')
  await ui.unmount()
})

// LOOK TEST (edited for Rich): the Neo text form, drawn where there is no Raster and with the look option on text; the rich form is tested in rich2.test.tsx.
test('text form: slim grid: a label row has ┌ at 0, the label at 2, the value at 14 and › in the last column', { options: { look: 'text' } }, async ($, on) => {
  world(on, busy())
  for (const surface of SURFACES) {
    for (const cols of [24, 28]) {
      const ui = await mount($, surface, cols)
      const rows = await rowsOf(ui)
      for (const [label, value] of [['TASKS', '1/3'], ['CREW', '2 live'], ['NEEDS YOU', '1'], ['LATEST', '✖ 1']] as const) {
        const r = rows.find(x => x.startsWith(`┌ ${label}`))!
        expect(colOf(r, label)).toBe(2)
        expect(colOf(r, value)).toBe(14)
        expect(r.length).toBe(cols)
        expect(r.endsWith('›')).toBe(true)
      }
      // Budget rows: label 2, value 8, a 10-cell bar at 14.
      const ctx = rows.find(r => r.startsWith('  CTX'))!
      expect(colOf(ctx, '9%')).toBe(8)
      expect(ctx.slice(14, 24)).toMatch(/^[▮▯]{10}$/)
      expect(ctx.slice(14, 24).startsWith('▮')).toBe(true)
      await ui.unmount()
    }
    // Under 24 the value drops when it would touch › and the bar goes: bars are 10 or 22 cells, never in between.
    const narrow = await mount($, surface, 20)
    const rows = await rowsOf(narrow)
    const agents = rows.find(r => r.startsWith('┌ CREW'))!
    expect(agents).not.toContain('live')
    expect(agents.length).toBe(20)
    const ctx = rows.find(r => r.startsWith('  CTX'))!
    expect(ctx.slice(14)).toBe('')
    expect(colOf(ctx, '9%')).toBe(8)
    await narrow.unmount()
  }
})

// LOOK TEST (edited for Rich): the Neo text form, drawn where there is no Raster and with the look option on text; the rich form is tested in rich2.test.tsx.
test('text form: slim CREW is one row of pods and the live names with their hulls, at 20, 24 and 28', { options: { look: 'text' } }, async ($, on) => {
  world(on, busy())
  for (const cols of [20, 24, 28]) {
    const ui = await mount($, 'terminal', cols)
    const rows = await rowsOf(ui)
    const head = rows.findIndex(r => r.startsWith('┌ CREW'))
    // the lead (asking, so it carries a ?), then the live agents: a pitch of 3 from column 2.
    expect(rows[head + 1]!.slice(2, 9)).toBe('◈? ◉  ◉')
    expect(colOf(rows[head + 2], '◉')).toBe(2)
    expect(colOf(rows[head + 2], 'find')).toBe(4)
    expect(colOf(rows[head + 3], '◉')).toBe(2)
    for (const r of rows) expect(r.length).toBeLessThanOrEqual(cols)
    await ui.unmount()
  }
})

test('slim CREW takes as many pods as fit and then +n', async ($, on) => {
  const many: Record<string, AgentRow> = { main }
  for (let i = 1; i <= 9; i++) many[`a${i}`] = agent(`a${i}`, `agent number ${i}`)
  world(on, busy({ agents: many, steps: [] }))
  const ui = await mount($, 'terminal', 20)
  const rows = await rowsOf(ui)
  const crew = rows[rows.findIndex(r => r.startsWith('┌ CREW')) + 1]!
  expect(crew.length).toBeLessThanOrEqual(20)
  expect(crew).toMatch(/\+\d$/)
  await ui.unmount()
})

test('with nothing waiting there is no NEEDS YOU, and the stack starts at CREW under the head bracket', async ($, on) => {
  world(on, busy({ steps: [step('s1', 1, 'Bash npm test -- timeline', 'error', { endedAt: NOW - 4000 })] }))
  const ui = await mount($, 'terminal', 24)
  const rows = await rowsOf(ui)
  expect(rows.some(r => r.includes('NEEDS YOU'))).toBe(false)
  // pill, two focus lines, a blank, then the first block.
  expect(rows.findIndex(r => r.startsWith('┌ CREW'))).toBe(4)
  await ui.unmount()
})

// LOOK TEST (edited for Rich): the Neo text form, drawn where there is no Raster and with the look option on text; the rich form is tested in rich2.test.tsx.
test('text form: TASKS shows the pips, then the next task when the current one is the focus, else the current one', { options: { look: 'text' } }, async ($, on) => {
  const stored = world(on, busy())
  const a = await mount($, 'terminal', 28)
  let rows = await rowsOf(a)
  const t = rows.findIndex(r => r.startsWith('┌ TASKS'))
  expect(colOf(rows[t + 1], '▪▸▫')).toBe(2)
  expect(colOf(rows[t + 2], '▫')).toBe(2)
  expect(colOf(rows[t + 2], 'Humanise step labels')).toBe(4)
  await a.unmount()
  stored.set('timeline', busy({ now: { focus: 'Something else entirely', at: NOW }, tasks: [task('2', 'Group', 'in_progress')] }))
  const b = await mount($, 'terminal', 28)
  rows = await rowsOf(b)
  const t2 = rows.findIndex(r => r.startsWith('┌ TASKS'))
  expect(colOf(rows[t2 + 1], '▸')).toBe(2)
  expect(colOf(rows[t2 + 2], '▸')).toBe(2)
  expect(colOf(rows[t2 + 2], 'Group')).toBe(4)
  await b.unmount()
})

// LOOK TEST (edited for Rich): the Neo text form, drawn where there is no Raster and with the look option on text; the rich form is tested in rich2.test.tsx.
test('text form: slim pips over the limit are a bar: 10 cells at 20 columns, 22 where they fit', { options: { look: 'text' } }, async ($, on) => {
  const tasks = Array.from({ length: 30 }, (_, i) => task(String(i), `Task ${i}`, i < 12 ? 'completed' : 'pending'))
  world(on, busy({ tasks }))
  for (const cols of [20, 24, 28]) {
    const ui = await mount($, 'terminal', cols)
    const rows = await rowsOf(ui)
    const row = rows[rows.findIndex(r => r.startsWith('┌ TASKS')) + 1]!
    expect(row.slice(2)).toMatch(cols === 20 ? /^[▮▯]{10}$/ : /^[▮▯]{22}$/)
    await ui.unmount()
  }
})

// LOOK TEST (edited for Rich): the Neo text form, drawn where there is no Raster and with the look option on text; the rich form is tested in rich2.test.tsx.
test('text form: CREW lists up to 3 live names, LATEST the newest error and the newest kept step', { options: { look: 'text' } }, async ($, on) => {
  world(on, busy({ agents: { main, a1: agent('a1', 'find every caller of stepRow'), a2: agent('a2', 'write timeline tests'), a3: agent('a3', 'one'), a4: agent('a4', 'two'), a5: agent('a5', 'old one', 'done') } }))
  const ui = await mount($, 'terminal', 28)
  const rows = await rowsOf(ui)
  const a = rows.findIndex(r => r.startsWith('┌ CREW'))
  expect(colOf(rows[a], '4 live')).toBe(14)
  expect(rows.slice(a + 2, a + 5).every(r => colOf(r, '◉') === 2)).toBe(true)
  expect(rows[a + 5]).toBe('')
  const l = rows.findIndex(r => r.startsWith('┌ LATEST'))
  expect(colOf(rows[l + 1], '✖')).toBe(2)
  expect(colOf(rows[l + 1], 'npm test -- timeline')).toBe(4)
  expect(colOf(rows[l + 2], '★')).toBe(2)
  expect(colOf(rows[l + 2], 'the label helper')).toBe(4)
  const star = (await ui.findAll({ type: 'Text' })).find(f => f.text === '★')
  expect((star?.props as { color?: string }).color).toBe('claude')
  await ui.unmount()
})

// LOOK TEST (edited for Rich): the Neo text form, drawn where there is no Raster and with the look option on text; the rich form is tested in rich2.test.tsx.
test('text form: an empty session is one idle pill and line and nothing else but a hint', { options: { look: 'text' } }, async ($, on) => {
  world(on, empty)
  const ui = await mount($, 'terminal', 24)
  const rows = await rowsOf(ui)
  expect(rows[0]).toBe('┏  IDLE')
  expect(rows[1]).toBe('┃ Idle. Nothing running')
  expect(rows[2]).toBe('┗ yet.')
  expect(rows.some(r => r.startsWith('┌ '))).toBe(false)
  for (const r of rows) expect(r.length).toBeLessThanOrEqual(24)
  await ui.unmount()
})


// LOOK TEST (edited for Rich): the Neo text form, drawn where there is no Raster and with the look option on text; the rich form is tested in rich2.test.tsx.
test('text form: slim at 20, 24 and 28: no row is wider than the pane and none ends inside a word', { options: { look: 'text' } }, async ($, on) => {
  world(on, busy())
  for (const surface of SURFACES) {
    for (const cols of [20, 24, 28]) {
      const ui = await mount($, surface, cols, 60, true)
      const rows = await rowsOf(ui)
      for (const r of rows) {
        expect(r.length).toBeLessThanOrEqual(cols)
        expect(endsInWord(r)).toBe(true)
      }
      const found = [...(await ui.findAll({ type: 'Text' })), ...(await ui.findAll({ type: 'Button' }))]
      for (const f of found) expect((f.text ?? '').length).toBeLessThanOrEqual(cols)
      await ui.unmount()
    }
  }
})

test('NEEDS YOU is first and in warning, its first item focused with g: chat and x: dismiss', async ($, on) => {
  world(on, busy())
  for (const surface of SURFACES) {
    const ui = await mount($, surface, 24)
    const rows = await rowsOf(ui)
    const head = rows.findIndex(r => r.startsWith('┌ NEEDS YOU'))
    expect(head).toBe(4)
    const found = await ui.findAll({ type: 'Text' })
    const color = (t: string): string | undefined => (found.find(f => f.text === t)?.props as { color?: string } | undefined)?.color
    expect(color('┌')).toBe('warning')
    expect(color('NEEDS YOU')).toBe('warning')
    expect(colOf(rows[head + 1], '?')).toBe(2)
    // The command wraps to a second line instead of being cut.
    expect(colOf(rows[head + 1], 'rm -rf build')).toBe(4)
    expect(colOf(rows[head + 2], '--dry-run')).toBe(4)
    expect(colOf(rows[head + 3], 'g: chat')).toBe(4)
    expect(colOf(rows[head + 3], 'x: dismiss')).toBe(14)
    expect((await ui.find({ key: 'open-asking:s3' }))?.props).toMatchObject({ autoFocus: true })
    await ui.unmount()
    // At 20 columns the second action does not fit and is left off.
    const narrow = await mount($, surface, 20)
    const r20 = await rowsOf(narrow)
    expect(r20.some(r => r.includes('g: chat'))).toBe(true)
    expect(r20.some(r => r.includes('x: dismiss'))).toBe(false)
    await narrow.unmount()
  }
})

// LOOK TEST (edited for Rich): the Neo text form, drawn where there is no Raster and with the look option on text; the rich form is tested in rich2.test.tsx.
test('text form: a name whose first word is wider than the room is dropped, never cut inside the word', { options: { look: 'text' } }, async ($, on) => {
  const long = 'supercalifragilisticexpialidocious'
  world(on, busy({ agents: { main, a1: agent('a1', long), a2: agent('a2', 'write timeline tests') } }))
  const ui = await mount($, 'terminal', 20)
  const rows = await rowsOf(ui)
  expect(rows.some(r => r.includes('supercal'))).toBe(false)
  expect(rows.some(r => r.includes('write timeline'))).toBe(true)
  await ui.unmount()
})

// LOOK TEST (edited for Rich): the Neo text form, drawn where there is no Raster and with the look option on text; the rich form is tested in rich2.test.tsx.
test('text form: a short pane drops whole parts from the bottom: LATEST, then 7D, then the crew names', { options: { look: 'text' } }, async ($, on) => {
  world(on, busy())
  const rowsAt = async (bodyRows: number): Promise<string[]> => {
    const ui = await mount($, 'terminal', 24, bodyRows)
    const rows = await rowsOf(ui)
    await ui.unmount()
    return rows
  }
  const full = await rowsAt(60)
  expect(full.some(r => r.startsWith('┌ LATEST'))).toBe(true)
  expect(full.some(r => r.startsWith('  7D'))).toBe(true)
  const one = await rowsAt(full.length - 1)
  expect(one.some(r => r.startsWith('┌ LATEST'))).toBe(false)
  expect(one.some(r => r.startsWith('  7D'))).toBe(true)
  expect(one.length <= full.length - 1).toBe(true)
  const two = await rowsAt(one.length - 1)
  expect(two.some(r => r.startsWith('  7D'))).toBe(false)
  expect(two.some(r => r.startsWith('  5H'))).toBe(true)
  expect(two.some(r => r.includes('find every caller'))).toBe(true)
  const three = await rowsAt(two.length - 1)
  expect(three.some(r => r.includes('find every caller'))).toBe(false)
  expect(three.some(r => r.startsWith('┌ CREW'))).toBe(true)
  expect(three.some(r => r.startsWith('┌ NEEDS YOU'))).toBe(true)
})

test('the footer is ↵ open and esc prompt, only while the pane has the focus', async ($, on) => {
  world(on, busy())
  const plain = await mount($, 'terminal', 28)
  expect((await rowsOf(plain)).some(r => r.includes('esc prompt'))).toBe(false)
  await plain.unmount()
  const ui = await mount($, 'terminal', 28, 60, true)
  const rows = await rowsOf(ui)
  expect(rows[rows.length - 1]).toBe('  ↵ open   esc prompt')
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
    expect(rows.some(r => r.startsWith('┌ AGENTS'))).toBe(true)
    expect(rows.some(r => colOf(r, 'find every caller of stepRow') === 4 || colOf(r, 'find every caller') === 4)).toBe(true)
    for (const r of rows) expect(r.length).toBeLessThanOrEqual(24)
    expect(await open.find({ key: 'tab-overview' })).toBe(undefined)
    await open.press({ key: 'slim-back' })
    expect((stored.get('ui') as UiState).tab).toBe('overview')
    await open.unmount()
    const back = await mount($, surface, 24)
    expect((await rowsOf(back)).some(r => r.startsWith('┌ BUDGET'))).toBe(true)
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
  expect(rows.some(r => colOf(r, 'resets in 1h00') === 8 || colOf(r, 'resets in 1h00') === 26)).toBe(true)
  for (const r of rows) expect(r.length).toBeLessThanOrEqual(24)
  await ui.press({ key: 'budget-back' })
  expect((await rowsOf(ui)).some(r => r.startsWith('┌ LATEST'))).toBe(true)
  await ui.unmount()
})
