import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { PrState, Timeline, UiState } from '../../types'
import { initialUi } from '../state'
import { busy, NOW } from './now.fixtures.testkit'
import { stackWindow } from './prblock'
import { keepLog, LOGS, screen } from './screen.testkit'

// R46: the Pull request block on Now, the band chip, and the stack cursor.

const SHAPES: Record<string, string> = { timeline: 'timeline-4', ui: 'ui-4', pr: 'pr-1' }
type Stored = Map<string, unknown>

function world(on: On, t: Timeline, pr: PrState | undefined, u: UiState = initialUi): Stored {
  const stored: Stored = new Map<string, unknown>([['timeline', t], ['ui', u], ...(pr !== undefined ? [['pr', pr] as [string, unknown]] : [])])
  const versions = new Map<string, number>()
  mock.clock(on, { now: NOW })
  LOGS.length = 0
  on('ui.log', keepLog)
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

const PANE = (columns: number, rows: number) =>
  ({
    plugin: 'binnacle', component: 'Pane', requestId: 'binnacle',
    props: { title: 'Binnacle', isFocused: true, bodyColumns: columns, placement: 'dock', scroll: { offset: 0, bodyRows: rows }, view: {} },
  }) as const
const mount = ($: Engine, cols = 62, rows = 46) => $.ui.mount({ ...PANE(cols, rows), surface: 'terminal' })

const SINGLE: PrState = {
  at: NOW, branch: 'feat/limiter',
  current: { number: 123, title: 'Rate limit the upload route', url: 'https://github.com/o/r/pull/123', head: 'feat/limiter', state: 'open', checks: 'pass', review: 'approved' },
}

const STACK: PrState = {
  at: NOW, branch: 's2',
  current: { number: 121, title: 'Stack part two', url: 'https://github.com/o/r/pull/121', head: 's2', state: 'open', checks: 'fail' },
  stack: {
    trunk: 'main',
    items: [
      { branch: 's1', number: 120, url: 'https://github.com/o/r/pull/120', title: 'Stack part one', state: 'merged', checks: 'pass' },
      { branch: 's2', number: 121, url: 'https://github.com/o/r/pull/121', title: 'Stack part two', state: 'open', checks: 'fail' },
      { branch: 's3', number: 122, url: 'https://github.com/o/r/pull/122', title: 'Stack part three', state: 'open', draft: true, checks: 'pending' },
    ],
  },
}

test('no PR state: no Pull request block', async ($, on) => {
  world(on, busy(), undefined)
  const ui = await mount($)
  expect((await screen(await ui.drawn())).join('\n')).not.toContain('Pull request')
  await ui.unmount()
})

test('a single PR: the head with number, state, checks and review, then the title', async ($, on) => {
  world(on, busy(), SINGLE)
  const ui = await mount($)
  const rows = screen(await ui.drawn())
  const at = rows.findIndex(r => r.includes('Pull request'))
  expect(at).toBeGreaterThan(0)
  expect(rows[at]).toContain('#123 open · ✓ checks · approved')
  expect(rows[at + 1]!.trim()).toBe('Rate limit the upload route')
  // R47: the PR comes before To do.
  expect(rows.findIndex(r => r.includes('To do'))).toBeGreaterThan(at)
  await ui.unmount()
})

test('a stack: the members from the trunk up, the cursor on the current branch; l moves it and the head follows', async ($, on) => {
  const stored = world(on, busy(), STACK)
  const ui = await mount($)
  let rows = screen(await ui.drawn())
  const at = rows.findIndex(r => r.includes('Pull request'))
  expect(rows[at]).toContain('#121 open · ✗ checks')
  expect(rows[at + 2]!.trim()).toBe('main › ✓#120 › ▸○#121 › ◌#122')
  // A hotkey is one digit or one lowercase letter (the engine refuses `[` and `]`): h and l step the stack.
  const keys = (await ui.findAll({ type: 'Button' })).map(b => (b.props as { hotkey?: string }).hotkey).filter(Boolean)
  expect(keys).toEqual(expect.arrayContaining(['o', 'h', 'l']))
  await ui.press({ key: 'arm-hint-pr-next' })
  expect((stored.get('ui') as UiState).prCursor).toBe('s3')
  await ui.redraw()
  rows = screen(await ui.drawn())
  expect(rows[at]).toContain('#122 draft · … checks')
  expect(rows[at + 1]!.trim()).toBe('Stack part three')
  expect(rows[at + 2]!.trim()).toBe('main › ✓#120 › ○#121 › ▸◌#122')
  await ui.press({ key: 'arm-hint-pr-prev' })
  await ui.press({ key: 'arm-hint-pr-prev' })
  expect((stored.get('ui') as UiState).prCursor).toBe('s1')
  await ui.unmount()
})

test('stackWindow keeps the cursor in view and drops the trunk first', () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ branch: `b${i}`, number: 100 + i, state: 'open' as const }))
  const w = stackWindow('main', items, 9, 40)
  expect(w.from).toBeLessThanOrEqual(9)
  expect(w.to).toBeGreaterThanOrEqual(9)
  expect(w.trunk).toBe(false)
  const all = stackWindow('main', items.slice(0, 3), 0, 60)
  expect(all).toEqual({ from: 0, to: 2, trunk: true })
})
