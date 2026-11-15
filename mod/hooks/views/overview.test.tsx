import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { AgentRow, ArtifactRow, Step, TaskItem, Timeline, UiState } from '../../types'
import { empty } from '../model/reduce'

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
const NOW = 1_000_000
const SHAPES: Record<string, string> = { timeline: 'timeline-4', ui: 'ui-3' }

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

// A new world for the next surface: the hooks stay, what they hold changes.
function reset(stored: Stored, t: Timeline): void {
  stored.clear()
  stored.set('timeline', t)
}

const PANE = (columns: number) =>
  ({
    plugin: 'mission-control',
    component: 'Pane',
    requestId: 'mission-control',
    props: {
      title: 'Mission Control',
      isFocused: false,
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

async function mount($: Engine, surface: (typeof SURFACES)[number], columns = 62) {
  return $.ui.mount({ ...PANE(columns), surface })
}

const texts = async (ui: Awaited<ReturnType<typeof mount>>): Promise<string[]> => {
  const found = await ui.findAll({ type: 'Text' })
  return found.map(f => f.text ?? '')
}

test("shows Claude's focus and next under NOW with 'from Claude'", async ($, on) => {
  seed(on, { ...empty, now: { focus: 'Wiring the limiter into the chain', next: 'Return 429', at: NOW - 20_000 } })
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const all = (await texts(ui)).join('\n')
    expect(all).toContain('Wiring the limiter into the chain')
    expect(all).toContain('Return 429')
    expect(all).toContain('from Claude · 20s ago')
    await ui.unmount()
  }
})

test('with no update, NOW shows the in-progress task and no "from Claude"', async ($, on) => {
  seed(on, { ...empty, tasks: [task('1', 'Add limiter', 'in_progress', { activeForm: 'Adding the limiter' })] })
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const all = (await texts(ui)).join('\n')
    expect(all).toContain('Adding the limiter')
    expect(all).not.toContain('from Claude')
    await ui.unmount()
  }
})

test('with no update and no tasks, NOW shows the latest step', async ($, on) => {
  seed(on, {
    ...empty,
    steps: [step('s1', 1, 'Read a.ts', 'done'), step('s2', 2, 'Edit b.ts', 'done'), step('s0', 0, 'Bash ls', 'running')],
  })
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const all = (await texts(ui)).join('\n')
    expect(all).toContain('· Bash ls')
    expect(all).toContain('latest step')
    expect(all).not.toContain('Idle.')
    expect(all).not.toContain('from Claude')
    await ui.unmount()
  }
})

test('with no running step, NOW shows the newest step by seq', async ($, on) => {
  seed(on, { ...empty, steps: [step('s1', 1, 'Read a.ts', 'done'), step('s2', 2, 'Edit b.ts', 'error')] })
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect((await texts(ui)).join('\n')).toContain('✖ Edit b.ts')
    await ui.unmount()
  }
})

test('an empty session says Idle and No tasks yet. and draws no other section', async ($, on) => {
  seed(on, empty)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const all = (await texts(ui)).join('\n')
    expect(all).toContain('Idle. Nothing running yet.')
    expect(all).toContain('No tasks yet.')
    expect(all).not.toContain('AGENTS')
    expect(all).not.toContain('LATEST')
    expect(all).not.toContain('NOTES')
    expect(all).not.toContain('ARTIFACTS')
    expect(await ui.find({ key: 'go-agents' })).toBe(undefined)
    expect(await ui.find({ key: 'go-timeline' })).toBe(undefined)
    expect(await ui.find({ key: 'go-artifacts' })).toBe(undefined)
    await ui.unmount()
  }
})

test('lists a running agent with its doing line', async ($, on) => {
  seed(on, { ...empty, agents: { main, a1: agent('a1', 'Explore', 'find callers', 'Grep upload') } })
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const all = (await texts(ui)).join('\n')
    expect(all).toContain('▶ Explore · find callers')
    expect(all).toContain('Grep upload')
    const header = (await ui.find({ key: 'go-agents' }))?.text ?? ''
    expect(header).toContain('AGENTS')
    expect(header).toContain('1 running · 0 done')
    await ui.unmount()
  }
})

test('shows an error step and a pinned step under LATEST', async ($, on) => {
  seed(on, {
    ...empty,
    steps: [step('s1', 1, 'Bash npm test', 'error'), step('s2', 2, 'Edit rateLimit.ts', 'done', { pin: 'the limiter itself' })],
  })
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const header = (await ui.find({ key: 'go-timeline' }))?.text ?? ''
    expect(header).toContain('LATEST')
    expect(header).toContain('2 steps · 1 errors · 0 files changed')
    expect((await ui.find({ key: 'step-s1' }))?.text).toContain('✖ Bash npm test')
    const pinned = (await ui.find({ key: 'step-s2' }))?.text ?? ''
    expect(pinned).toContain('★')
    expect(pinned).toContain('the limiter itself')
    await ui.unmount()
  }
})

test('shows a note and an artifact', async ($, on) => {
  const art: ArtifactRow = { id: 'r1', kind: 'page', title: 'Rate limit design', agent: 'main', count: 1, updatedAt: NOW - 540_000 }
  seed(on, { ...empty, notes: [{ text: 'bodyLimit must run first', agent: 'main', at: NOW }], artifacts: [art] })
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const all = (await texts(ui)).join('\n')
    expect(all).toContain('• bodyLimit must run first')
    expect(all).toContain('↗ Rate limit design')
    expect(all).toContain('page · 9m')
    const header = (await ui.find({ key: 'go-artifacts' }))?.text ?? ''
    expect(header).toContain('ARTIFACTS')
    expect(header.endsWith(' 1')).toBe(true)
    await ui.unmount()
  }
})

test('the TASKS section counts and shows the current and upcoming task', async ($, on) => {
  seed(on, {
    ...empty,
    tasks: [
      task('1', 'Map the upload path', 'completed'),
      task('2', 'Wire the limiter', 'in_progress'),
      task('3', 'Return 429', 'pending'),
      task('4', 'Write docs', 'pending'),
    ],
  })
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const all = (await texts(ui)).join('\n')
    const header = (await ui.find({ key: 'go-tasks' }))?.text ?? ''
    expect(header).toContain('TASKS')
    expect(header.endsWith(' 1/4')).toBe(true)
    expect(all).toContain('▶ Wire the limiter')
    expect(all).toContain('2m')
    expect(all).toContain('○ Return 429')
    expect(all).toContain('✔ 1 done · ○ 1 more')
    await ui.unmount()
  }
})

test('pressing go-agents writes ui.tab = agents', async ($, on) => {
  const stored = seed(on, empty)
  for (const surface of SURFACES) {
    reset(stored, { ...empty, agents: { main, a1: agent('a1', 'Explore', 'x', 'y') } })
    const ui = await mount($, surface)
    await ui.press({ key: 'go-agents' })
    expect((stored.get('ui') as UiState).tab).toBe('agents')
    await ui.unmount()
  }
})

test('pressing a latest step opens its detail in the timeline', async ($, on) => {
  const stored = seed(on, empty)
  for (const surface of SURFACES) {
    reset(stored, { ...empty, steps: [step('s1', 1, 'Edit a.ts', 'done')] })
    const ui = await mount($, surface)
    await ui.press({ key: 'step-s1' })
    const u = stored.get('ui') as UiState
    expect(u.tab).toBe('timeline')
    expect(u.detail?.stepId).toBe('s1')
    await ui.unmount()
  }
})

test('pressing tab-tasks writes ui.tab', async ($, on) => {
  const stored = seed(on, empty)
  for (const surface of SURFACES) {
    reset(stored, empty)
    const ui = await mount($, surface)
    await ui.press({ key: 'tab-tasks' })
    expect((stored.get('ui') as UiState).tab).toBe('tasks')
    await ui.unmount()
  }
})

test('the Artifacts tab keeps the tab row', async ($, on) => {
  seed(on, empty, {
    tab: 'artifacts', filter: { kind: 'all' }, agentsMode: 'list', folded: [], openTurns: [],
    dismissed: [], query: '', runningOnly: false, notified: [], toasted: [],
  })
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect((await texts(ui)).join('\n')).toContain('No artifacts yet.')
    expect(await ui.find({ key: 'tab-overview' })).toBeDefined()
    expect(await ui.find({ key: 'tab-artifacts' })).toBeDefined()
    await ui.unmount()
  }
})

test('the tab labels shorten below 56 columns', async ($, on) => {
  seed(on, empty)
  for (const surface of SURFACES) {
    const wide = await mount($, surface, 62)
    expect((await wide.find({ key: 'tab-overview' }))?.text).toContain('Overview')
    await wide.unmount()
    const narrow = await mount($, surface, 40)
    const label = (await narrow.find({ key: 'tab-overview' }))?.text ?? ''
    expect(label).toContain('Ove')
    expect(label).not.toContain('Overview')
    await narrow.unmount()
  }
})

test('an empty session at bodyColumns 24 keeps Idle within 24', async ($, on) => {
  seed(on, empty)
  for (const surface of SURFACES) {
    const ui = await mount($, surface, 24)
    const found = [...(await ui.findAll({ type: 'Text' })), ...(await ui.findAll({ type: 'Button' }))]
    expect(found.some(f => (f.text ?? '').startsWith('Idle'))).toBe(true)
    for (const f of found) expect((f.text ?? '').length <= 24).toBe(true)
    await ui.unmount()
  }
})

test('at bodyColumns 24 no Text or Button is longer than 24', async ($, on) => {
  seed(on, {
    ...empty,
    now: {
      focus: 'Wiring the limiter into the chain with a very long sentence',
      next: 'Return 429 with Retry-After and more',
      at: NOW - 20_000,
    },
    tasks: [
      task('1', 'Map the upload path and everything around it', 'completed'),
      task('2', 'Wire the limiter into the chain of middleware', 'in_progress'),
      task('3', 'Return 429 with Retry-After header please', 'pending'),
    ],
    agents: {
      main,
      a1: agent('a1', 'general-purpose', 'write limiter tests for the endpoint', 'Edit test/rateLimit.test.ts now'),
    },
    steps: [step('s1', 1, 'Bash npm test -- rateLimit --watch --verbose', 'error', { pin: 'a long note about it' })],
    notes: [{ text: 'upload() is reached from three routes today', agent: 'a1', at: NOW }],
    artifacts: [
      {
        id: 'r1',
        kind: 'document',
        title: 'docs/rate-limit-plan-with-a-long-name.md',
        agent: 'main',
        count: 1,
        updatedAt: NOW - 700_000,
      },
    ],
  })
  for (const surface of SURFACES) {
    const ui = await mount($, surface, 24)
    const found = [...(await ui.findAll({ type: 'Text' })), ...(await ui.findAll({ type: 'Button' }))]
    expect(found.length > 10).toBe(true)
    for (const f of found) expect((f.text ?? '').length <= 24).toBe(true)
    await ui.unmount()
  }
})

test('/mc opens the pane with focus', async ($, on) => {
  seed(on, empty)
  const opened: Record<string, unknown>[] = []
  on('ui.open', (_, e) => {
    opened.push(e as unknown as Record<string, unknown>)
    return { value: { isPlaced: true as const } }
  })

  const got = await $.command.run({ command: 'mc', args: '' } as never)

  expect(got.text).toBe('Mission Control opened.')
  expect(opened.length).toBe(1)
  expect(opened[0]).toMatchObject({ id: 'mission-control', title: 'Mission Control', focus: true, columns: 62, rows: 14 })
})

test('/mc close closes the pane', async ($, on) => {
  seed(on, empty)
  const closed: unknown[] = []
  on('ui.close', (_, e) => {
    closed.push(e)
    return { value: undefined }
  })

  const got = await $.command.run({ command: 'mc', args: 'close' } as never)

  expect(closed.length).toBe(1)
  expect(closed[0]).toMatchObject({ id: 'mission-control' })
  expect(typeof got.text).toBe('string')
})

// What the engine and the world beneath a session.start need.
function sessionWorld(on: On, t: Timeline): {
  stored: Stored
  clock: MockClock
  opened: Record<string, unknown>[]
  registered: Record<string, unknown>[]
} {
  const { stored, clock } = world(on, t)
  const opened: Record<string, unknown>[] = []
  const registered: Record<string, unknown>[] = []
  mock.env(on, {})
  on('ui.open', (_, e) => {
    opened.push(e as unknown as Record<string, unknown>)
    return { value: { isPlaced: false as const, reason: 'narrow' } }
  })
  on('command.register', (_, e) => {
    registered.push(e as unknown as Record<string, unknown>)
    return { value: { command: 'mc' } }
  })
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return { stored, clock, opened, registered }
}

const start = ($: Engine) => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

test('session.start with autoOpen opens the pane without focus; not being placed is no error', { options: { autoOpen: true } }, async ($, on) => {
  const { opened } = sessionWorld(on, empty)

  await start($)

  expect(opened.length).toBe(1)
  expect(opened[0]).toMatchObject({ id: 'mission-control', title: 'Mission Control', columns: 62, rows: 14 })
  expect('focus' in (opened[0] ?? {})).toBe(false)
})

test('session.start without autoOpen opens nothing, and registers /mc as immediate', async ($, on) => {
  const { opened, registered } = sessionWorld(on, empty)

  await start($)

  expect(opened.length).toBe(0)
  expect(registered[0]).toMatchObject({ name: 'mc', immediate: true, argumentHint: '[1-5 | pin <note> | export | close]' })
})

test('the clock invalidates only while a subagent or step runs, and main never counts', async ($, on) => {
  const { stored, clock } = sessionWorld(on, empty)
  let invalidated = 0
  on('ui.invalidate', () => {
    invalidated += 1
    return { value: undefined }
  })

  await start($)
  await clock.advance(3000)
  expect(invalidated).toBe(0)

  stored.set('timeline', { ...empty, steps: [step('s1', 1, 'Bash ls', 'running')] })
  await clock.advance(3000)
  expect(invalidated > 0).toBe(true)

  invalidated = 0
  stored.set('timeline', { ...empty, agents: { main, a1: agent('a1', 'Explore', 'x', 'y', 'done') } })
  await clock.advance(3000)
  expect(invalidated).toBe(0)

  stored.set('timeline', { ...empty, agents: { main, a1: agent('a1', 'Explore', 'x', 'y') } })
  await clock.advance(3000)
  expect(invalidated > 0).toBe(true)
})

type Mounted = Awaited<ReturnType<typeof mount>>
type Found = Awaited<ReturnType<Mounted['findAll']>>[number]

const propsOf = (f: Found | undefined): { color?: string; dimColor?: boolean; backgroundColor?: string } =>
  (f?.props ?? {}) as { color?: string; dimColor?: boolean; backgroundColor?: string }

test('the tab bar has a dim │ between every two tabs and fills the open tab', async ($, on) => {
  seed(on, empty, {
    tab: 'tasks', filter: { kind: 'all' }, agentsMode: 'list', folded: [], openTurns: [],
    dismissed: [], query: '', runningOnly: false, notified: [], toasted: [],
  })
  for (const surface of SURFACES) {
    for (const columns of [62, 24]) {
      const ui = await mount($, surface, columns)
      const found = await ui.findAll({ type: 'Text' })
      const bars = found.filter(f => f.text === '│' && propsOf(f).dimColor === true)
      expect(bars.length).toBe(4)
      const filled = found.filter(f => propsOf(f).backgroundColor === 'suggestion')
      expect(filled.length).toBe(1)
      expect(propsOf(filled[0]).color).toBe('inverseText')
      expect(filled[0]?.text).toContain(columns === 62 ? 'Tasks' : 'Tas')
      const tab = await ui.find({ key: 'tab-tasks' })
      expect(tab?.props).toMatchObject({ hotkey: '2', plain: true })
      await ui.unmount()
    }
  }
})

test('a section header draws label, rule and meta that sum to the columns', async ($, on) => {
  seed(on, { ...empty, tasks: [task('1', 'Map', 'completed'), task('2', 'Wire', 'in_progress')] })
  for (const surface of SURFACES) {
    for (const columns of [62, 24]) {
      const ui = await mount($, surface, columns)
      const header = await ui.find({ key: 'go-tasks' })
      expect((header?.text ?? '').length).toBe(columns)
      const found = await ui.findAll({ type: 'Text' })
      expect(propsOf(found.find(f => f.text === 'TASKS')).color).toBe('suggestion')
      expect(propsOf(found.find(f => (f.text ?? '').startsWith(' ─'))).color).toBe('subtle')
      if (columns === 62) expect(propsOf(found.find(f => f.text === '1/2')).dimColor).toBe(true)
      await ui.unmount()
    }
  }
})

test('progress is a block bar and status glyphs carry their theme colours', async ($, on) => {
  seed(on, {
    ...empty,
    tasks: [task('1', 'Map', 'completed'), task('2', 'Wire', 'in_progress'), task('3', 'Docs', 'pending')],
    steps: [step('s1', 1, 'Bash npm test', 'error')],
    agents: { main, a1: agent('a1', 'Explore', 'find callers', 'Grep upload') },
  })
  for (const surface of SURFACES) {
    const ui = await mount($, surface, 62)
    const found = await ui.findAll({ type: 'Text' })
    const filled = found.find(f => /^█+$/.test(f.text ?? ''))
    const rest = found.find(f => /^░+$/.test(f.text ?? ''))
    expect(propsOf(filled).color).toBe('success')
    expect(propsOf(rest).color).toBe('subtle')
    expect((filled?.text ?? '').length + (rest?.text ?? '').length).toBe(62)
    const glyph = (g: string): (string | undefined)[] => found.filter(f => f.text === g).map(f => propsOf(f).color)
    expect(glyph('▶')).toContain('warning')
    expect(glyph('✖')).toContain('error')
    expect(glyph('✔')).toContain('success')
    expect(propsOf(found.find(f => f.text === '○')).dimColor).toBe(true)
    await ui.unmount()
  }
})

test('at 96 columns the Overview draws two columns and a one-line notes and artifacts summary', async ($, on) => {
  const art: ArtifactRow = { id: 'r1', kind: 'page', title: 'Design', agent: 'main', count: 1, updatedAt: NOW }
  seed(on, {
    ...empty,
    now: { focus: 'Wiring', at: NOW },
    tasks: [task('1', 'Map', 'completed'), task('2', 'Wire', 'in_progress')],
    agents: { main, a1: agent('a1', 'Explore', 'find callers', 'Grep upload') },
    steps: [step('s1', 1, 'Edit a.ts', 'done')],
    notes: [
      { text: 'n1', agent: 'main', at: NOW },
      { text: 'n2', agent: 'main', at: NOW },
    ],
    artifacts: [art],
  })
  for (const surface of SURFACES) {
    const ui = await mount($, surface, 100)
    expect(await ui.find({ key: 'col-left' })).toBeDefined()
    expect(await ui.find({ key: 'col-right' })).toBeDefined()
    const all = (await texts(ui)).join('\n')
    expect(all).toContain('↓ notes 2 · artifacts 1')
    expect(all).not.toContain('• n1')
    expect(await ui.find({ key: 'go-artifacts' })).toBe(undefined)
    await ui.unmount()
    const narrow = await mount($, surface, 62)
    expect(await narrow.find({ key: 'col-left' })).toBe(undefined)
    expect((await texts(narrow)).join('\n')).toContain('• n1')
    await narrow.unmount()
  }
})
