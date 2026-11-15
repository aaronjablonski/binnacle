import { expect, test } from 'vitest'

import { bar, elapsed, fit, fitLeft } from '../mod/hooks/views/fit'

test('fit cuts with an ellipsis and never exceeds the columns', () => {
  expect(fit('abcdef', 4)).toBe('abc…')
  expect(fit('abc', 10)).toBe('abc')
  expect(fit('abc', 0)).toBe('')
  expect(fit('abc', -3)).toBe('')
  expect(fit('abcdef', 1)).toBe('…')
})

test('fitLeft cuts from the left', () => {
  expect(fitLeft('src/server/a.ts', 7)).toBe('…r/a.ts')
  expect(fitLeft('src/server/a.ts', 8)).toBe('…er/a.ts')
  expect(fitLeft('a.ts', 8)).toBe('a.ts')
  expect(fitLeft('a.ts', 0)).toBe('')
})

test('elapsed reads as seconds, minutes, hours', () => {
  expect(elapsed(0, 8000)).toBe('8s')
  expect(elapsed(0, 125000)).toBe('2m')
  expect(elapsed(0, 3840000)).toBe('1h04')
  expect(elapsed(5000, 1000)).toBe('0s')
})

test('bar splits the columns', () => {
  expect(bar(2, 6, 36)).toEqual({ filled: 12, rest: 24 })
  expect(bar(0, 0, 10)).toEqual({ filled: 0, rest: 10 })
  expect(bar(9, 3, 10)).toEqual({ filled: 10, rest: 0 })
})
