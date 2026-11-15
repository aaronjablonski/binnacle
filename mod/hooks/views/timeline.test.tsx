import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { AgentRow, Step, Timeline, TurnRow, UiState } from '../../types'
import { bodyOf } from '../journal'
import { empty } from '../model/reduce'

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
const NOW = 1_000_000
const SHAPES: Record<string, string> = { timeline: 'timeline-3', ui: 'ui-3' }
const HOME = 'C:/Users/test'

type Stored = Map<string, unknown>
let clock: ReturnType<typeof mock.clock> | undefined
let readCostMs = 0
const reads: string[] = []

// The engine's $.state beneath the mod, seeded and remembering every write; the
// disk answers fs.read from `files`.
function world(
  on: On,
  t: Timeline,
  u?: UiState,
  files: Map<string, string> = new Map(),
  shapes: Record<string, string> = SHAPES,
): Stored {
  const stored: Stored = new Map()
  stored.set('timeline', t)
  if (u) stored.set('ui', u)
  const versions = new Map<string, number>()
  clock = mock.clock(on, { now: NOW })
  reads.length = 0
  mock.env(on, { USERPROFILE: HOME, OS: 'Windows_NT' })
  on('ui.log', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('fs.read', async (_, e) => {
    reads.push(e.path.replaceAll('\\', '/'))
    if (readCostMs > 0 && e.path.includes('steps')) await clock?.advance(readCostMs)
    const text = files.get(e.path.replace(/\\/g, '/'))
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('state.get', (_, e) => {
    const key = (e as { key: string }).key
    const v = stored.get(key)
    return {
      value: {
        value: v === undefined ? undefined : { shape: shapes[key], value: v },
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
  return stored
}

function put(stored: Stored, t: Timeline, u: UiState): void {
  stored.clear()
  stored.set('timeline', t)
  stored.set('ui', u)
}

const TL_UI: UiState = {
  tab: 'timeline',
  filter: { kind: 'all' },
  agentsMode: 'list',
  folded: [],
  openTurns: [],
  dismissed: [],
  query: '',
  runningOnly: false,
  notified: [],
  toasted: [],
}

const PANE = (columns: number, bodyRows = 40) =>
  ({
    plugin: 'mission-control',
    component: 'Pane',
    requestId: 'mission-control',
    props: {
      title: 'Mission Control',
      isFocused: false,
      bodyColumns: columns,
      placement: 'dock',
      scroll: { offset: 0, bodyRows },
      view: {},
    },
  }) as const

const turn = (id: string, prompt: string, startedAt: number): TurnRow => ({ id, agent: 'main', prompt, startedAt })
const step = (id: string, seq: number, label: string, status: Step['status'], extra: Partial<Step> = {}): Step => ({
  id,
  seq,
  agent: 'main',
  tool: 'Edit',
  label,
  status,
  startedAt: NOW - 5000,
  endedAt: NOW - 4000,
  ...extra,
})
const agent = (id: string, type: string): AgentRow => ({
  id,
  parent: 'main',
  type,
  description: 'x',
  status: 'done',
  startedAt: NOW - 60_000,
  doing: '',
  stepCount: 1,
})
const main: AgentRow = { ...empty.agents.main! }

// An older turn t1 with two steps (one by a subagent) and the newest turn t2 with two.
function twoTurns(): Timeline {
  return {
    ...empty,
    turns: [turn('t1', 'what does the upload endpoint accept today?', NOW - 900_000), turn('t2', 'add rate limiting', NOW - 60_000)],
    agents: { main, a1: agent('a1', 'Explore') },
    steps: [
      step('s1', 1, 'Read upload.ts', 'done', { turnId: 't1', tool: 'Read' }),
      step('s2', 2, 'Grep upload(', 'done', { turnId: 't1', tool: 'Grep', agent: 'a1' }),
      step('s3', 3, 'Edit rateLimit.ts', 'done', { turnId: 't2' }),
      step('s4', 4, 'Bash npm test', 'error', { turnId: 't2', tool: 'Bash' }),
    ],
  }
}

async function mount($: Engine, surface: (typeof SURFACES)[number], columns = 62, bodyRows = 40) {
  return $.ui.mount({ ...PANE(columns, bodyRows), surface })
}

const texts = async (ui: Awaited<ReturnType<typeof mount>>): Promise<string[]> => {
  const found = await ui.findAll({ type: 'Text' })
  return found.map(f => f.text ?? '')
}

test('the newest turn is open and older turns are folded with a step count', async ($, on) => {
  world(on, twoTurns(), TL_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect(await ui.find({ key: 'step-s3' })).toBeDefined()
    expect(await ui.find({ key: 'step-s4' })).toBeDefined()
    expect(await ui.find({ key: 'step-s1' })).toBeUndefined()
    const folded = (await ui.find({ key: 'turn-t1' }))?.text ?? ''
    expect(folded).toContain('▸')
    expect(folded).toContain('what does the upload endpoint')
    expect(folded).toContain('2 steps · 1 agent')
    expect((await ui.find({ key: 'turn-t2' }))?.text).toContain('▾')
    await ui.unmount()
  }
})

test('pressing a folded turn opens it', async ($, on) => {
  const stored = world(on, twoTurns(), TL_UI)
  for (const surface of SURFACES) {
    put(stored, twoTurns(), TL_UI)
    const ui = await mount($, surface)
    await ui.press({ key: 'turn-t1' })
    expect((stored.get('ui') as UiState).openTurns).toEqual(['t1'])
    await ui.unmount()
    const opened = await mount($, surface)
    expect(await opened.find({ key: 'step-s1' })).toBeDefined()
    expect((await opened.find({ key: 'turn-t1' }))?.text).toContain('▾')
    await opened.press({ key: 'turn-t1' })
    expect((stored.get('ui') as UiState).openTurns).toEqual([])
    await opened.unmount()
    const closed = await mount($, surface)
    expect(await closed.find({ key: 'step-s1' })).toBeUndefined()
    await closed.unmount()
  }
})

test('the Errors filter shows only error steps', async ($, on) => {
  const stored = world(on, twoTurns(), TL_UI)
  for (const surface of SURFACES) {
    put(stored, twoTurns(), TL_UI)
    const ui = await mount($, surface)
    expect((await ui.find({ key: 'filter-errors' }))?.text).toContain('✖ Errors 1')
    expect((await ui.find({ key: 'filter-pinned' }))?.text).toContain('★ Pinned 0')
    await ui.press({ key: 'filter-errors' })
    expect((stored.get('ui') as UiState).filter).toEqual({ kind: 'errors' })
    await ui.unmount()
    const filtered = await mount($, surface)
    expect(await filtered.find({ key: 'step-s4' })).toBeDefined()
    expect(await filtered.find({ key: 'step-s3' })).toBeUndefined()
    await filtered.press({ key: 'filter-all' })
    expect((stored.get('ui') as UiState).filter).toEqual({ kind: 'all' })
    await filtered.unmount()
    const all = await mount($, surface)
    expect(await all.find({ key: 'step-s3' })).toBeDefined()
    await all.unmount()
  }
})

test('an agent filter shows its chip and clearing it returns to All', async ($, on) => {
  const agentUi: UiState = { ...TL_UI, filter: { kind: 'agent', id: 'a1' }, openTurns: ['t1'] }
  const stored = world(on, twoTurns(), agentUi)
  for (const surface of SURFACES) {
    put(stored, twoTurns(), agentUi)
    const ui = await mount($, surface)
    expect((await ui.find({ key: 'filter-agent' }))?.text).toContain('Explore ✕')
    expect(await ui.find({ key: 'step-s2' })).toBeDefined()
    expect(await ui.find({ key: 'step-s1' })).toBeUndefined()
    await ui.press({ key: 'filter-agent' })
    expect((stored.get('ui') as UiState).filter).toEqual({ kind: 'all' })
    await ui.unmount()
    const cleared = await mount($, surface)
    expect(await cleared.find({ key: 'filter-agent' })).toBeUndefined()
    expect(await cleared.find({ key: 'step-s1' })).toBeDefined()
    await cleared.unmount()
  }
})

test('2,000 steps draw fewer than 200 Buttons', async ($, on) => {
  const steps = Array.from({ length: 2000 }, (_, i) => step(`s${i}`, i + 1, `Edit file${i}.ts`, 'done', { turnId: 't1' }))
  world(on, { ...empty, turns: [turn('t1', 'big job', NOW - 60_000)], steps }, TL_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const buttons = await ui.findAll({ type: 'Button' })
    expect(buttons.length < 200).toBe(true)
    expect(await ui.find({ key: 'step-s1999' })).toBeDefined()
    expect(await ui.find({ key: 'step-s0' })).toBeUndefined()
    await ui.unmount()
  }
})

test('pressing a step opens its detail with the body read from disk', async ($, on) => {
  const body = bodyOf({ file_path: 'a.ts' }, { text: 'ok' })
  const files = new Map([[`${HOME}/.claude/mission-control/sess-1/steps/s3.json`, JSON.stringify(body)]])
  const stored = world(on, twoTurns(), TL_UI, files)
  for (const surface of SURFACES) {
    put(stored, twoTurns(), TL_UI)
    const ui = await mount($, surface)
    await ui.press({ key: 'step-s3' })
    const u = stored.get('ui') as UiState
    expect(u.detail?.stepId).toBe('s3')
    expect(u.detail?.body?.text).toBe('ok')
    await ui.press({ key: 'step-s4' })
    expect((stored.get('ui') as UiState).detail).toEqual({ stepId: 's4', missing: true })
    await ui.unmount()
  }
})

test('/mc pin note pins the newest main step and it shows ★ and the note', async ($, on) => {
  const stored = world(on, twoTurns(), TL_UI)
  const got = await $.command.run({ command: 'mc', args: 'pin the limiter itself' } as never)
  expect(got.text).toBe('Pinned: Bash npm test')
  const t = stored.get('timeline') as Timeline
  expect(t.steps.find(s => s.id === 's4')?.pin).toBe('the limiter itself')
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect((await ui.find({ key: 'step-s4' }))?.text).toContain('★ Bash npm test')
    expect((await ui.find({ key: 'step-s4' }))?.text).toContain('the limiter itself')
    expect((await ui.find({ key: 'filter-pinned' }))?.text).toContain('★ Pinned 1')
    await ui.unmount()
  }
})

test('/mc pin with no note pins with an empty note, and skips a subagent step', async ($, on) => {
  const t = twoTurns()
  t.steps.push(step('s5', 5, 'Grep later', 'done', { turnId: 't2', agent: 'a1', tool: 'Grep' }))
  const stored = world(on, t, TL_UI)
  const got = await $.command.run({ command: 'mc', args: 'pin' } as never)
  expect(got.text).toBe('Pinned: Bash npm test')
  const after = stored.get('timeline') as Timeline
  expect(after.steps.find(s => s.id === 's4')?.pin).toBe('')
  expect(after.steps.find(s => s.id === 's5')?.pin).toBeUndefined()
})

test('/mc pin with no steps says Nothing to pin yet.', async ($, on) => {
  world(on, empty, TL_UI)
  const got = await $.command.run({ command: 'mc', args: 'pin' } as never)
  expect(got.text).toBe('Nothing to pin yet.')
})

test('a ui value stored as ui-2 is read as the initial value', async ($, on) => {
  world(on, twoTurns(), TL_UI, new Map(), { timeline: 'timeline-3', ui: 'ui-2' })
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect(await ui.find({ key: 'filter-errors' })).toBeUndefined()
    expect((await texts(ui)).join('\n')).toContain('NOW')
    await ui.unmount()
  }
})

test('narrow: no Text longer than 24', async ($, on) => {
  const t = twoTurns()
  t.steps.push(
    step('s6', 6, 'Edit src/server/middleware/rateLimit.ts', 'done', { turnId: 't2', pin: 'the limiter itself, a long note' }),
    step('s7', 7, 'Agent general-purpose · write limiter tests', 'running', { turnId: 't2', agent: 'a1' }),
  )
  t.turns[1] = turn('t2', 'add rate limiting to the upload endpoint and write the tests', NOW - 60_000)
  world(on, t, { ...TL_UI, openTurns: ['t1'] })
  for (const surface of SURFACES) {
    const ui = await mount($, surface, 24)
    const found = [...(await ui.findAll({ type: 'Text' })), ...(await ui.findAll({ type: 'Button' }))]
    expect(found.length > 10).toBe(true)
    for (const f of found) {
      for (const line of (f.text ?? '').split('\n')) expect(line.length <= 24).toBe(true)
    }
    await ui.unmount()
  }
})

test('empty state: No steps yet.', async ($, on) => {
  world(on, empty, TL_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect((await texts(ui)).join('\n')).toContain('No steps yet.')
    await ui.unmount()
  }
})

test('a filter that matches nothing says so', async ($, on) => {
  world(on, { ...empty, steps: [step('s1', 1, 'Read a', 'done')] }, { ...TL_UI, filter: { kind: 'errors' } })
  const ui = await mount($, 'terminal')
  expect((await texts(ui)).join('\n')).toContain('No steps match.')
  await ui.unmount()
})

type Mounted = Awaited<ReturnType<typeof mount>>
type Found = Awaited<ReturnType<Mounted['findAll']>>[number]
const propsOf = (f: Found | undefined): { color?: string; dimColor?: boolean; bold?: boolean; justifyContent?: string } =>
  (f?.props ?? {}) as { color?: string; dimColor?: boolean; bold?: boolean; justifyContent?: string }

function pinned(): Timeline {
  const t = twoTurns()
  return { ...t, steps: t.steps.map(s => (s.id === 's4' ? { ...s, pin: 'the limiter itself' } : s)) }
}

test('step glyphs carry status colours and the turn mark is accent', async ($, on) => {
  world(on, pinned(), TL_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const found = await ui.findAll({ type: 'Text' })
    expect(propsOf(found.find(f => f.text === '✔')).color).toBe('success')
    expect(propsOf(found.find(f => f.text === '✖')).color).toBe('error')
    expect(propsOf(found.find(f => f.text === '▾')).color).toBe('suggestion')
    expect(propsOf(found.find(f => f.text === '▸')).color).toBe('suggestion')
    await ui.unmount()
  }
})

test('a step row is one Button: meta flush right, the pin note second, dim with └', async ($, on) => {
  world(on, pinned(), TL_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface, 62)
    const [first, second] = ((await ui.find({ key: 'step-s4' }))?.text ?? '').split('\n')
    expect(first?.length).toBe(62)
    expect(first?.endsWith('1s')).toBe(true)
    expect(second).toBe('  └ the limiter itself')
    const found = await ui.findAll({ type: 'Text' })
    expect(propsOf(found.find(f => f.text === '\n  └ the limiter itself')).dimColor).toBe(true)
    await ui.unmount()
  }
})

test('the newest turn is a space-between row with its time dim; a folded turn counts on a └ line', async ($, on) => {
  world(on, twoTurns(), TL_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface, 62)
    const rows = (await ui.findAll({ type: 'Box' })).filter(b => propsOf(b).justifyContent === 'space-between')
    expect(rows.length).toBe(1)
    const found = await ui.findAll({ type: 'Text' })
    expect(found.some(f => /^\d\d:\d\d$/.test(f.text ?? '') && propsOf(f).dimColor === true)).toBe(true)
    const folded = ((await ui.find({ key: 'turn-t1' }))?.text ?? '').split('\n')
    expect(folded[1]).toBe('  └ 2 steps · 1 agent')
    expect(folded[0]?.length).toBe(62)
    await ui.unmount()
  }
})

test('narrow: a pinned step and the turn rows keep every line within 24', async ($, on) => {
  world(on, pinned(), TL_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface, 24)
    const found = await ui.findAll({ type: 'Text' })
    expect(found.length > 6).toBe(true)
    for (const f of found) {
      for (const line of (f.text ?? '').split('\n')) expect(line.length <= 24).toBe(true)
    }
    await ui.unmount()
  }
})

// ---- find and jump (F4) ---------------------------------------------------

const FIND_KEY = 'timeline-find'
const bodyFile = (id: string, text: string): [string, string] => [
  `${HOME}/.claude/mission-control/sess-1/steps/${id}.json`,
  JSON.stringify({ input: { file_path: 'a.ts' }, text, cut: 0, isError: false }),
]

test('the Timeline has a find Input bound to ui.query; typing filters live', async ($, on) => {
  const stored = world(on, twoTurns(), { ...TL_UI, openTurns: ['t1'] })
  for (const surface of SURFACES) {
    put(stored, twoTurns(), { ...TL_UI, openTurns: ['t1'] })
    const ui = await mount($, surface)
    expect(await ui.find({ key: FIND_KEY })).toBeDefined()
    await $.ui.input({ plugin: 'mission-control', key: FIND_KEY, text: 'rateLimit', kind: 'change', surface })
    expect((stored.get('ui') as UiState).query).toBe('rateLimit')
    await ui.unmount()
    const filtered = await mount($, surface)
    expect(await filtered.find({ key: 'step-s3' })).toBeDefined()
    expect(await filtered.find({ key: 'step-s4' })).toBeUndefined()
    expect(await filtered.find({ key: 'step-s1' })).toBeUndefined()
    expect((await texts(filtered)).join('\n')).toContain('1 of 4 steps')
    await filtered.unmount()
  }
})

test('the query narrows by agent type and pin note too, and combines with a chip', async ($, on) => {
  const t = pinned()
  const stored = world(on, t, { ...TL_UI, openTurns: ['t1'], query: 'explore' })
  const ui = await mount($, 'terminal')
  expect(await ui.find({ key: 'step-s2' })).toBeDefined()
  expect(await ui.find({ key: 'step-s3' })).toBeUndefined()
  await ui.unmount()
  put(stored, t, { ...TL_UI, openTurns: ['t1'], query: 'limiter itself', filter: { kind: 'errors' } })
  const both = await mount($, 'terminal')
  expect(await both.find({ key: 'step-s4' })).toBeDefined()
  await both.unmount()
  put(stored, t, { ...TL_UI, query: 'limiter itself', filter: { kind: 'agent', id: 'a1' } })
  const none = await mount($, 'terminal')
  expect((await texts(none)).join('\n')).toContain('No steps match.')
  expect(await none.find({ key: FIND_KEY })).toBeDefined()
  await none.unmount()
})

test('Enter runs a deep search over stored bodies and marks hits "in result"', async ($, on) => {
  on('ui.toast', () => ({ value: undefined }))
  const files = new Map([
    bodyFile('s1', 'nothing'),
    bodyFile('s2', 'nothing'),
    bodyFile('s3', 'nothing'),
    bodyFile('s4', 'HTTP/1.1 429 Too Many Requests'),
  ])
  const stored = world(on, twoTurns(), { ...TL_UI, openTurns: ['t1'], query: '429' }, files)
  const ui = await mount($, 'terminal')
  await $.ui.input({ plugin: 'mission-control', key: FIND_KEY, text: '429', surface: 'terminal' })
  expect((stored.get('ui') as UiState).hits).toEqual(['s4'])
  await ui.unmount()
  for (const surface of SURFACES) {
    const found = await mount($, surface, 62)
    expect((await found.find({ key: 'step-s4' }))?.text ?? '').toContain('in result')
    expect(await found.find({ key: 'step-s3' })).toBeUndefined()
    await found.unmount()
  }
})

test('typing again clears the deep-search hits', async ($, on) => {
  const stored = world(on, twoTurns(), { ...TL_UI, query: '429', hits: ['s4'] })
  const ui = await mount($, 'terminal')
  await $.ui.input({ plugin: 'mission-control', key: FIND_KEY, text: '4290', kind: 'change', surface: 'terminal' })
  const u = stored.get('ui') as UiState
  expect(u.query).toBe('4290')
  expect(u.hits).toBeUndefined()
  await ui.unmount()
})

test('deep search reads newest first and at most 200 bodies', async ($, on) => {
  on('ui.toast', () => ({ value: undefined }))
  const steps = Array.from({ length: 250 }, (_, i) => step(`d${i}`, i + 1, `Edit f${i}.ts`, 'done', { turnId: 't1' }))
  const files = new Map(steps.map(s => bodyFile(s.id, s.id === 'd249' || s.id === 'd10' ? 'needle' : 'hay')))
  const stored = world(on, { ...empty, turns: [turn('t1', 'big', NOW - 60_000)], steps }, { ...TL_UI, query: 'needle' }, files)
  const ui = await mount($, 'terminal')
  await $.ui.input({ plugin: 'mission-control', key: FIND_KEY, text: 'needle', surface: 'terminal' })
  const bodies = reads.filter(r => r.includes('/steps/'))
  expect(bodies.length).toBe(200)
  expect(bodies[0]?.endsWith('/d249.json')).toBe(true)
  // d10 is the 240th newest: beyond the cap.
  expect((stored.get('ui') as UiState).hits).toEqual(['d249'])
  await ui.unmount()
})

test('deep search stops at 8 seconds', async ($, on) => {
  on('ui.toast', () => ({ value: undefined }))
  const steps = Array.from({ length: 50 }, (_, i) => step(`d${i}`, i + 1, `Edit f${i}.ts`, 'done', { turnId: 't1' }))
  const files = new Map(steps.map(s => bodyFile(s.id, 'needle')))
  const stored = world(on, { ...empty, turns: [turn('t1', 'big', NOW - 60_000)], steps }, { ...TL_UI, query: 'needle' }, files)
  readCostMs = 1000
  try {
    const ui = await mount($, 'terminal')
    await $.ui.input({ plugin: 'mission-control', key: FIND_KEY, text: 'needle', surface: 'terminal' })
    const bodies = reads.filter(r => r.includes('/steps/'))
    expect(bodies.length).toBe(8)
    expect((stored.get('ui') as UiState).hits?.length).toBe(8)
    await ui.unmount()
  } finally {
    readCostMs = 0
  }
})

test('a blank query clears the hits and runs no deep search', async ($, on) => {
  const stored = world(on, twoTurns(), { ...TL_UI, query: '', hits: ['s4'] })
  const ui = await mount($, 'terminal')
  await $.ui.input({ plugin: 'mission-control', key: FIND_KEY, text: '  ', surface: 'terminal' })
  expect(reads.filter(r => r.includes('/steps/')).length).toBe(0)
  expect((stored.get('ui') as UiState).hits).toBeUndefined()
  await ui.unmount()
})

// A press runs the plugin's own $.ui.scroll; the mounted kit has nothing beneath
// it that answers (find.test.tsx drives the call itself), so the refusal toast
// is what shows the press reached it.
test('with a query, a step row has Show in chat; nothing scrolls until it is pressed', async ($, on) => {
  world(on, twoTurns(), { ...TL_UI, query: 'rateLimit' })
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push((e as unknown as { text: string }).text)
    return { value: undefined }
  })
  const ui = await mount($, 'terminal')
  expect(toasts.length).toBe(0)
  expect(await ui.find({ key: 'chat-s4' })).toBeUndefined()
  expect((await ui.find({ key: 'chat-s3' }))?.text).toContain('Show in chat')
  expect(toasts.length).toBe(0)
  await ui.press({ key: 'chat-s3' })
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain('Not shown in chat')
  await ui.unmount()
})

test('without a query, step rows have no Show in chat line', async ($, on) => {
  world(on, twoTurns(), TL_UI)
  const ui = await mount($, 'terminal')
  expect(await ui.find({ key: 'chat-s3' })).toBeUndefined()
  await ui.unmount()
})

test('the active filter chip is accent coloured, the others dim', async ($, on) => {
  world(on, twoTurns(), { ...TL_UI, filter: { kind: 'errors' } })
  const ui = await mount($, 'terminal')
  const texts_ = await ui.findAll({ type: 'Text' })
  const active = propsOf(texts_.find(x => x.text === '✖ Errors 0' || x.text === '✖ Errors 1'))
  expect(active.color).toBe('suggestion')
  expect(active.bold).toBe(true)
  const all = propsOf((await ui.findAll({ type: 'Button' })).find(b => b.text === 'All'))
  expect(all.dimColor).toBe(true)
  expect(texts_.some(x => x.text === 'All')).toBe(false)
  await ui.unmount()
})

test('narrow find results keep every line within 24', async ($, on) => {
  world(on, twoTurns(), { ...TL_UI, query: 'rate', hits: ['s4'] })
  for (const surface of SURFACES) {
    const ui = await mount($, surface, 24)
    const found = [...(await ui.findAll({ type: 'Text' })), ...(await ui.findAll({ type: 'Button' }))]
    expect(found.length > 5).toBe(true)
    for (const f of found) for (const line of (f.text ?? '').split('\n')) expect(line.length <= 24).toBe(true)
    await ui.unmount()
  }
})
