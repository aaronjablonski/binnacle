import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Step, Timeline, TurnRow, UiState } from '../../types'
import { empty } from '../model/reduce'
import { colOf, screen } from './screen.testkit'

// `/mc keep <note>` and the Keep verb (was Pin): the command's answers, the
// mark on the Steps list and the Kept chip. Moved here from overview.test.tsx
// (the command tests) and timeline.test.tsx.

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
const NOW = 1_000_000
const SHAPES: Record<string, string> = { timeline: 'timeline-4', ui: 'ui-4' }
const HOME = 'C:/Users/test'

type Stored = Map<string, unknown>

// The engine's $.state beneath the mod, seeded and remembering every write.
function world(on: On, t: Timeline, u: UiState): Stored {
  const stored: Stored = new Map()
  stored.set('timeline', t)
  stored.set('ui', u)
  const versions = new Map<string, number>()
  mock.clock(on, { now: NOW })
  mock.env(on, { USERPROFILE: HOME, OS: 'Windows_NT' })
  on('ui.log', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'sess-1' }))
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
  return stored
}

const UI: UiState = {
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
  slim: false,
}

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

function twoTurns(): Timeline {
  return {
    ...empty,
    turns: [turn('t1', 'what does the upload endpoint accept today?', NOW - 900_000), turn('t2', 'add rate limiting', NOW - 60_000)],
    agents: { main: { ...empty.agents.main! } },
    steps: [
      step('s1', 1, 'Read upload.ts', 'done', { turnId: 't1', tool: 'Read' }),
      step('s3', 3, 'Edit rateLimit.ts', 'done', { turnId: 't2' }),
      step('s4', 4, 'Bash npm test', 'done', { turnId: 't2', tool: 'Bash' }),
    ],
  }
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

async function mount($: Engine, surface: (typeof SURFACES)[number], columns = 62) {
  return $.ui.mount({ ...PANE(columns), surface })
}

test('/mc keep note keeps the newest main step; it shows ★ and the Kept chip', async ($, on) => {
  const stored = world(on, twoTurns(), UI)
  const got = await $.command.run({ command: 'mc', args: 'keep the limiter itself' } as never)
  expect(got.text).toBe('Kept: Bash npm test')
  const t = stored.get('timeline') as Timeline
  expect(t.steps.find(s => s.id === 's4')?.pin).toBe('the limiter itself')
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const rows = screen(await ui.drawn()).slice(3) // under the tab bar, track and blank row
    // Kept steps draw ★ where the glyph goes; the chip is on the second cell.
    expect(colOf(rows.find(r => r.includes('npm test')), '★')).toBe(2)
    expect(colOf(rows[2], 'Kept 1')).toBe(14)
    expect(rows.join('\n')).not.toContain('Pinned')
    await ui.unmount()
  }
})

test('/mc keep with no note keeps with an empty note, and skips a subagent step', async ($, on) => {
  const t = twoTurns()
  t.agents.a1 = { id: 'a1', parent: 'main', type: 'Explore', description: 'x', status: 'done', startedAt: NOW - 60_000, doing: '', stepCount: 1 }
  t.steps.push(step('s5', 5, 'Grep later', 'done', { turnId: 't2', agent: 'a1', tool: 'Grep' }))
  const stored = world(on, t, UI)
  const got = await $.command.run({ command: 'mc', args: 'keep' } as never)
  expect(got.text).toBe('Kept: Bash npm test')
  const after = stored.get('timeline') as Timeline
  expect(after.steps.find(s => s.id === 's4')?.pin).toBe('')
  expect(after.steps.find(s => s.id === 's5')?.pin).toBeUndefined()
})

test('/mc keep with no steps says Nothing to keep yet.', async ($, on) => {
  world(on, empty, UI)
  const got = await $.command.run({ command: 'mc', args: 'keep' } as never)
  expect(got.text).toBe('Nothing to keep yet.')
})

test('a kept step that failed keeps its ✖ (the failure outranks the mark) and still counts in Kept', async ($, on) => {
  const t = twoTurns()
  t.steps = t.steps.map(s => (s.id === 's4' ? { ...s, status: 'error' as const } : s))
  world(on, t, UI)
  await $.command.run({ command: 'mc', args: 'keep' } as never)
  const ui = await mount($, 'terminal')
  const rows = screen(await ui.drawn()).slice(3)
  expect(colOf(rows.find(r => r.includes('npm test')), '✖')).toBe(2)
  expect(colOf(rows[2], 'Kept 1')).toBe(14)
  await ui.unmount()
})
