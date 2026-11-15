import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Timeline, UiState } from '../../types'
import { empty } from '../model/reduce'

const SHAPES: Record<string, string> = { timeline: 'timeline-2', ui: 'ui-2' }

type Stored = Map<string, unknown>

function world(on: On, t: Timeline, u?: UiState): { stored: Stored; opened: Record<string, unknown>[] } {
  const stored: Stored = new Map()
  stored.set('timeline', t)
  if (u) stored.set('ui', u)
  const versions = new Map<string, number>()
  const opened: Record<string, unknown>[] = []
  mock.clock(on, { now: 1_000_000 })
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
  on('ui.open', (_, e) => {
    opened.push(e as unknown as Record<string, unknown>)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', () => ({ value: undefined }))
  return { stored, opened }
}

const run = ($: { command: { run: (a: never) => Promise<{ text: string }> } }, args: string) =>
  $.command.run({ command: 'mc', args } as never)

const FORMS: [string, string, string][] = [
  ['1', 'overview', 'Overview'],
  ['2', 'tasks', 'Tasks'],
  ['3', 'agents', 'Agents'],
  ['4', 'timeline', 'Timeline'],
  ['5', 'artifacts', 'Artifacts'],
  ['overview', 'overview', 'Overview'],
  ['tasks', 'tasks', 'Tasks'],
  ['agents', 'agents', 'Agents'],
  ['timeline', 'timeline', 'Timeline'],
  ['artifacts', 'artifacts', 'Artifacts'],
  ['TASKS', 'tasks', 'Tasks'],
  ['Agents', 'agents', 'Agents'],
  ['ove', 'overview', 'Overview'],
  ['tas', 'tasks', 'Tasks'],
  ['age', 'agents', 'Agents'],
  ['tim', 'timeline', 'Timeline'],
  ['art', 'artifacts', 'Artifacts'],
  ['TIM', 'timeline', 'Timeline'],
]

for (const [arg, tab, label] of FORMS) {
  test(`/mc ${arg} switches to ${tab}, clears detail and opens the pane`, async ($, on) => {
    const { stored, opened } = world(on, empty, { tab: 'timeline', detail: { stepId: 's1' } } as UiState)

    const got = await run($, arg)

    expect(got.text).toBe(`Mission Control: ${label}.`)
    const ui = stored.get('ui') as UiState
    expect(ui.tab).toBe(tab)
    expect(ui.detail).toBe(undefined)
    expect(opened.length).toBe(1)
    expect(opened[0]).toMatchObject({ id: 'mission-control', focus: true })
  })
}

test('/mc with an unknown tab answers and writes nothing', async ($, on) => {
  const { stored, opened } = world(on, empty)

  for (const arg of ['6', '0', 'banana', 'ta']) {
    const got = await run($, arg)
    expect(got.text).toBe('Unknown tab. Try /mc 1-5 or a tab name.')
  }

  expect(stored.has('ui')).toBe(false)
  expect(opened.length).toBe(0)
})

test('/mc close and /mc pin still work', async ($, on) => {
  const { opened } = world(on, empty)

  const closed = await run($, 'close')
  const pinned = await run($, 'pin')

  expect(closed.text).toBe('Mission Control closed.')
  expect(pinned.text).toBe('Nothing to pin yet.')
  expect(opened.length).toBe(0)
})
