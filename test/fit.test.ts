import { expect, test } from 'vitest'

import { bar, blockBar, elapsed, fit, fitLeft, headerParts, rule } from '../mod/hooks/views/fit'

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

test('rule repeats the line glyph and is empty for no room', () => {
  expect(rule(5)).toBe('─────')
  expect(rule(0)).toBe('')
  expect(rule(-2)).toBe('')
})

test('blockBar fills and rests to the columns', () => {
  expect(blockBar(2, 6, 12)).toEqual({ filled: '████', rest: '░░░░░░░░' })
  expect(blockBar(0, 0, 4)).toEqual({ filled: '', rest: '░░░░' })
  expect(blockBar(6, 6, 3)).toEqual({ filled: '███', rest: '' })
  expect(blockBar(1, 2, 0)).toEqual({ filled: '', rest: '' })
})

test('headerParts sum to the columns, dropping the meta first and then the rule', () => {
  const sum = (p: { label: string; rule: string; meta: string }): number => p.label.length + p.rule.length + p.meta.length
  const wide = headerParts('TASKS', '2/6', 62)
  expect(sum(wide)).toBe(62)
  expect(wide.meta).toBe('2/6')
  expect(wide.rule.startsWith(' ─')).toBe(true)
  expect(wide.rule.endsWith('─ ')).toBe(true)
  const narrow = headerParts('AGENTS', '1 running · 0 done', 24)
  expect(narrow.meta).toBe('')
  expect(sum(narrow)).toBe(24)
  const tight = headerParts('TIMELINE', 'x', 9)
  expect(tight.meta).toBe('')
  expect(tight.rule).toBe('')
  expect(sum(tight)).toBe(8)
  expect(headerParts('ARTIFACTS', '', 9)).toEqual({ label: 'ARTIFACTS', rule: '', meta: '' })
  expect(headerParts('A LONG LABEL', '', 5).label).toBe('A LO…')
})
