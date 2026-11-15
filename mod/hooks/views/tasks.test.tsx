import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { AgentRow, TaskItem, Timeline, UiState } from '../../types'
import { empty } from '../model/reduce'

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

const TASKS_UI: UiState = {
  tab: 'tasks', filter: { kind: 'all' }, agentsMode: 'list', folded: [], openTurns: [],
  dismissed: [], query: '', runningOnly: false, notified: [], toasted: [], slim: false,
}

test('shows a completed, an in-progress and a pending task with their glyphs', async ($, on) => {
  seed(
    on,
    {
      ...empty,
      tasks: [
        task('1', 'Map the upload path', 'completed'),
        task('2', 'Wire the limiter', 'in_progress', { activeForm: 'Wiring the limiter' }),
        task('3', 'Return 429', 'pending'),
      ],
    },
    TASKS_UI,
  )
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const all = (await texts(ui)).join('\n')
    expect(all).toContain('✔ Map the upload path')
    expect(all).toContain('▶ Wiring the limiter')
    expect(all).toContain('2m')
    expect(all).toContain('○ Return 429')
    expect(all).toContain('TASKS')
    expect(all).toContain('1/3')
    await ui.unmount()
  }
})

test('nests an agent and its doing line under the in-progress task', async ($, on) => {
  seed(
    on,
    {
      ...empty,
      tasks: [task('2', 'Wire the limiter', 'in_progress')],
      agents: { main, a1: { ...agent('a1', 'Explore', 'find callers', 'Grep upload'), taskId: '2' } },
    },
    TASKS_UI,
  )
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const all = await texts(ui)
    expect(all).toContain('  └ Explore · find callers')
    expect(all).toContain('      ▶ Grep upload')
    await ui.unmount()
  }
})

test("nests an agent's own tasks under it", async ($, on) => {
  seed(
    on,
    {
      ...empty,
      tasks: [
        task('2', 'Wire the limiter', 'in_progress'),
        task('t1', 'Read the helpers', 'completed', { owner: 'a1' }),
        task('t2', 'Cover burst', 'in_progress', { owner: 'a1' }),
        task('t3', 'Cover per-user keys', 'pending', { owner: 'a1' }),
      ],
      agents: { main, a1: { ...agent('a1', 'general-purpose', 'write tests', 'Edit a.ts'), taskId: '2' } },
    },
    TASKS_UI,
  )
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const all = await texts(ui)
    expect(all).toContain('      ✔ Read the helpers')
    expect(all).toContain('      ▶ Cover burst')
    expect(all).toContain('      ○ Cover per-user keys')
    await ui.unmount()
  }
})

test('empty state text', async ($, on) => {
  seed(on, empty, TASKS_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect((await texts(ui)).join('\n')).toContain('No tasks yet. They appear when Claude writes a task list.')
    await ui.unmount()
  }
})

test('narrow: no Text longer than 32', async ($, on) => {
  seed(
    on,
    {
      ...empty,
      tasks: [
        task('1', 'Map the upload path and everything around it', 'completed'),
        task('2', 'Wire the limiter into the chain of middleware', 'in_progress', {
          activeForm: 'Wiring the limiter into the chain',
        }),
        task('3', 'Return 429 with Retry-After header please', 'pending'),
        task('t1', 'Cover per-user keys and burst windows', 'pending', { owner: 'a1' }),
      ],
      agents: {
        main,
        a1: {
          ...agent('a1', 'general-purpose', 'write limiter tests for the endpoint', 'Edit test/rateLimit.test.ts now'),
          taskId: '2',
        },
      },
    },
    TASKS_UI,
  )
  for (const surface of SURFACES) {
    const ui = await mount($, surface, 32)
    const found = await ui.findAll({ type: 'Text' })
    expect(found.length >= 8).toBe(true)
    for (const f of found) expect((f.text ?? '').length <= 32).toBe(true)
    await ui.unmount()
  }
})

type Mounted = Awaited<ReturnType<typeof mount>>
type Found = Awaited<ReturnType<Mounted['findAll']>>[number]
const propsOf = (f: Found | undefined): { color?: string; dimColor?: boolean; bold?: boolean; justifyContent?: string } =>
  (f?.props ?? {}) as { color?: string; dimColor?: boolean; bold?: boolean; justifyContent?: string }

const MIXED: Timeline = {
  ...empty,
  tasks: [
    task('1', 'Map the upload path', 'completed'),
    task('2', 'Wire the limiter', 'in_progress', { activeForm: 'Wiring the limiter' }),
    task('3', 'Return 429', 'pending'),
  ],
  agents: { main, a1: { ...agent('a1', 'Explore', 'find callers', 'Grep upload'), taskId: '2' } },
}

test('task glyphs carry their status colours and a pending task is dim', async ($, on) => {
  seed(on, MIXED, TASKS_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const found = await ui.findAll({ type: 'Text' })
    expect(propsOf(found.find(f => f.text === '✔')).color).toBe('success')
    expect(found.filter(f => f.text === '▶').map(f => propsOf(f).color)).toContain('warning')
    expect(propsOf(found.find(f => f.text === '○')).dimColor).toBe(true)
    await ui.unmount()
  }
})

test('the in-progress task is bold with its age dim on the right of a space-between row', async ($, on) => {
  seed(on, MIXED, TASKS_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const rows = (await ui.findAll({ type: 'Box' })).filter(b => propsOf(b).justifyContent === 'space-between')
    expect(rows.length).toBe(1)
    const found = await ui.findAll({ type: 'Text' })
    expect(propsOf(found.find(f => f.text === '2m')).dimColor).toBe(true)
    expect(propsOf(found.find(f => f.text === ' Wiring the limiter')).bold).toBe(true)
    await ui.unmount()
  }
})

test('the TASKS header is label, rule and meta summing to the columns, and no line passes 32', async ($, on) => {
  seed(on, MIXED, TASKS_UI)
  for (const surface of SURFACES) {
    for (const columns of [62, 32]) {
      const ui = await mount($, surface, columns)
      const found = await ui.findAll({ type: 'Text' })
      const header = found.find(f => (f.text ?? '').startsWith('TASKS ') && (f.text ?? '').length === columns)
      expect(header).toBeDefined()
      expect(propsOf(found.find(f => f.text === 'TASKS')).color).toBe('suggestion')
      expect(propsOf(found.find(f => (f.text ?? '').startsWith(' ─') || (f.text ?? '').startsWith(' ──'))).color).toBe('subtle')
      for (const f of found) {
        for (const line of (f.text ?? '').split('\n')) expect(line.length <= columns).toBe(true)
      }
      await ui.unmount()
    }
  }
})
