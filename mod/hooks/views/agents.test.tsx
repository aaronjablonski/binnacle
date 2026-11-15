import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { AgentRow, Run, Step, TaskItem, Timeline, UiState } from '../../types'
import { empty } from '../model/reduce'
import { roles } from '../model/meter'
import { backTo, colOf, keepLog, LOGS, screen } from './screen.testkit'

/** The text look on every surface: the layout the Raster-free tables keep (hull glyphs, one row each). */
const TEXT = { options: { look: 'text' } } as const
const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
const NOW = 1_000_000
const SHAPES: Record<string, string> = { timeline: 'timeline-4', ui: 'ui-4' }

type Stored = Map<string, unknown>

// The engine's $.state beneath the mod: seeded with a timeline, remembering
// every write so a press can be read back.
function world(on: On, t: Timeline, u?: UiState): { stored: Stored; clock: MockClock } {
  const stored: Stored = new Map()
  stored.set('timeline', t)
  if (u) stored.set('ui', u)
  const versions = new Map<string, number>()
  const clock = mock.clock(on, { now: NOW })
  LOGS.length = 0
  on('ui.log', keepLog)
  on('state.get', (_, e) => {
    const key = (e as { key: string }).key
    const v = stored.get(key)
    return {
      value: {
        value: v === undefined ? undefined : { shape: SHAPES[key], value: v },
        version: versions.get(key) ?? 0,
      },
    }
  })
  on('state.set', (_, e) => {
    const w = e as unknown as { key: string; value: { value: unknown } }
    const version = (versions.get(w.key) ?? 0) + 1
    versions.set(w.key, version)
    stored.set(w.key, w.value.value)
    return { value: { isSet: true as const, version } }
  })
  return { stored, clock }
}

const seed = (on: On, t: Timeline, u?: UiState): Stored => world(on, t, u).stored


const PANE = (columns: number, focused = false) =>
  ({
    plugin: 'mission-control',
    component: 'Pane',
    requestId: 'mission-control',
    props: {
      title: 'Mission Control',
      isFocused: focused,
      bodyColumns: columns,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  }) as const

const task = (id: string, subject: string, status: TaskItem['status'], extra: Partial<TaskItem> = {}): TaskItem => ({
  id,
  subject,
  status,
  owner: 'main',
  updatedAt: NOW - 120_000,
  ...extra,
})
const step = (id: string, seq: number, label: string, status: Step['status'], extra: Partial<Step> = {}): Step => ({
  id,
  seq,
  agent: 'main',
  tool: 'Edit',
  label,
  status,
  startedAt: NOW - 5000,
  ...extra,
})
const agent = (
  id: string,
  type: string,
  description: string,
  doing: string,
  status: AgentRow['status'] = 'running',
): AgentRow => ({
  id,
  parent: 'main',
  type,
  description,
  status,
  startedAt: NOW - 60_000,
  doing,
  stepCount: 1,
})

const main: AgentRow = { ...empty.agents.main! }

async function mount($: Engine, surface: (typeof SURFACES)[number], columns = 62, focused = false) {
  return $.ui.mount({ ...PANE(columns, focused), surface })
}

const texts = async (ui: Awaited<ReturnType<typeof mount>>): Promise<string[]> => {
  const found = await ui.findAll({ type: 'Text' })
  return found.map(f => f.text ?? '')
}

const AGENTS_UI: UiState = {
  tab: 'agents', filter: { kind: 'all' }, agentsMode: 'list', folded: [], openTurns: [],
  dismissed: [], query: '', runningOnly: false, notified: [], toasted: [], slim: false,
}
const run: Run = { runId: 'r1', name: 'review-changes', parent: 'main', startedAt: NOW - 90_000 }
const wf = (id: string, index: number, description: string, doing: string, status: AgentRow['status']): AgentRow => ({
  ...agent(id, 'workflow-subagent', description, doing, status),
  runId: 'r1',
  agentIndex: index,
})
const withMainWork: AgentRow = { ...main, stepCount: 14, doing: 'Edit src/index.ts' }
const busy = (t: Partial<Timeline>): Timeline => ({
  ...empty,
  steps: [step('s1', 1, 'Edit a.ts', 'done', { startedAt: NOW - 360_000 })],
  ...t,
})

// Replaces what the world holds, for the next surface.
function put(stored: Stored, t: Timeline, u: UiState): void {
  stored.clear()
  stored.set('timeline', t)
  stored.set('ui', u)
}


type Mounted = Awaited<ReturnType<typeof mount>>
type Found = Awaited<ReturnType<Mounted['findAll']>>[number]
const propsOf = (f: Found | undefined): { color?: string; dimColor?: boolean; bold?: boolean } =>
  (f?.props ?? {}) as { color?: string; dimColor?: boolean; bold?: boolean }

const rows = async (ui: Mounted): Promise<string[]> => screen(await ui.drawn())
const rowWith = (all: string[], text: string): string => all.find(r => r.includes(text)) ?? ''

/** Every word of a MODELS row is a rail, the label, a whole model name, a token count or a bar: nothing cut mid-word. */
const wholeModelTokens = (line: string): boolean =>
  line
    .split(/\s+/)
    .filter(w => w !== '')
    .every(w => /^[┏┃┗┓┛]+$/.test(w) || w === 'MODELS' || /^(opus|sonnet|haiku)$/.test(w) || /^\d+(\.\d+)?[kM]?$/.test(w) || /^[▮▯]+$/.test(w))
const idxWith = (all: string[], text: string): number => all.findIndex(r => r.includes(text))

const model = (id: string, tokensIn: number, extra: Partial<AgentRow> = {}): Partial<AgentRow> => ({ model: id, tokensIn, tokensOut: 0, ...extra })

const MIXED = busy({
  runs: { r1: run },
  agents: {
    main: { ...withMainWork, ...model('claude-opus-5', 993_000) },
    a1: { ...agent('a1', 'Explore', 'find callers', 'Grep upload'), ...model('claude-sonnet-5', 72_000) },
    a2: {
      ...agent('a2', 'Explore', 'count ts files', 'done it', 'done'),
      ...model('claude-haiku-5', 106_000),
      endedAt: NOW - 8000,
      stepCount: 2,
      result: '17 TypeScript files under mod/',
      spawnStep: 'toolu_a2',
    },
    a3: { ...agent('a3', 'Explore', 'run plugin tests', 'oops', 'error'), ...model('claude-sonnet-5', 81_000), endedAt: NOW - 30_000 },
    w1: wf('w1', 0, 'read:agent-1', 'Read a.ts', 'done'),
    w2: wf('w2', 1, 'read:agent-2', 'Read b.ts', 'running'),
  },
})

test('LOOK (text form): three columns at 62: hull 2, name 4, tokens 38, time 50', TEXT, async ($, on) => {
  seed(on, MIXED, AGENTS_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface, 62)
    const all = await rows(ui)
    const a1 = rowWith(all, 'find callers')
    expect(colOf(a1, '◉')).toBe(2)
    expect(colOf(a1, 'find callers')).toBe(4)
    expect(colOf(a1, '72k')).toBe(38)
    expect(colOf(a1, '1m')).toBe(50)
    const head = rowWith(all, '┌ AGENTS')
    expect(colOf(head, '┌')).toBe(0)
    expect(colOf(head, 'AGENTS')).toBe(2)
    expect(colOf(head, 'tokens')).toBe(38)
    expect(colOf(head, 'time')).toBe(50)
    const mainRow = rowWith(all, '◈ main')
    expect(colOf(mainRow, '◈')).toBe(2)
    expect(colOf(mainRow, 'main')).toBe(4)
    expect(colOf(mainRow, '993k')).toBe(38)
    await ui.unmount()
  }
})

test('main first, then running, failed, done; workflow agents are not in the list', async ($, on) => {
  seed(on, MIXED, AGENTS_UI)
  const ui = await mount($, 'terminal')
  const all = await rows(ui)
  const order = ['main', 'find callers', 'run plugin tests', 'count ts files'].map(x => idxWith(all.slice(idxWith(all, '┌ AGENTS')), x))
  expect(order.every(i => i >= 0)).toBe(true)
  expect([...order].sort((a, b) => a - b)).toEqual(order)
  expect(all.join('\n')).not.toContain('read:agent-1')
  await ui.unmount()
})

test('LOOK (text form): hulls via podOf: ◈ main in claude, ◉ live scout in the accent, ○ failed in error, ● done dim', TEXT, async ($, on) => {
  seed(on, MIXED, AGENTS_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const found = await ui.findAll({ type: 'Text' })
    expect(found.filter(f => f.text === '◈').map(f => propsOf(f).color)).toContain('claude')
    expect(found.filter(f => f.text === '◉').map(f => propsOf(f).color)).toContain('suggestion')
    expect(found.filter(f => f.text === '○').map(f => propsOf(f).color)).toContain('error')
    const done = found.filter(f => f.text === '●')
    expect(done.length > 0).toBe(true)
    for (const d of done) {
      expect(propsOf(d).dimColor).toBe(true)
      expect(propsOf(d).color).toBeUndefined()
    }
    const out = (await rows(ui)).join('\n')
    for (const old of ['▸ find', '✓ count', '✖ run plugin', '◆ main']) expect(out).not.toContain(old)
    await ui.unmount()
  }
})

test('LOOK: a failed agent carries ! in the gutter in error; a live one carries nothing', async ($, on) => {
  seed(on, MIXED, AGENTS_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const all = await rows(ui)
    expect(colOf(rowWith(all, 'run plugin tests'), '!')).toBe(0)
    expect(rowWith(all, 'find callers').startsWith(' ')).toBe(true)
    const bangs = (await ui.findAll({ type: 'Text' })).filter(f => (f.text ?? '').startsWith('!'))
    expect(bangs.map(b => propsOf(b).color)).toContain('error')
    await ui.unmount()
  }
})

test('no └ answer line and no View line; the rows carry no doing text', async ($, on) => {
  seed(on, MIXED, AGENTS_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const out = (await rows(ui)).join('\n')
    expect(out).not.toContain('└')
    expect(out).not.toContain('View')
    expect(out).not.toContain('Grep upload')
    expect(await ui.find({ key: 'view-a1' })).toBeUndefined()
    await ui.unmount()
  }
})

test('LOOK: the toggle row is l: List, t: Map and r: Running on the first three cells', async ($, on) => {
  seed(on, MIXED, AGENTS_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const toggle = rowWith(await rows(ui), 'l: List')
    expect(colOf(toggle, 'l: List')).toBe(2)
    expect(colOf(toggle, 't: Map')).toBe(14)
    expect(colOf(toggle, 'r: Running')).toBe(26)
    // the open mode is bold, the others dim
    expect(propsOf(await ui.find({ key: 'mode-list' })).dimColor).toBeFalsy()
    expect(propsOf(await ui.find({ key: 'mode-tree' })).dimColor).toBe(true)
    await ui.unmount()
  }
})

test('LOOK: at 32 columns the toggle row is l: List  t: Map  r: Run and fits', async ($, on) => {
  seed(on, MIXED, AGENTS_UI)
  const ui = await mount($, 'terminal', 32)
  const toggle = rowWith(await rows(ui), 'l: List')
  expect(toggle).toBe('  l: List  t: Map   r: Run')
  await ui.unmount()
})

test('pressing Map and Running write ui.agentsMode and ui.runningOnly', async ($, on) => {
  const stored = seed(on, empty, AGENTS_UI)
  for (const surface of SURFACES) {
    put(stored, MIXED, AGENTS_UI)
    const ui = await mount($, surface)
    await ui.press({ key: 'mode-tree' })
    expect((stored.get('ui') as UiState).agentsMode).toBe('tree')
    await ui.press({ key: 'mode-running' })
    expect((stored.get('ui') as UiState).runningOnly).toBe(true)
    await ui.unmount()
  }
})

test('r hides finished agents from the list and drops runs with nothing running', async ($, on) => {
  const stored = seed(on, MIXED, { ...AGENTS_UI, runningOnly: true })
  const ui = await mount($, 'terminal')
  const out = (await rows(ui)).join('\n')
  expect(out).toContain('find callers')
  expect(out).not.toContain('count ts files')
  expect(out).not.toContain('run plugin tests')
  expect(out).toContain('review-changes')
  await ui.unmount()
  put(stored, busy({ runs: { r1: run }, agents: { main, w1: wf('w1', 0, 'read:agent-1', 'x', 'done') } }), { ...AGENTS_UI, runningOnly: true })
  const again = await mount($, 'terminal')
  expect((await rows(again)).join('\n')).not.toContain('review-changes')
  await again.unmount()
})

test('LOOK (text form): the deck: CREW, ROLES, MODELS between rails at 0 and 61, labels at 2, gauges at 14', TEXT, async ($, on) => {
  seed(on, MIXED, AGENTS_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface, 62)
    const all = await rows(ui)
    const crew = rowWith(all, 'CREW')
    const roles = rowWith(all, 'ROLES')
    const models = rowWith(all, 'MODELS')
    expect([crew, roles, models].map(r => r.length)).toEqual([62, 62, 62])
    expect([crew[0], roles[0], models[0]]).toEqual(['┏', '┃', '┗'])
    expect([crew[61], roles[61], models[61]]).toEqual(['┓', '┃', '┛'])
    expect([colOf(crew, 'CREW'), colOf(roles, 'ROLES'), colOf(models, 'MODELS')]).toEqual([2, 2, 2])
    // the crew: main, live, failed (with its !), done, at a pitch of 3 from 14
    expect(crew.slice(14, 14 + 16)).toBe('◈  ◉  ▣  ○! ●  ■')
    expect(colOf(crew, '2 live')).toBe(38)
    expect(colOf(crew, '1 failed')).toBe(50)
    // the roles legend: hull, role, count on 14, 26, 38, 50
    expect([colOf(roles, '◇ lead 1'), colOf(roles, '○ scout 3'), colOf(roles, '□ build 2'), colOf(roles, '△ check 0')]).toEqual([14, 26, 38, 50])
    // the two heaviest models: value at 14 and 38, a 10-cell share bar after each
    expect(colOf(models, 'opus 993k')).toBe(14)
    expect(models.slice(26, 36)).toBe('▮▮▮▮▮▮▮▮▯▯')
    // `sonnet 153k` does not fit the 10-column cell: the tokens stand alone, the name is never cut
    expect(colOf(models, '153k')).toBe(38)
    expect(models).not.toContain('sonn')
    expect(wholeModelTokens(models)).toBe(true)
    expect(models.slice(50, 60)).toMatch(/^▮+▯+$/)
    expect(all.join('\n')).not.toContain('LIVE')
    await ui.unmount()
  }
})

test('LOOK (text form): the deck tiers: under 62 the aside goes, under 50 the third and fourth cells go, never wider than the pane', TEXT, async ($, on) => {
  seed(on, MIXED, AGENTS_UI)
  for (const [columns, aside, third] of [[62, true, true], [55, false, true], [40, false, false], [32, false, false]] as const) {
    const ui = await mount($, 'terminal', columns)
    const all = await rows(ui)
    for (const r of all) expect(r.length).toBeLessThanOrEqual(columns)
    expect(rowWith(all, 'CREW').includes('failed')).toBe(aside)
    expect(rowWith(all, 'ROLES').includes('check')).toBe(aside)
    expect(rowWith(all, 'ROLES').includes('build')).toBe(third)
    expect(rowWith(all, 'MODELS').includes('153k')).toBe(third)
    expect(wholeModelTokens(rowWith(all, 'MODELS'))).toBe(true)
    expect(rowWith(all, 'ROLES').includes('lead')).toBe(true)
    expect(rowWith(all, 'MODELS').includes('opus')).toBe(true)
    expect(rowWith(all, 'CREW')[0]).toBe('┏')
    await ui.unmount()
  }
})

test('LOOK (text form): the crew shows a stalled pod with its signal, and the deck counts live agents', TEXT, async ($, on) => {
  seed(on, stalled(), AGENTS_UI)
  const ui = await mount($, 'terminal', 62)
  const crew = rowWith(await rows(ui), 'CREW')
  expect(crew.slice(14, 14 + 14)).toBe('◈  ◉z ▣z ◉    ')
  expect(colOf(crew, '3 live')).toBe(38)
  expect(crew).not.toContain('failed')
  await ui.unmount()
})

test('the MODELS row is left out when no agent has reported a model', async ($, on) => {
  seed(on, busy({ agents: { main, a1: agent('a1', 'Explore', 'find callers', 'x') } }), AGENTS_UI)
  const ui = await mount($, 'terminal', 62)
  const text = (await rows(ui)).join('\n')
  expect(text).toContain('ROLES')
  expect(text).not.toContain('MODELS')
  await ui.unmount()
})

const manyDone = (n: number): Timeline =>
  busy({
    agents: {
      main,
      ...Object.fromEntries(
        Array.from({ length: n }, (_, i) => [
          `d${i}`,
          { ...agent(`d${i}`, 'Explore', `done job ${i}`, 'x', 'done'), endedAt: NOW - 1000, startedAt: NOW - 50_000 + i },
        ]),
      ),
    },
  })

test('more than 6 rows: six, then + n more done', async ($, on) => {
  seed(on, manyDone(8), AGENTS_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const all = await rows(ui)
    const buttons = (await ui.findAll({ type: 'Button' })).filter(b => /^agent-(main|d\d)$/.test(b.key ?? ''))
    expect(buttons.length).toBe(6)
    const line = rowWith(all, 'more done')
    expect(line.trim()).toBe('+ 3 more done')
    expect(colOf(line, '+')).toBe(2)
    expect(colOf(line, '3 more done')).toBe(4)
    await ui.unmount()
  }
})

test('the opened row always shows, even past the sixth', async ($, on) => {
  seed(on, manyDone(8), { ...AGENTS_UI, agentOpen: 'd7' })
  const ui = await mount($, 'terminal')
  expect(await ui.find({ key: 'agent-d7' })).toBeDefined()
  expect((await ui.findAll({ type: 'Button' })).filter(b => /^agent-(main|d\d)$/.test(b.key ?? '')).length).toBe(6)
  await ui.unmount()
})

// BEHAVIOUR CHANGE (rich rule 4): was "press again closes"
test('Enter on an agent row opens its page; b returns to the list with the agent row focused', async ($, on) => {
  const stored = seed(on, MIXED, AGENTS_UI)
  for (const surface of SURFACES) {
    put(stored, MIXED, AGENTS_UI)
    LOGS.length = 0
    const ui = await mount($, surface)
    await ui.press({ key: 'agent-a2' })
    expect((stored.get('ui') as UiState).page).toEqual({ kind: 'agent', id: 'a2', from: 'agent-a2' })
    expect((stored.get('ui') as UiState).tab).toBe('agents')
    await ui.redraw()
    await ui.press({ key: 'page-back' })
    expect((stored.get('ui') as UiState).page).toBeUndefined()
    expect(backTo()).toEqual(['agent-a2'])
    await ui.unmount()
  }
})

// BEHAVIOUR CHANGE (rich rule 4): the opened row (n/p move it) has no e: page line; Enter on the row opens the page.
test('LOOK (text form): an opened row: bold name, result and agent at 6/14, the action line at 6, a blank above and below', TEXT, async ($, on) => {
  seed(on, MIXED, { ...AGENTS_UI, agentOpen: 'a2' })
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const all = await rows(ui)
    const at = idxWith(all, 'count ts files')
    const found = await ui.findAll({ type: 'Text' })
    expect(propsOf(found.find(x => x.text === 'count ts files')).bold).toBe(true)
    expect(all[at - 1]?.trim()).toBe('')
    const result = all[at + 1] ?? ''
    expect(colOf(result, 'result')).toBe(6)
    expect(colOf(result, '17 TypeScript files under mod/')).toBe(14)
    const meta = all[at + 2] ?? ''
    expect(colOf(meta, 'agent')).toBe(6)
    expect(colOf(meta, 'scout · Explore · haiku · 2 steps · ')).toBe(14)
    const actions = all[at + 3] ?? ''
    expect(actions).toBe('      s: steps   v: transcript   g: chat')
    expect(all[at + 4]?.trim()).toBe('')
    await ui.unmount()
  }
})

test('a running agent opens to what it is doing; main opens with only s: steps', async ($, on) => {
  const stored = seed(on, MIXED, { ...AGENTS_UI, agentOpen: 'a1' })
  let ui = await mount($, 'terminal')
  const all = await rows(ui)
  expect(rowWith(all, 'doing')).toContain('Grep upload')
  await ui.unmount()
  put(stored, MIXED, { ...AGENTS_UI, agentOpen: 'main' })
  ui = await mount($, 'terminal')
  const m = await rows(ui)
  expect(rowWith(m, 's: steps')).toBe('      s: steps')
  expect(await ui.find({ key: 'agent-view-main' })).toBeUndefined()
  // main is first in its section: no blank above it
  expect(m[idxWith(m, '┌ AGENTS') + 1]).toContain('main')
  await ui.unmount()
})

test('s filters Steps to the agent', async ($, on) => {
  const stored = seed(on, MIXED, { ...AGENTS_UI, agentOpen: 'a1' })
  for (const surface of SURFACES) {
    put(stored, MIXED, { ...AGENTS_UI, agentOpen: 'a1' })
    const ui = await mount($, surface)
    await ui.press({ key: 'agent-steps-a1' })
    const u = stored.get('ui') as UiState
    expect(u.tab).toBe('timeline')
    expect(u.filter).toEqual({ kind: 'agent', id: 'a1' })
    await ui.unmount()
  }
})

test('v calls viewAgent only on press, and a refusal is toasted', async ($, on) => {
  const calls: unknown[] = []
  const toasts: string[] = []
  on('ui.view', (_, e) => {
    calls.push(e)
    return { value: { deny: 'no such agent' } }
  })
  on('ui.toast', (_, e) => {
    toasts.push(String((e as { text?: string }).text))
    return { value: undefined }
  })
  seed(on, MIXED, { ...AGENTS_UI, agentOpen: 'a1' })
  const ui = await mount($, 'terminal')
  expect(calls.length).toBe(0)
  await ui.press({ key: 'agent-view-a1' })
  expect(JSON.stringify(calls)).toContain('a1')
  expect(toasts.join('|')).toContain('no such agent')
  await ui.unmount()
})

test('g presses through to the chat, and says so when the agent has no spawn call', async ($, on) => {
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(String((e as { text?: string }).text))
    return { value: undefined }
  })
  const stored = seed(on, MIXED, { ...AGENTS_UI, agentOpen: 'a2' })
  let ui = await mount($, 'terminal')
  expect(toasts.length).toBe(0)
  // The mounted kit has nothing beneath $.ui.scroll (find.test.tsx drives the call): the toast shows the press reached it.
  await ui.press({ key: 'agent-chat-a2' })
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain('Not shown in chat')
  expect(toasts[0]).not.toContain('no spawn call')
  await ui.unmount()
  toasts.length = 0
  put(stored, MIXED, { ...AGENTS_UI, agentOpen: 'a1' })
  ui = await mount($, 'terminal')
  await ui.press({ key: 'agent-chat-a1' })
  expect(toasts.join('|')).toContain('no spawn call')
  await ui.unmount()
})

test('RUNS: one row per run on the grid, a failed count in the metric, a press opens the board', async ($, on) => {
  const t = busy({
    runs: { r1: run },
    agents: {
      main,
      w1: wf('w1', 0, 'read:agent-1', 'Read a.ts', 'done'),
      w2: { ...wf('w2', 1, 'read:agent-2', 'Read b.ts', 'error'), endedAt: NOW - 10_000 },
    },
  })
  const stored = seed(on, t, AGENTS_UI)
  for (const surface of SURFACES) {
    put(stored, t, AGENTS_UI)
    const ui = await mount($, surface)
    const all = await rows(ui)
    const head = rowWith(all, '┌ RUNS')
    expect(colOf(head, 'agents')).toBe(38)
    expect(colOf(head, 'time')).toBe(50)
    const r = rowWith(all, 'review-changes')
    expect(colOf(r, '≡')).toBe(2)
    expect(colOf(r, 'review-changes')).toBe(4)
    expect(colOf(r, '2 · ✖ 1')).toBe(38)
    expect(colOf(r, '1m')).toBe(50)
    await ui.press({ key: 'run-open-r1' })
    expect((stored.get('ui') as UiState).run).toBe('r1')
    await ui.unmount()
  }
})

const stalled = (): Timeline =>
  busy({
    runs: { r1: run },
    agents: {
      main,
      a1: { ...agent('a1', 'Explore', 'find callers', 'Grep'), startedAt: NOW - 400_000, lastStepAt: NOW - 300_000 },
      a2: agent('a2', 'Explore', 'write tests', 'Edit'),
      w1: { ...wf('w1', 0, 'read:agent-1', 'x', 'running'), startedAt: NOW - 400_000, lastStepAt: NOW - 300_000 },
    },
  })

test('LOOK (text form): a stalled agent is z in the gutter in warning; a run that holds a problem is !', TEXT, async ($, on) => {
  seed(on, stalled(), AGENTS_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const all = await rows(ui)
    expect(colOf(rowWith(all, 'find callers'), 'z')).toBe(0)
    expect(rowWith(all, 'write tests').startsWith(' ')).toBe(true)
    expect(colOf(rowWith(all, 'review-changes'), '!')).toBe(0)
    const found = await ui.findAll({ type: 'Text' })
    expect(found.filter(f => (f.text ?? '').startsWith('z ')).map(b => propsOf(b).color)).toEqual(['warning'])
    expect(found.filter(f => (f.text ?? '').startsWith('!')).map(b => propsOf(b).color)).toContain('error')
    await ui.unmount()
  }
})

test('a dismissed problem leaves no ! and no z', async ($, on) => {
  seed(on, stalled(), { ...AGENTS_UI, dismissed: ['stalled:a1', 'stalled:w1'] })
  const ui = await mount($, 'terminal')
  expect((await rows(ui)).filter(r => /^[!z]/.test(r)).length).toBe(0)
  await ui.unmount()
})

test('the footer shows only while focused: ↵ open, n next !, p prev', async ($, on) => {
  seed(on, stalled(), AGENTS_UI)
  let ui = await mount($, 'terminal', 62, false)
  expect((await rows(ui)).join('\n')).not.toContain('↵ open')
  expect(await ui.find({ key: 'hint-next' })).toBeUndefined()
  await ui.unmount()
  ui = await mount($, 'terminal', 62, true)
  const foot = rowWith(await rows(ui), '↵ open')
  expect(foot.trim()).toBe('↵ open   n: next !   p: prev')
  expect(colOf(foot, '↵ open')).toBe(2)
  await ui.unmount()
})

test('n and p open the next and previous ! row, wrapping', async ($, on) => {
  const stored = seed(on, stalled(), AGENTS_UI)
  const ui = await mount($, 'terminal', 62, true)
  await ui.press({ key: 'hint-next' })
  expect((stored.get('ui') as UiState).agentOpen).toBe('a1')
  await ui.press({ key: 'hint-next' })
  expect((stored.get('ui') as UiState).agentOpen).toBe('run:r1')
  await ui.press({ key: 'hint-next' })
  expect((stored.get('ui') as UiState).agentOpen).toBe('a1')
  await ui.press({ key: 'hint-prev' })
  expect((stored.get('ui') as UiState).agentOpen).toBe('run:r1')
  await ui.unmount()
})

test('no problem, no n or p hint', async ($, on) => {
  seed(on, MIXED, AGENTS_UI)
  const ui = await mount($, 'terminal', 62, true)
  expect(rowWith(await rows(ui), '↵ open').trim()).toBe('↵ open')
  await ui.unmount()
})

test('two agents with the same description keep distinct keys', async ($, on) => {
  seed(
    on,
    busy({ agents: { main, a1: agent('a1', 'Explore', 'same', 'x'), a2: agent('a2', 'Explore', 'same', 'x') } }),
    AGENTS_UI,
  )
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect(await ui.find({ key: 'agent-a1' })).toBeDefined()
    expect(await ui.find({ key: 'agent-a2' })).toBeDefined()
    await ui.unmount()
  }
})

test('LOOK (text form): narrow tiers: time at 38 from 50 columns, at 26 from 38, dropped under 38; nothing wider than the pane', TEXT, async ($, on) => {
  const long = { ...MIXED.agents.a1!, description: 'find every caller of the stepRow function in the views' }
  seed(on, { ...MIXED, agents: { ...MIXED.agents, a1: long } }, { ...AGENTS_UI, agentOpen: 'a1' })
  const expected: [number, number | undefined, number | undefined][] = [
    [62, 38, 50],
    [55, undefined, 38],
    [40, undefined, 26],
    [32, undefined, undefined],
  ]
  for (const [columns, metric, time] of expected) {
    const ui = await mount($, 'terminal', columns)
    const all = await rows(ui)
    for (const r of all) expect(r.length).toBeLessThanOrEqual(columns)
    const a1 = rowWith(all, 'find every')
    if (metric !== undefined) expect(colOf(a1, '72k')).toBe(metric)
    else expect(a1).not.toContain('72k')
    if (time !== undefined) expect(colOf(a1, '1m')).toBe(time)
    else expect(a1).not.toContain('1m')
    // a name is cut at a word, never inside one
    const name = a1.slice(4).split(/ {2,}/)[0] ?? ''
    if (name.endsWith('…')) {
      const kept = name.slice(0, -1)
      expect(long.description.startsWith(kept)).toBe(true)
      expect(long.description[kept.length]).toBe(' ')
    }
    await ui.unmount()
  }
})

test('empty state', async ($, on) => {
  seed(on, empty, AGENTS_UI)
  for (const surface of SURFACES) {
    for (const columns of [62, 32]) {
      const ui = await mount($, surface, columns)
      const all = await rows(ui)
      const joined = all.map(r => r.trim()).join(' ')
      expect(joined).toContain('No agents yet. Subagents and workflow agents appear here while they run.')
      for (const r of all) expect(r.length).toBeLessThanOrEqual(columns)
      await ui.unmount()
    }
  }
})

test('focused, every row of Agents, footer included, fits 32 and 40 columns', async ($, on) => {
  seed(on, busy({
    agents: {
      main,
      a1: { ...agent('a1', 'Explore', 'find every caller of stepRow', 'Grep stepRow') },
      a2: { ...agent('a2', 'general-purpose', 'write timeline tests', 'Edit a.ts'), status: 'error' as const },
    },
  }), AGENTS_UI)
  for (const columns of [32, 40]) {
    for (const surface of SURFACES) {
      const ui = await mount($, surface, columns, true)
      const rows = screen(await ui.drawn())
      expect(rows.length > 5).toBe(true)
      for (const r of rows) expect(r.length <= columns).toBe(true)
      await ui.unmount()
    }
  }
})

test('LOOK (text form): an agent waiting on the person is ? in the gutter in warning, with its hull lit in warning and a ? in the crew', TEXT, async ($, on) => {
  const t = busy({
    agents: { main, a1: agent('a1', 'Explore', 'find callers', 'Bash'), a2: agent('a2', 'Explore', 'write tests', 'Edit') },
    // asked 30 s ago: past the 20 s threshold every view shares (see waits.test.tsx)
    steps: [step('s2', 2, 'Bash npm publish', 'running', { agent: 'a1', tool: 'Bash', asking: NOW - 30_000 })],
  })
  seed(on, t, AGENTS_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const all = await rows(ui)
    expect(colOf(rowWith(all, 'find callers'), '?')).toBe(0)
    expect(rowWith(all, 'write tests').startsWith(' ')).toBe(true)
    const found = await ui.findAll({ type: 'Text' })
    expect(found.filter(f => (f.text ?? '').startsWith('? ')).map(f => propsOf(f).color)).toEqual(['warning'])
    expect(rowWith(all, 'CREW').slice(14, 14 + 10)).toBe('◈  ◉? ◉   ')
    await ui.unmount()
  }
})

// ---------- Neo Rich: the line-up, the small characters, ROLES ----------

const rasters = async (ui: Mounted): Promise<{ key: string; columns: number; rows: number }[]> =>
  (await ui.findAll({ type: 'Raster' })).map(r => {
    const p = (r.props ?? {}) as { key?: string; columns?: number; rows?: number }
    return { key: String(p.key), columns: p.columns ?? 0, rows: p.rows ?? 0 }
  })

const crowd = (n: number): Timeline =>
  busy({
    agents: {
      main: { ...withMainWork, ...model('claude-opus-5', 993_000) },
      ...Object.fromEntries(
        Array.from({ length: n }, (_, i) => [
          `x${i}`,
          { ...agent(`x${i}`, 'Explore', `look into part ${i}`, 'Grep'), ...model('claude-sonnet-5', 10_000 * (i + 1)) },
        ]),
      ),
    },
  })

test('LOOK (rich): the deck is a lintel, the line-up of large characters with a count, ROLES, MODELS and a sill', async ($, on) => {
  seed(on, crowd(6), AGENTS_UI)
  const ui = await mount($, 'terminal', 62)
  const found = await rasters(ui)
  // five large characters of 9 x 4 with their tokens under them: 45 x 5
  expect(found.find(r => r.key === 'crew-lineup')).toEqual({ key: 'crew-lineup', columns: 45, rows: 5 })
  expect(found.find(r => r.key === 'agents-deck-lintel')).toEqual({ key: 'agents-deck-lintel', columns: 62, rows: 1 })
  expect(found.find(r => r.key === 'agents-deck-sill')).toEqual({ key: 'agents-deck-sill', columns: 62, rows: 1 })
  expect(found.find(r => r.key === 'models-share')).toEqual({ key: 'models-share', columns: 22, rows: 1 })
  const all = await rows(ui)
  // seven agents, five drawn, a count for the other two, and the live count under the label
  expect(colOf(rowWith(all, 'CREW'), '+2')).toBe(60)
  expect(rowWith(all, '6 live').trim()).toBe('6 live')
  expect(rowWith(all, 'ROLES')).toContain('scout 6')
  const models = rowWith(all, 'MODELS')
  expect(colOf(models, 'opus 993k')).toBe(38)
  expect(colOf(models, 'sonnet 210k')).toBe(50)
  await ui.unmount()
})

test('LOOK (rich): a row has the small character (5 x 2) at 2, the name at 8, tokens at 38, time at 50, and its facts under the name', async ($, on) => {
  seed(on, MIXED, AGENTS_UI)
  const ui = await mount($, 'terminal', 62)
  const found = await rasters(ui)
  for (const id of ['main', 'a1', 'a2', 'a3']) expect(found.find(r => r.key === `who-${id}`)).toEqual({ key: `who-${id}`, columns: 5, rows: 2 })
  const all = await rows(ui)
  const a1 = rowWith(all, 'find callers')
  expect([colOf(a1, 'find callers'), colOf(a1, '72k'), colOf(a1, '1m')]).toEqual([8, 38, 50])
  expect(all[idxWith(all, 'find callers') + 1]?.trim()).toBe('scout · working · sonnet')
  // the failed row carries ! in the gutter, the same Button key as ever
  expect(colOf(rowWith(all, 'run plugin tests'), '!')).toBe(0)
  // no Button shares the character's cells: the Button holds the name row only
  const btn = await ui.find({ key: 'agent-a1' })
  expect(btn).toBeDefined()
  expect(String(btn?.text ?? '')).not.toContain('scout ·')
  await ui.unmount()
})

test('a surface without Raster draws the hull glyph row and no Raster at all', async ($, on) => {
  seed(on, MIXED, AGENTS_UI)
  for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
    const ui = await mount($, surface, 62)
    expect(await rasters(ui)).toEqual([])
    const all = await rows(ui)
    expect(colOf(rowWith(all, 'find callers'), '◉')).toBe(2)
    expect(colOf(rowWith(all, 'CREW'), '◈')).toBe(14)
    await ui.unmount()
  }
})

test('roles counts: ROLES counts agents by the role their type plays, from roles(t), and main is the lead', async ($, on) => {
  const t = busy({
    agents: {
      main,
      p1: agent('p1', 'Plan', 'plan the change', 'x'),
      s1: agent('s1', 'Explore', 'find callers', 'x'),
      s2: agent('s2', 'Explore', 'find tests', 'x', 'done'),
      c1: agent('c1', 'code-reviewer', 'review views', 'x'),
      c2: agent('c2', 'test-runner', 'run tests', 'x'),
      c3: agent('c3', 'verify-build', 'verify the build', 'x'),
      b1: agent('b1', 'general-purpose', 'write the limiter', 'x'),
    },
  })
  expect(roles(t).map(r => [r.type, r.count])).toEqual([['Explore', 2], ['Plan', 1], ['code-reviewer', 1], ['general-purpose', 1], ['test-runner', 1], ['verify-build', 1]])
  seed(on, t, AGENTS_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface, 62)
    const line = rowWith(await rows(ui), 'ROLES')
    // lead: main and the Plan agent; scout: both Explores; build: general-purpose; check: reviewer, tester, verifier
    expect(line).toMatch(/lead 2\s+.*scout 2\s+.*build 1\s+.*check 3/)
    await ui.unmount()
  }
})

// ---------- Neo Rich: the agent page ----------

const LONG =
  'Write the tests for the upload rate limiter: the 429 path, the reset header and the burst of eleven requests, and use the staging bucket for every one of them so nothing touches production data'
const RESULT =
  'Nine cases written and seven pass. The burst case fails because the limiter counts per connection, not per API key. Next: key the bucket by token, then run it again.'

const PAGE_UI = (id: string): UiState => ({ ...AGENTS_UI, page: { kind: 'agent', id } }) as UiState

const pageWorld = (extra: Partial<Timeline> = {}): Timeline =>
  busy({
    tasks: [task('10', 'Wire the limiter into the chain', 'in_progress')],
    changed: ['C:/repo/test/server/rateLimit.test.ts'],
    steps: [
      step('s1', 1, 'Read test/upload.test.ts', 'done', { agent: 'a1', tool: 'Read', startedAt: NOW - 50_000 }),
      step('s2', 2, 'Edit server/rateLimit.test.ts', 'done', { agent: 'a1', tool: 'Edit', startedAt: NOW - 40_000 }),
      step('s3', 3, 'Read src/shots/failure.png', 'done', { agent: 'a1', tool: 'Read', startedAt: NOW - 30_000 }),
      step('s4', 4, 'Bash npm test', 'running', { agent: 'a1', tool: 'Bash', startedAt: NOW - 5_000 }),
      step('s5', 5, 'Read other.ts', 'done', { agent: 'main', tool: 'Read' }),
    ],
    agents: {
      main: { ...withMainWork, ...model('claude-opus-5', 993_000) },
      a1: {
        ...agent('a1', 'general-purpose', LONG, 'Bash npm test'),
        taskId: '10',
        ...model('claude-sonnet-5', 41_000, { tokensOut: 11_000 }),
        stepCount: 4,
        lastStepAt: NOW - 5_000,
        spawnStep: 'toolu_a1',
        result: RESULT,
      },
    },
    ...extra,
  })

test('the agent page shows the full description and never ends a line in …', async ($, on) => {
  seed(on, pageWorld(), PAGE_UI('a1'))
  for (const surface of SURFACES) {
    for (const columns of [62, 40, 32]) {
      const ui = await mount($, surface, columns)
      const all = await rows(ui)
      for (const r of all) {
        expect(r.length).toBeLessThanOrEqual(columns)
        expect(r.endsWith('…')).toBe(false)
      }
      // the description and the result, wrapped: every word comes back
      const joined = all.join(' ').replace(/\s+/g, ' ')
      for (const w of LONG.split(' ')) expect(joined).toContain(w)
      for (const w of RESULT.split(' ')) expect(joined).toContain(w)
      expect(joined).toContain('Write the tests')
      await ui.unmount()
    }
  }
})

test('LOOK: the agent page has the large character, AGENT, TOKENS, TIME, STATE, TASK, STEPS, RESULT and v g s b', async ($, on) => {
  seed(on, pageWorld(), PAGE_UI('a1'))
  const ui = await mount($, 'terminal', 62)
  expect((await rasters(ui)).find(r => r.key === 'agent-page-who')).toEqual({ key: 'agent-page-who', columns: 9, rows: 4 })
  const all = await rows(ui)
  expect(rowWith(all, 'AGENT')).toContain('general-purpose · build · sonnet')
  expect(rowWith(all, 'TOKENS')).toContain('41k in · 11k out')
  const time = rowWith(all, 'TIME')
  expect(time).toContain('1m')
  expect(colOf(time, 'started')).toBe(38)
  expect(rowWith(all, 'STATE')).toContain('working')
  expect(colOf(rowWith(all, 'STATE'), 'last step')).toBe(38)
  expect(rowWith(all, 'TASK')).toContain('▸ 10 Wire the limiter into the chain')
  expect(rowWith(all, 'STEPS')).toContain('4 · newest first')
  expect(all.filter(r => r.includes('Bash npm test')).some(r => r.includes('running'))).toBe(true)
  expect(all.some(r => r.includes('┌ RESULT'))).toBe(true)
  // only this agent's steps
  expect(all.join('\n')).not.toContain('other.ts')
  expect(rowWith(all, 'v: transcript')).toContain('v: transcript   g: chat   s: steps')
  expect(all[all.length - 1]).toContain('b: back')
  await ui.unmount()
})

test('main has a page too: no transcript and no chat, steps and back', async ($, on) => {
  seed(on, pageWorld(), PAGE_UI('main'))
  const ui = await mount($, 'terminal', 62)
  const text = (await rows(ui)).join('\n')
  expect(text).toContain('lead')
  expect(text).not.toContain('transcript')
  expect(text).not.toContain('g: chat')
  expect(text).toContain('s: steps')
  await ui.unmount()
})

test('an agent page for an agent that is gone says so', async ($, on) => {
  seed(on, pageWorld(), PAGE_UI('nobody'))
  const gone = await mount($, 'terminal', 62)
  expect((await rows(gone)).join('\n')).toContain('This agent is gone.')
  await gone.unmount()
})

test('the TASK line opens the task page and a step row opens the step page', async ($, on) => {
  const stored = seed(on, pageWorld(), PAGE_UI('a1'))
  const ui = await mount($, 'terminal', 62)
  await ui.press({ key: 'agent-page-task' })
  expect((stored.get('ui') as UiState).page).toEqual({ kind: 'task', id: 'main:10' })
  await ui.unmount()
  put(stored, pageWorld(), PAGE_UI('a1'))
  const again = await mount($, 'terminal', 62)
  await again.press({ key: 'agent-step-s2' })
  const u = stored.get('ui') as UiState & { stepBody?: { stepId: string } }
  expect(u.page).toEqual({ kind: 'step', id: 's2' })
  // Through openStep: the body read ran for this step.
  expect(u.stepBody?.stepId).toBe('s2')
  await again.unmount()
})

function editorWorld(on: On, t: Timeline, u: UiState): { stored: Stored; runs: string[][] } {
  const stored = seed(on, t, u)
  const runs: string[][] = []
  on('session.root', () => ({ value: 'C:/repo' }))
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { stored, runs }
}

test('files read and edited are listed, each with o: open, and a press calls openInEditor with the full path', async ($, on) => {
  const w = editorWorld(on, pageWorld(), PAGE_UI('a1'))
  for (const surface of SURFACES) {
    const ui = await mount($, surface, 62)
    const all = await rows(ui)
    // newest first: the image, the edit (its full path from the changed list), the read
    const lines = all.filter(r => r.startsWith('  o: open'))
    expect(lines.length).toBe(3)
    expect(lines[0]).toContain('src/shots/failure.png')
    expect(lines[0]).toContain('image')
    expect(lines[1]).toContain('C:/repo/test/server/rateLimit.test')
    expect(all[all.indexOf(lines[1]!) + 1]?.trim()).toBe('.ts')
    expect(lines[1]).toContain('edited')
    expect(lines[2]).toContain('test/upload.test.ts')
    expect(lines[2]).toContain('read')
    expect(w.runs).toEqual([])
    await ui.unmount()
  }
  const ui = await mount($, 'terminal', 62)
  await ui.press({ key: 'agent-file-1' })
  expect(w.runs).toEqual([['code', '-r', '-g', 'C:/repo/test/server/rateLimit.test.ts']])
  await ui.press({ key: 'agent-file-0' })
  expect(w.runs[1]).toEqual(['code', '-r', '-g', 'C:/repo/src/shots/failure.png'])
  await ui.unmount()
})

test('o opens the newest file; an agent with no file steps has no o', async ($, on) => {
  const w = editorWorld(on, pageWorld(), PAGE_UI('a1'))
  const ui = await mount($, 'terminal', 62)
  await ui.press({ key: 'agent-page-open' })
  expect(w.runs).toEqual([['code', '-r', '-g', 'C:/repo/src/shots/failure.png']])
  await ui.unmount()
  put(w.stored, pageWorld(), PAGE_UI('main'))
  const main2 = await mount($, 'terminal', 62)
  // main only read other.ts: one file, so the action is plain `open`
  expect(rowWith(await rows(main2), 'o: open')).toContain('other.ts')
  await main2.unmount()
  put(w.stored, pageWorld({ steps: [] }), PAGE_UI('a1'))
  const bare = await mount($, 'terminal', 62)
  expect((await rows(bare)).join('\n')).not.toContain('o: open')
  expect(await bare.find({ key: 'agent-page-open' })).toBeUndefined()
  await bare.unmount()
})

test('the lintel is never refused at narrow widths: the readout is left out where it would meet the pill', async ($, on) => {
  const stored = seed(on, crowd(6), AGENTS_UI)
  const uis: UiState[] = [AGENTS_UI, { ...AGENTS_UI, agentsMode: 'tree' }, PAGE_UI('x1'), PAGE_UI('main')]
  for (const u of uis) {
    for (const columns of [22, 26, 32, 36, 40, 62]) {
      put(stored, crowd(6), u)
      // a refused tree fails the mount (the hook is skipped, the pane blank)
      const ui = await mount($, 'terminal', columns)
      const all = await rows(ui)
      expect(all.length > 3).toBe(true)
      for (const r of all) expect(r.length).toBeLessThanOrEqual(columns)
      await ui.unmount()
    }
  }
})
