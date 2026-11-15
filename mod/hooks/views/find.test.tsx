import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { focusFind, showInChat, stepTarget } from './find'

// The call itself, on the test's `$`: the arguments the engine gets, and what a
// refusal does. The kit's `$` has no toast, so the helper is handed a thin one.
function seat($: Engine) {
  const toasts: string[] = []
  const seat = {
    ui: {
      scroll: (a: Parameters<Engine['ui']['scroll']>[0]) => $.ui.scroll(a),
      toast: (text: string) => void toasts.push(text),
      log: () => undefined,
    },
  }
  return { toasts, seat: seat as never }
}

test('showInChat scrolls to the step row id and centres it', async ($, on) => {
  const { toasts, seat: s } = seat($)
  const calls: unknown[] = []
  on('ui.scroll', ((_: unknown, e: unknown) => {
    calls.push(e)
    return {}
  }) as never)
  await showInChat(s, 'toolu_01')
  expect(calls).toEqual([{ to: { requestId: 'toolu_01' }, block: 'center' }])
  expect(toasts).toEqual([])
})

test('showInChat toasts the reason when the engine denies', async ($, on) => {
  const { toasts, seat: s } = seat($)
  on('ui.scroll', (() => ({ deny: 'not person-initiated' })) as never)
  await showInChat(s, 'toolu_01')
  expect(toasts).toEqual(['Not shown in chat: not person-initiated'])
})

test('showInChat toasts the error when the call fails', async () => {
  const toasts: string[] = []
  const failing = {
    ui: {
      scroll: () => Promise.reject(new Error('boom')),
      toast: (text: string) => void toasts.push(text),
      log: () => undefined,
    },
  }
  await showInChat(failing as never, 'toolu_01')
  expect(toasts).toEqual(['Not shown in chat: boom'])
})

test('focusFind asks the engine to focus the find field of the pane', async ($, on) => {
  const calls: unknown[] = []
  on('ui.focus', ((_: unknown, e: unknown) => {
    calls.push(e)
    return {}
  }) as never)
  const seat = { ui: { focus: (a: Parameters<Engine['ui']['focus']>[0]) => $.ui.focus(a), log: () => undefined } }
  await focusFind(seat as never, 'mission-control')
  expect(calls.length).toBe(1)
  expect(JSON.stringify(calls[0])).toContain('mission-control')
})

test('focusFind logs a refusal and never throws', async () => {
  const logs: string[] = []
  const refusing = { ui: { focus: () => Promise.resolve({ deny: 'not holding the keys' }), log: (m: string) => void logs.push(m) } }
  await focusFind(refusing as never, 'mission-control')
  const throwing = { ui: { focus: () => Promise.reject(new Error('boom')), log: (m: string) => void logs.push(m) } }
  await focusFind(throwing as never, 'mission-control')
  expect(logs.length).toBe(2)
})

test('stepTarget walks the ids and wraps; with no current step n takes the first and p the last', () => {
  const ids = ['a', 'b', 'c']
  expect(stepTarget(ids, undefined, 1)).toBe('a')
  expect(stepTarget(ids, undefined, -1)).toBe('c')
  expect(stepTarget(ids, 'a', 1)).toBe('b')
  expect(stepTarget(ids, 'c', 1)).toBe('a')
  expect(stepTarget(ids, 'a', -1)).toBe('c')
  expect(stepTarget(ids, 'zzz', 1)).toBe('a')
  expect(stepTarget([], 'a', 1)).toBeUndefined()
})
