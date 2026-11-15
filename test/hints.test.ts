import { expect, test } from 'vitest'

import { fitHints } from '../mod/hooks/views/hints'

const key = (hotkey: string, label: string) => ({ hotkey, label, key: `hint-${hotkey}`, onPress: () => undefined })

test('three hints that fit are all kept, in order', () => {
  const hints = [{ text: '↵ open' }, key('d', 'all done'), key('e', 'export')]
  expect(fitHints(hints, 62)).toEqual(hints)
})

test('a narrow footer gives up the engine-key text first, so the hotkeys stay', () => {
  const hints = [{ text: '↵ open' }, key('d', 'newest 3'), key('e', 'export')]
  const kept = fitHints(hints, 32)
  expect(kept.map(h => ('hotkey' in h ? h.hotkey : h.text))).toEqual(['d', 'e'])
})

test('with no text left it drops from the end, and always keeps one', () => {
  const hints = [key('d', 'all done'), key('e', 'export')]
  expect(fitHints(hints, 16).map(h => ('hotkey' in h ? h.hotkey : h.text))).toEqual(['d'])
  expect(fitHints(hints, 2)).toHaveLength(1)
})

test('only 3 hints are ever kept', () => {
  expect(fitHints([key('a', 'a'), key('b', 'b'), key('c', 'c'), key('d', 'd')], 80)).toHaveLength(3)
})
