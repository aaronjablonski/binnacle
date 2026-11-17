import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { AgentRow, Step, Timeline, UiState } from '../../types'
import { empty } from '../model/reduce'
import { keepLog, LOGS } from './screen.testkit'

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

// A new world for the next surface: the hooks stay, what they hold changes.
function reset(stored: Stored, t: Timeline): void {
  stored.clear()
  stored.set('timeline', t)
}

const PANE = (columns: number) =>
  ({
    plugin: 'binnacle',
    component: 'Pane',
    requestId: 'binnacle',
    props: {
      title: 'Binnacle',
      isFocused: false,
      bodyColumns: columns,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  }) as const

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
    dismissed: [], query: '', runningOnly: false, notified: [], toasted: [], slim: false,
  })
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect((await texts(ui)).join('\n')).toContain('No artifacts yet.')
    expect(await ui.find({ key: 'tab-overview' })).toBeDefined()
    expect(await ui.find({ key: 'tab-artifacts' })).toBeDefined()
    await ui.unmount()
  }
})

test('the tab names are whole from 54 columns, whole short words from 43 and icons below that (R42)', async ($, on) => {
  seed(on, empty)
  for (const surface of SURFACES) {
    const wide = await mount($, surface, 62)
    expect((await wide.find({ key: 'tab-tasks' }))?.text).toBe('Tasks')
    await wide.unmount()
    const full = await mount($, surface, 54)
    expect((await full.find({ key: 'tab-agents' }))?.text).toBe('Agents')
    expect((await full.find({ key: 'tab-artifacts' }))?.text).toBe('Artifacts')
    await full.unmount()
    const mid = await mount($, surface, 46)
    expect((await mid.find({ key: 'tab-tasks' }))?.text).toBe('Tasks')
    expect((await mid.find({ key: 'tab-agents' }))?.text).toBe('Crew')
    expect((await mid.find({ key: 'tab-artifacts' }))?.text).toBe('Files')
    await mid.unmount()
    const icon = await mount($, surface, 34)
    expect((await icon.find({ key: 'tab-tasks' }))?.text).toBe('▣')
    await icon.unmount()
  }
})


test('/binnacle opens the pane with focus', async ($, on) => {
  seed(on, empty)
  const opened: Record<string, unknown>[] = []
  on('ui.open', (_, e) => {
    opened.push(e as unknown as Record<string, unknown>)
    return { value: { isPlaced: true as const } }
  })

  const got = await $.command.run({ command: 'binnacle', args: '' } as never)

  expect(got.text).toBe('Binnacle opened.')
  expect(opened.length).toBe(1)
  expect(opened[0]).toMatchObject({ id: 'binnacle', title: 'Binnacle', focus: true, columns: 62, rows: 14 })
})

test('/binnacle close closes the pane', async ($, on) => {
  seed(on, empty)
  const closed: unknown[] = []
  on('ui.close', (_, e) => {
    closed.push(e)
    return { value: undefined }
  })

  const got = await $.command.run({ command: 'binnacle', args: 'close' } as never)

  expect(closed.length).toBe(1)
  expect(closed[0]).toMatchObject({ id: 'binnacle' })
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
    return { value: { command: 'binnacle' } }
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
  expect(opened[0]).toMatchObject({ id: 'binnacle', title: 'Binnacle', columns: 62, rows: 14 })
  expect('focus' in (opened[0] ?? {})).toBe(false)
})

test('session.start without autoOpen opens nothing, and registers /binnacle as immediate', async ($, on) => {
  const { opened, registered } = sessionWorld(on, empty)

  await start($)

  expect(opened.length).toBe(0)
  expect(registered[0]).toMatchObject({ name: 'binnacle', immediate: true, argumentHint: '[1-5 | keep <note> | export | close | slim | strip | options]' })
})

test('/mc is no longer registered: /binnacle is the one command', async ($, on) => {
  const { registered } = sessionWorld(on, empty)
  await start($)
  expect(registered.map(r => r.name)).toEqual(['binnacle'])
})

// M10 (order changed, meaning kept): the clock stops once nothing is live and only a capture hook's write starts it
// again; this world writes the Timeline directly, so it goes from live to idle: a running subagent, a running step,
// then a done agent and an empty session (main alone), where nothing is invalidated.
test('the clock invalidates only while a subagent or step runs, and main never counts', async ($, on) => {
  const { stored, clock } = sessionWorld(on, { ...empty, agents: { main, a1: agent('a1', 'Explore', 'x', 'y') } })
  let invalidated = 0
  on('ui.invalidate', () => {
    invalidated += 1
    return { value: undefined }
  })

  await start($)
  await clock.advance(3000)
  expect(invalidated > 0).toBe(true)

  invalidated = 0
  stored.set('timeline', { ...empty, steps: [step('s1', 1, 'Bash ls', 'running')] })
  await clock.advance(3000)
  expect(invalidated > 0).toBe(true)

  stored.set('timeline', { ...empty, agents: { main, a1: agent('a1', 'Explore', 'x', 'y', 'done') } })
  await clock.advance(1000)
  invalidated = 0
  await clock.advance(3000)
  expect(invalidated).toBe(0)

  stored.set('timeline', empty)
  await clock.advance(3000)
  expect(invalidated).toBe(0)
})

type Mounted = Awaited<ReturnType<typeof mount>>
type Found = Awaited<ReturnType<Mounted['findAll']>>[number]

const propsOf = (f: Found | undefined): { color?: string; dimColor?: boolean; backgroundColor?: string } =>
  (f?.props ?? {}) as { color?: string; dimColor?: boolean; backgroundColor?: string }

test('the tab bar has no separators and draws the open tab bold in the accent, the others dim', async ($, on) => {
  seed(on, empty, {
    tab: 'tasks', filter: { kind: 'all' }, agentsMode: 'list', folded: [], openTurns: [],
    dismissed: [], query: '', runningOnly: false, notified: [], toasted: [], slim: false,
  })
  for (const surface of SURFACES) {
    for (const columns of [62, 32]) {
      const ui = await mount($, surface, columns)
      const found = await ui.findAll({ type: 'Text' })
      expect(found.filter(f => f.text === '│').length).toBe(0)
      expect(found.filter(f => propsOf(f).backgroundColor !== undefined).length).toBe(0)
      const open = found.filter(f => f.text === (columns === 62 ? 'Tasks' : '▣') && propsOf(f).color === 'suggestion')
      expect(open.length).toBe(1)
      const tab = await ui.find({ key: 'tab-tasks' })
      expect(tab?.props).toMatchObject({ hotkey: '2', plain: true })
      expect((await ui.find({ key: 'tab-overview' }))?.props).toMatchObject({ dimColor: true })
      await ui.unmount()
    }
  }
})

