import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { AgentRow, Run, Step, TaskItem, Timeline, UiState } from '../../types'
import { empty } from '../model/reduce'
import { backTo, colOf, keepLog, LOGS, screen } from './screen.testkit'

/** The text look on every surface: the critters draw as their text forms (a state glyph, the role word). */
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

const PANE = (columns: number, focused = false, bodyRows = 40) =>
  ({
    plugin: 'mission-control',
    component: 'Pane',
    requestId: 'mission-control',
    props: {
      title: 'Mission Control',
      isFocused: focused,
      bodyColumns: columns,
      placement: 'dock',
      scroll: { offset: 0, bodyRows },
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

async function mount($: Engine, surface: (typeof SURFACES)[number], columns = 62, focused = false, bodyRows = 40) {
  return $.ui.mount({ ...PANE(columns, focused, bodyRows), surface })
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
const idxWith = (all: string[], text: string): number => all.findIndex(r => r.includes(text))

const rasters = async (ui: Mounted): Promise<{ key: string; columns: number; rows: number }[]> =>
  (await ui.findAll({ type: 'Raster' })).map(r => {
    const p = (r.props ?? {}) as { key?: string; columns?: number; rows?: number }
    return { key: String(p.key), columns: p.columns ?? 0, rows: p.rows ?? 0 }
  })

const model = (id: string, tokensIn: number, extra: Partial<AgentRow> = {}): Partial<AgentRow> => ({ model: id, tokensIn, tokensOut: 0, ...extra })

const MIXED = busy({
  runs: { r1: run },
  steps: [
    step('s1', 1, 'Edit a.ts', 'done', { startedAt: NOW - 360_000 }),
    step('sa1', 2, 'Grep upload', 'running', { agent: 'a1', tool: 'Grep', pending: { pattern: 'upload', path: 'src' } }),
  ],
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
    a3: { ...agent('a3', 'Explore', 'run plugin tests', 'oops', 'error'), ...model('claude-sonnet-5', 81_000), endedAt: NOW - 30_000, result: 'the suite never started' },
    w1: wf('w1', 0, 'read:agent-1', 'Read a.ts', 'done'),
    w2: wf('w2', 1, 'read:agent-2', 'Read b.ts', 'running'),
  },
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

const manyDone = (n: number): Timeline =>
  busy({
    agents: {
      main,
      ...Object.fromEntries(
        Array.from({ length: n }, (_, i) => [
          `d${i}`,
          { ...agent(`d${i}`, 'Explore', `finished job ${i}`, 'x', 'done'), endedAt: NOW - 10_000 * (i + 1) },
        ]),
      ),
    },
  })

// ---------- the list ----------

test('LOOK: the list is Working, Failed, Finished, Runs; main and workflow agents are not in it', TEXT, async ($, on) => {
  seed(on, MIXED, AGENTS_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const all = await rows(ui)
    const at = ['Working', 'Failed', 'Finished', 'Runs'].map(x => all.findIndex(r => r.startsWith(`  ${x} `)))
    expect(at.every(i => i >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    const text = all.join('\n')
    expect(text).not.toContain('main')
    expect(text).not.toContain('read:agent-1')
    // the sections' sums are on the right edge, at 59
    for (const x of ['Working', 'Failed', 'Finished', 'Runs']) {
      const head = rowWith(all, `  ${x} `)
      expect(head.length).toBe(60)
      expect(head).toContain('─')
    }
    // no hull glyphs, no caps heads, no ┌
    expect(text).not.toMatch(/[┌◈◉]|AGENTS|CREW|ROLES|MODELS/)
    await ui.unmount()
  }
})

test('LOOK: a card is the real type in bold at 9 with the job, the time at 59, what it is doing and its tokens under it', TEXT, async ($, on) => {
  seed(on, MIXED, AGENTS_UI)
  const ui = await mount($, 'terminal')
  const all = await rows(ui)
  const a1 = rowWith(all, 'find callers')
  expect([colOf(a1, 'Explorer'), colOf(a1, 'find callers'), a1.length]).toEqual([9, 19, 60])
  expect(a1.trimEnd().endsWith('1 min')).toBe(true)
  const doing = all[idxWith(all, 'find callers') + 1]!
  expect(colOf(doing, 'Searching src for “upload”')).toBe(9)
  expect(doing.endsWith('72k tokens')).toBe(true)
  expect(doing.length).toBe(60)
  // the card's third row is empty
  expect(all[idxWith(all, 'find callers') + 2]).toBe('')
  const found = await ui.findAll({ type: 'Text' })
  expect(propsOf(found.find(f => f.text === 'Explorer')).bold).toBe(true)
  await ui.unmount()
})

test('only working agents get a critter: a card each; a failed agent a micro one; finished rows none', async ($, on) => {
  seed(on, MIXED, AGENTS_UI)
  const ui = await mount($, 'terminal', 62)
  const found = await rasters(ui)
  const who = found.filter(r => /-who$|^who-/.test(r.key)).map(r => [r.key, r.columns, r.rows])
  expect(who).toEqual([
    ['agent-a1-who', 6, 3],
    ['who-agent-a3', 5, 2],
  ])
  // the finished agent has a row and no critter
  expect(rowWith(await rows(ui), 'count ts files')).toContain('✓')
  await ui.unmount()
})

test('LOOK: a failed agent is a micro critter with a red !, the reason under its name, and v g s on the first', TEXT, async ($, on) => {
  seed(on, MIXED, AGENTS_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const all = await rows(ui)
    const head = rowWith(all, 'run plugin tests')
    expect(head).toMatch(/^ {2}× {3}! {2}Explorer/)
    expect(colOf(head, 'Explorer')).toBe(9)
    const next = all[idxWith(all, 'run plugin tests') + 1]!
    expect(colOf(next, 'Stopped: the suite never started')).toBe(9)
    expect(all[idxWith(all, 'run plugin tests') + 2]).toBe('         v: transcript   g: chat   s: steps')
    const found = await ui.findAll({ type: 'Text' })
    expect(found.filter(f => f.text === '!').map(f => propsOf(f).color)).toContain('error')
    // the failed section's head is in error too
    expect(found.filter(f => f.text === 'Failed').map(f => propsOf(f).color)).toContain('error')
    await ui.unmount()
  }
})

test('only the first failed agent carries the v g s keys', TEXT, async ($, on) => {
  const t = busy({
    agents: {
      main,
      f1: { ...agent('f1', 'Explore', 'one', 'x', 'error'), startedAt: NOW - 20_000, endedAt: NOW - 5000 },
      f2: { ...agent('f2', 'Explore', 'two', 'x', 'error'), startedAt: NOW - 30_000, endedAt: NOW - 6000 },
    },
  })
  seed(on, t, AGENTS_UI)
  const ui = await mount($, 'terminal')
  expect((await ui.findAll({ type: 'Button' })).filter(b => (b.key ?? '').startsWith('agent-view-')).map(b => b.key)).toEqual(['agent-view-f1'])
  await ui.unmount()
})

test('R23: the name is the real type in friendly case, never the hat', TEXT, async ($, on) => {
  const t = busy({
    agents: {
      main,
      a1: agent('a1', 'general-purpose', 'write tests', 'Edit'),
      a2: agent('a2', 'code-reviewer', 'review views', 'Read'),
      a3: agent('a3', 'Plan', 'plan it', 'Read'),
      a4: agent('a4', 'mystery-agent', 'do a thing', 'Read'),
    },
  })
  seed(on, t, AGENTS_UI)
  const all = await rows(await mount($, 'terminal'))
  for (const [type, desc] of [['General', 'write tests'], ['Code reviewer', 'review views'], ['Planner', 'plan it'], ['Mystery agent', 'do a thing']]) {
    expect(colOf(rowWith(all, desc!), type!)).toBe(9)
  }
})

test('LOOK: finished agents are three dim rows with ✓ and tokens at 49, time at 59, then + n more; a press shows all', TEXT, async ($, on) => {
  const stored = seed(on, manyDone(8), AGENTS_UI)
  const ui = await mount($, 'terminal')
  const all = await rows(ui)
  expect(all.filter(r => r.startsWith('  ✓ ')).length).toBe(3)
  const more = rowWith(all, '+ 5 more')
  expect(more).toBe('    + 5 more')
  const head = rowWith(all, 'Finished')
  expect(head.endsWith('8')).toBe(true)
  const first = rowWith(all, 'finished job 0')
  expect([colOf(first, '✓'), colOf(first, 'Explorer')]).toEqual([2, 4])
  const text = await ui.findAll({ type: 'Text' })
  expect(text.filter(f => (f.text ?? '').startsWith('Explorer')).every(f => propsOf(f).dimColor === true || propsOf(f).bold !== true)).toBe(true)
  await ui.press({ key: 'finished-more' })
  expect((stored.get('ui') as UiState).folded).toContain('open:finished')
  await ui.unmount()
  put(stored, manyDone(8), { ...AGENTS_UI, folded: ['open:finished'] })
  const open = await mount($, 'terminal')
  const rowsOpen = await rows(open)
  expect(rowsOpen.filter(r => r.startsWith('  ✓ ')).length).toBe(8)
  expect(rowWith(rowsOpen, 'fewer')).toBe('    fewer')
  await open.unmount()
})

test('LOOK: the header counts, the model share and the tokens, from the agents that reported', TEXT, async ($, on) => {
  seed(on, MIXED, AGENTS_UI)
  const ui = await mount($, 'terminal')
  const all = await rows(ui)
  // F M6: the toggle row is the row under the tabs (row 3), so the lintel is row 4 and the header row 5.
  expect(all[5]).toBe('  1 agent working                      1 finished · 1 failed')
  const models = rowWith(all, 'Models')
  expect(colOf(models, '━')).toBe(12)
  expect(models).toContain('■ Sonnet 59%')
  const tokens = rowWith(all, 'Tokens')
  expect(tokens).toContain('across 3 agents')
  expect(colOf(tokens, '259k')).toBe(12)
  // the lintel and the sill frame it, and the toggle row is above the lintel
  expect(all[4]).toMatch(/^┏━━─+$/)
  expect(all[idxWith(all, 'Tokens') + 1]).toMatch(/^─+━━┛$/)
  await ui.unmount()
})

test('the Models row and the Tokens row are left out when no agent has reported', TEXT, async ($, on) => {
  seed(on, busy({ agents: { main, a1: agent('a1', 'Explore', 'find callers', 'Grep') } }), AGENTS_UI)
  const all = await rows(await mount($, 'terminal'))
  expect(all.join('\n')).not.toContain('Models')
  expect(all.join('\n')).not.toContain('Tokens')
  expect(all.join('\n')).toContain('1 agent working')
})

test('LOOK: the toggle row is l: List, t: Map and r: Working only; the open one bold between spaces, the others dim', TEXT, async ($, on) => {
  seed(on, MIXED, AGENTS_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const toggle = rowWith(await rows(ui), 'l: List')
    expect([colOf(toggle, 'l: List'), colOf(toggle, 't: Map'), colOf(toggle, 'r: Working only')]).toEqual([3, 14, 23])
    expect(propsOf(await ui.find({ key: 'mode-list' })).dimColor).toBeFalsy()
    expect(propsOf(await ui.find({ key: 'mode-tree' })).dimColor).toBe(true)
    await ui.unmount()
  }
})

test('LOOK: at 32 columns the toggle row is l: List  t: Map  r: Run and fits', TEXT, async ($, on) => {
  seed(on, MIXED, AGENTS_UI)
  const ui = await mount($, 'terminal', 32)
  expect(rowWith(await rows(ui), 'l: List')).toBe('   l: List    t: Map   r: Run')
  await ui.unmount()
})

test('pressing Map and Working only write ui.agentsMode and ui.runningOnly', async ($, on) => {
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

test('r hides the finished and the failed from the list and drops runs with nothing running', TEXT, async ($, on) => {
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

test('RUNS: one row a run, "3 of 5 agents done" and a failed count, the time at 59; a press opens the board', TEXT, async ($, on) => {
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
    expect(rowWith(all, 'Runs').endsWith('1')).toBe(true)
    const r = rowWith(all, 'review-changes')
    expect([colOf(r, '▸'), colOf(r, 'review-changes'), colOf(r, '1 of 2 agents done · 1 failed')]).toEqual([2, 4, 20])
    expect(r.length).toBe(60)
    expect(r.endsWith('1 min')).toBe(true)
    await ui.press({ key: 'run-open-r1' })
    expect((stored.get('ui') as UiState).run).toBe('r1')
    await ui.unmount()
  }
})

// BEHAVIOUR CHANGE (cockpit): Enter opens the page (as before), and the row no longer opens in place.
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

test('s filters Steps to the agent; v calls viewAgent only on press and a refusal is toasted; g says so when there is no spawn call', async ($, on) => {
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
  const stored = seed(on, MIXED, AGENTS_UI)
  const ui = await mount($, 'terminal')
  expect(calls.length).toBe(0)
  await ui.press({ key: 'agent-view-a3' })
  expect(JSON.stringify(calls)).toContain('a3')
  expect(toasts.join('|')).toContain('no such agent')
  toasts.length = 0
  await ui.press({ key: 'agent-chat-a3' })
  expect(toasts.join('|')).toContain('no spawn call')
  await ui.press({ key: 'agent-steps-a3' })
  const u = stored.get('ui') as UiState
  expect([u.tab, u.filter]).toEqual(['timeline', { kind: 'agent', id: 'a3' }])
  await ui.unmount()
})

// Quiet past ten minutes (R6: an agent thinking for less is no alert).
const stalled = (): Timeline =>
  busy({
    runs: { r1: run },
    agents: {
      main,
      a1: { ...agent('a1', 'Explore', 'find callers', 'Grep'), startedAt: NOW - 800_000, lastStepAt: NOW - 700_000 },
      a2: agent('a2', 'Explore', 'write tests', 'Edit'),
      w1: { ...wf('w1', 0, 'read:agent-1', 'x', 'running'), startedAt: NOW - 800_000, lastStepAt: NOW - 700_000 },
    },
  })

test('LOOK: a stalled agent is z on its critter (no gutter flag in the list, R26); the ask is ? and amber', TEXT, async ($, on) => {
  seed(on, stalled(), AGENTS_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const all = await rows(ui)
    // the badge sits in the box's last column, 7
    expect(colOf(all[idxWith(all, 'find callers')]!, 'Explorer')).toBe(9)
    expect(all.filter(r => /^[!?z] /.test(r))).toEqual([])
    expect(all.some(r => /^ {2}● {4}z/.test(r))).toBe(true)
    expect(rowWith(all, 'find callers')).toContain('Explorer')
    expect(all[idxWith(all, 'find callers') + 1]).toContain('No activity for a while')
    await ui.unmount()
  }
})

test('LOOK: a waiting agent has ? on its critter and its time and what it waits for in amber', TEXT, async ($, on) => {
  const t = busy({
    agents: { main, a1: agent('a1', 'Explore', 'find callers', 'Bash'), a2: agent('a2', 'Explore', 'write tests', 'Edit') },
    // asked 30 s ago: past the 20 s threshold every view shares (see waits.test.tsx)
    steps: [step('s2', 2, 'Bash npm publish', 'running', { agent: 'a1', tool: 'Bash', asking: NOW - 30_000 })],
    autoAsk: true,
  })
  seed(on, t, AGENTS_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const all = await rows(ui)
    const at = idxWith(all, 'find callers')
    expect(all[at - 1] ?? '').not.toBe('')
    expect(all[at]).toMatch(/^ {2}● {4}\? Explorer/)
    expect(all[at + 1]).toContain('Waiting for your answer')
    expect(all.filter(r => /^[!?z] /.test(r))).toEqual([])
    const found = await ui.findAll({ type: 'Text' })
    expect(found.filter(f => f.text === 'Waiting for your answer').map(f => propsOf(f).color)).toEqual(['warning'])
    expect(found.filter(f => f.text === '30s').map(f => propsOf(f).color)).toEqual(['warning'])
    await ui.unmount()
  }
})

test('a dismissed problem leaves no ?, ! or z', TEXT, async ($, on) => {
  seed(on, stalled(), { ...AGENTS_UI, dismissed: ['stalled:a1', 'stalled:w1'] })
  const ui = await mount($, 'terminal')
  const all = await rows(ui)
  expect(all.some(r => /● {4}z/.test(r))).toBe(false)
  await ui.unmount()
})

test('the footer is the mock footer while focused (↵ open agent, v transcript with a failure, esc prompt, no 0 options); unfocused it keeps its row, blank, so the height does not change (M12)', TEXT, async ($, on) => {
  seed(on, MIXED, AGENTS_UI)
  let ui = await mount($, 'terminal', 62, false)
  const blurred = await rows(ui)
  expect(blurred.join('\n')).not.toContain('↵ open')
  await ui.unmount()
  ui = await mount($, 'terminal', 62, true)
  const focused = await rows(ui)
  expect(rowWith(focused, '↵ open')).toBe('  ↵ open agent   v transcript   esc prompt')
  expect(focused.length).toBe(blurred.length)
  expect(await ui.find({ key: 'arm-hint-next' })).toBeUndefined()
  await ui.unmount()
})

test('while an agent has a problem the list footer stays the mock footer; n and p are armed by hidden Buttons with no hint (R28 amended)', TEXT, async ($, on) => {
  seed(on, stalled(), AGENTS_UI)
  const flagged = await mount($, 'terminal', 62, true)
  expect(rowWith(await rows(flagged), '↵ open').trim()).toBe('↵ open agent   esc prompt')
  expect(await flagged.find({ key: 'arm-hint-next' })).toBeDefined()
  expect(await flagged.find({ key: 'arm-hint-prev' })).toBeDefined()
  await flagged.unmount()
})

test('the footer is on the pane\'s last row, with blank rows above it', TEXT, async ($, on) => {
  seed(on, MIXED, AGENTS_UI)
  const ui = await mount($, 'terminal', 62, true, 46)
  const all = await rows(ui)
  expect(all.length).toBe(46)
  expect(all[45]).toContain('↵ open agent')
  expect(all[44]).toBe('')
  await ui.unmount()
})

test('n and p open the next and previous problem row, wrapping', async ($, on) => {
  const t = busy({
    runs: { r1: run },
    agents: {
      main,
      a1: { ...agent('a1', 'Explore', 'find callers', 'Grep'), startedAt: NOW - 800_000, lastStepAt: NOW - 700_000 },
      w1: { ...wf('w1', 0, 'read:agent-1', 'x', 'running'), startedAt: NOW - 800_000, lastStepAt: NOW - 700_000 },
    },
  })
  const stored = seed(on, t, AGENTS_UI)
  const ui = await mount($, 'terminal', 62, true)
  await ui.press({ key: 'arm-hint-next' })
  expect((stored.get('ui') as UiState).agentOpen).toBe('a1')
  await ui.press({ key: 'arm-hint-next' })
  expect((stored.get('ui') as UiState).agentOpen).toBe('run:r1')
  await ui.press({ key: 'arm-hint-next' })
  expect((stored.get('ui') as UiState).agentOpen).toBe('a1')
  await ui.press({ key: 'arm-hint-prev' })
  expect((stored.get('ui') as UiState).agentOpen).toBe('run:r1')
  await ui.unmount()
})

test('two agents with the same description keep distinct keys', async ($, on) => {
  seed(on, busy({ agents: { main, a1: agent('a1', 'Explore', 'same', 'x'), a2: agent('a2', 'Explore', 'same', 'x') } }), AGENTS_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect(await ui.find({ key: 'agent-a1' })).toBeDefined()
    expect(await ui.find({ key: 'agent-a2' })).toBeDefined()
    await ui.unmount()
  }
})

test('LOOK: narrow tiers: tokens and time follow the columns (49 and 59 at 62), tokens drop under 46, nothing wider than the pane', TEXT, async ($, on) => {
  const long = { ...MIXED.agents.a2!, description: 'count every typescript file under the views directory' }
  seed(on, { ...MIXED, agents: { ...MIXED.agents, a2: long } }, AGENTS_UI)
  const expected: [number, number | undefined, number][] = [
    [62, 49, 59],
    [50, 37, 47],
    [40, undefined, 37],
    [32, undefined, 29],
  ]
  for (const [columns, tokens, time] of expected) {
    const ui = await mount($, 'terminal', columns)
    const all = await rows(ui)
    for (const r of all) expect(r.length).toBeLessThanOrEqual(columns)
    const done = rowWith(all, '✓')
    expect(done.trimEnd().length).toBe(time + 1)
    if (tokens !== undefined) expect(done.slice(0, tokens + 1).trimEnd().endsWith('106k')).toBe(true)
    else expect(done).not.toContain('106k')
    // a name is cut at a word, never inside one
    const name = done.slice(4).split(/ {2,}/).slice(0, 2).join('  ')
    if (name.endsWith('…')) {
      const kept = name.slice(0, -1).replace('Explorer  ', '')
      expect(long.description.startsWith(kept)).toBe(true)
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
      const all = screen(await ui.drawn())
      expect(all.length > 5).toBe(true)
      for (const r of all) expect(r.length <= columns).toBe(true)
      await ui.unmount()
    }
  }
})

test('the rich look draws the lintel, the sill, the cards\' critters and no hull; a surface without Raster draws none', async ($, on) => {
  seed(on, MIXED, AGENTS_UI)
  const ui = await mount($, 'terminal', 62)
  const found = await rasters(ui)
  expect(found.find(r => r.key === 'agents-lintel')).toEqual({ key: 'agents-lintel', columns: 62, rows: 1 })
  expect(found.find(r => r.key === 'agents-sill')).toEqual({ key: 'agents-sill', columns: 62, rows: 1 })
  await ui.unmount()
  for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
    const plain = await mount($, surface, 62)
    expect(await rasters(plain)).toEqual([])
    await plain.unmount()
  }
})

// ---------- the agent page ----------

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

test('LOOK: the agent page has no Raster, a text critter form, Agent, Tokens, Time, State, Task, Steps, Result and v g s b', async ($, on) => {
  seed(on, pageWorld(), PAGE_UI('a1'))
  const ui = await mount($, 'terminal', 62)
  // pages cannot hold a Raster (R22): no critter box, no large character
  expect((await rasters(ui)).filter(r => !r.key.includes('lintel') && !r.key.includes('sill'))).toEqual([])
  const all = await rows(ui)
  const field = (label: string): string => all.find(r => r.startsWith(`  ${label} `)) ?? ''
  expect(field('Agent')).toContain('General · sonnet')
  expect(field('Agent')).not.toContain('general-purpose')
  expect(field('Tokens')).toContain('41k in · 11k out')
  const time = field('Time')
  expect(time).toContain('1 min')
  expect(colOf(time, 'started')).toBe(38)
  expect(field('State')).toContain('working')
  expect(colOf(field('State'), 'last step')).toBe(38)
  expect(field('Task')).toContain('▸ 10 Wire the limiter into the chain')
  expect(field('Steps')).toContain('4 · newest first')
  expect(all.filter(r => r.includes('Bash npm test')).some(r => r.includes('running'))).toBe(true)
  expect(all.some(r => r.includes('Result'))).toBe(true)
  expect(all.join('\n')).not.toMatch(/AGENT|TOKENS|RESULT/)
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
  expect(text).toContain('Claude')
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
    // A long path wraps at a `/`, never inside a name (review I-5).
    expect(lines[1]).toContain('C:/repo/test/server/')
    expect(all[all.indexOf(lines[1]!) + 1]?.trim()).toBe('rateLimit.test.ts')
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
      // I9: a view that throws still draws the tab bar and one failure line (the shell's, or the view's own
      // `Agents: …` / `Agents map: …`), so the line itself is what is ruled out.
      expect(all.join('\n')).not.toMatch(/This tab failed|Failed:|^Agents( map)?: /m)
      for (const r of all) expect(r.length).toBeLessThanOrEqual(columns)
      await ui.unmount()
    }
  }
})
