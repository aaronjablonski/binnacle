import { expect, test } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'

import { isOnScreen, MAX_SHOWN, observeRow, shownCount } from './onscreen'

// The observer is called straight here, with a stand-in for `$` that only
// counts the redraws it schedules. Each test uses ids of its own: the set is
// the module's and outlives a test.

type Fake = { $: EngineInterface; fire: () => void; invalidated: number; scheduled: number }

function fake(): Fake {
  let pending: (() => void) | undefined
  const out: Fake = {
    invalidated: 0,
    scheduled: 0,
    fire: () => {
      const fn = pending
      pending = undefined
      fn?.()
    },
    $: undefined as unknown as EngineInterface,
  }
  out.$ = {
    clock: {
      after: (_ms: number, fn: () => void) => {
        out.scheduled += 1
        pending = fn
        return { cancel: () => (pending = undefined) }
      },
    },
    ui: { invalidate: () => (out.invalidated += 1) },
  } as unknown as EngineInterface
  return out
}

const rowAt = (id: string, onScreen: unknown, surface = 'terminal') => ({
  component: 'ToolUse',
  surface,
  requestId: id,
  props: { tool_use_id: id, tool: 'Bash', input: {}, isRunning: false, isErrored: false, isInterrupted: false, onScreen },
})

const SEEN = { first: 0, last: 3, of: 4 }

test('a row on screen is marked, and unmarked when it leaves, per surface', () => {
  const f = fake()
  observeRow(f.$, rowAt('os-a', SEEN))
  expect(isOnScreen('terminal', 'os-a')).toBe(true)
  expect(isOnScreen('mobile', 'os-a')).toBe(false)

  observeRow(f.$, rowAt('os-a', null))
  expect(isOnScreen('terminal', 'os-a')).toBe(false)
  f.fire()
})

test('a row whose surface does not say leaves the set as it was', () => {
  const f = fake()
  observeRow(f.$, rowAt('os-b', SEEN))
  observeRow(f.$, rowAt('os-b', undefined))
  expect(isOnScreen('terminal', 'os-b')).toBe(true)
  f.fire()
})

test('a redraw is scheduled only when the set changes, and once per burst', () => {
  const f = fake()
  observeRow(f.$, rowAt('os-c1', SEEN))
  observeRow(f.$, rowAt('os-c2', SEEN))
  observeRow(f.$, rowAt('os-c1', SEEN))
  expect(f.scheduled).toBe(1)
  expect(f.invalidated).toBe(0)

  f.fire()
  expect(f.invalidated).toBe(1)

  // Nothing changed: no new redraw.
  observeRow(f.$, rowAt('os-c1', SEEN))
  observeRow(f.$, rowAt('os-c2', SEEN))
  expect(f.scheduled).toBe(1)

  observeRow(f.$, rowAt('os-c2', null))
  expect(f.scheduled).toBe(2)
  f.fire()
})

test('a clock that never calls back does not stop later redraws', () => {
  const f = fake()
  for (let i = 0; i < 100; i++) observeRow(f.$, rowAt(`os-s${i}`, i % 2 === 0 ? SEEN : null))
  expect(f.scheduled > 1).toBe(true)
  f.fire()
})

test('the set stays bounded and drops the oldest first', () => {
  const f = fake()
  const n = MAX_SHOWN + 100
  for (let i = 0; i < n; i++) observeRow(f.$, rowAt(`os-d${i}`, SEEN))

  expect(MAX_SHOWN).toBe(500)
  expect(shownCount() <= MAX_SHOWN).toBe(true)
  expect(isOnScreen('terminal', 'os-d0')).toBe(false)
  expect(isOnScreen('terminal', 'os-d99')).toBe(false)
  expect(isOnScreen('terminal', `os-d${n - 1}`)).toBe(true)
  expect(isOnScreen('terminal', `os-d${n - MAX_SHOWN}`)).toBe(true)
  f.fire()
})

test('a throw inside the observer is swallowed', () => {
  const hostile = {
    get props(): never {
      throw new Error('boom')
    },
  }
  const broken = {
    clock: {
      after: () => {
        throw new Error('no clock')
      },
    },
    ui: {
      invalidate: () => {
        throw new Error('no ui')
      },
    },
  } as unknown as EngineInterface

  expect(() => observeRow(fake().$, hostile)).not.toThrow()
  expect(() => observeRow(fake().$, null)).not.toThrow()
  expect(() => observeRow(broken, rowAt('os-e', SEEN))).not.toThrow()
  expect(isOnScreen('terminal', 'os-e')).toBe(true)
  // A clock that failed does not leave the scheduler stuck.
  const f = fake()
  observeRow(f.$, rowAt('os-e2', SEEN))
  expect(f.scheduled).toBe(1)
})
