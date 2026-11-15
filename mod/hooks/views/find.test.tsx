import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { showInChat } from './find'

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
