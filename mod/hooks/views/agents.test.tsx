import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { AgentRow, Run, Step, TaskItem, Timeline, UiState } from '../../types'
import { empty } from '../model/reduce'
import { colOf, screen } from './screen.testkit'

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
  on('ui.log', () => ({ value: undefined }))
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

test('LOOK: three columns at 62: hull 2, name 4, tokens 38, time 50', async ($, on) => {
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

test('LOOK: hulls via podOf: ◈ main in claude, ◉ live scout in the accent, ○ failed in error, ● done dim', async ($, on) => {
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

test('the toggle row is l: List, t: Tree and r: Running on the first three cells', async ($, on) => {
  seed(on, MIXED, AGENTS_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const toggle = rowWith(await rows(ui), 'l: List')
    expect(colOf(toggle, 'l: List')).toBe(2)
    expect(colOf(toggle, 't: Tree')).toBe(14)
    expect(colOf(toggle, 'r: Running')).toBe(26)
    // the open mode is bold, the others dim
    expect(propsOf(await ui.find({ key: 'mode-list' })).dimColor).toBeFalsy()
    expect(propsOf(await ui.find({ key: 'mode-tree' })).dimColor).toBe(true)
    await ui.unmount()
  }
})

test('at 32 columns the toggle row is l: List  t: Tree  r: Run and fits', async ($, on) => {
  seed(on, MIXED, AGENTS_UI)
  const ui = await mount($, 'terminal', 32)
  const toggle = rowWith(await rows(ui), 'l: List')
  expect(toggle).toBe('  l: List  t: Tree  r: Run')
  await ui.unmount()
})

test('pressing Tree and Running write ui.agentsMode and ui.runningOnly', async ($, on) => {
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

test('LOOK: the deck: CREW, ROLES, MODELS between rails at 0 and 61, labels at 2, gauges at 14', async ($, on) => {
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

test('LOOK: the deck tiers: under 62 the aside goes, under 50 the third and fourth cells go, never wider than the pane', async ($, on) => {
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

test('the crew shows a stalled pod with its signal, and the deck counts live agents', async ($, on) => {
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

test('pressing a row opens it in place; pressing it again closes it', async ($, on) => {
  const stored = seed(on, MIXED, AGENTS_UI)
  for (const surface of SURFACES) {
    put(stored, MIXED, AGENTS_UI)
    const ui = await mount($, surface)
    await ui.press({ key: 'agent-a2' })
    expect((stored.get('ui') as UiState).agentOpen).toBe('a2')
    expect((stored.get('ui') as UiState).tab).toBe('agents')
    await ui.press({ key: 'agent-a2' })
    expect((stored.get('ui') as UiState).agentOpen).toBeUndefined()
    await ui.unmount()
  }
})

test('LOOK: an opened row: bold name, result and agent at 6/14, the action line at 6, a blank above and below', async ($, on) => {
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

test('LOOK: a stalled agent is z in the gutter in warning; a run that holds a problem is !', async ($, on) => {
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

test('narrow tiers: time at 38 from 50 columns, at 26 from 38, dropped under 38; nothing wider than the pane', async ($, on) => {
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

test('LOOK: an agent waiting on the person is ? in the gutter in warning, with its hull lit in warning and a ? in the crew', async ($, on) => {
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
