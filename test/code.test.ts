import { expect, test } from 'vitest'

import { clean, cutChars, diffOf } from '../mod/hooks/model/code'
import { clock } from '../mod/hooks/views/fit'

test('clean turns CRLF into LF and drops the other control characters', () => {
  expect(clean('a\r\nb\rc\u0000d\te\u001bf')).toBe('a\nbcd\tef')
})

test('clean drops colour escapes whole', () => {
  expect(clean('\u001b[31mred\u001b[0m ok')).toBe('red ok')
})

test('cutChars says how many characters it left out', () => {
  expect(cutChars('abcdef', 4)).toEqual({ text: 'abcd', cut: 2 })
})

test('diffOf writes a real header with counts from the line lists', () => {
  const d = diffOf('a\nb\n', 'x\ny\nz', 10_000)
  expect(d.source).toBe('@@ -1,2 +1,3 @@\n-a\n-b\n+x\n+y\n+z')
  expect(d.cut).toBe(0)
})

test('diffOf with nothing removed starts the old side at 0', () => {
  expect(diffOf('', 'x', 10_000).source).toBe('@@ -0,0 +1,1 @@\n+x')
})

test('diffOf cut by whole lines fixes the header', () => {
  const before = Array.from({ length: 50 }, (_, i) => `old line ${i}`).join('\n')
  const after = Array.from({ length: 50 }, (_, i) => `new line ${i}`).join('\n')
  const d = diffOf(before, after, 400)
  const lines = d.source.split('\n')
  const header = lines[0]!
  const body = lines.slice(1)
  const minus = body.filter(l => l.startsWith('-')).length
  const plus = body.filter(l => l.startsWith('+')).length
  expect(header).toBe(`@@ -${minus === 0 ? 0 : 1},${minus} +${plus === 0 ? 0 : 1},${plus} @@`)
  expect(d.cut).toBe(100 - body.length)
  expect(d.cut > 0).toBe(true)
  expect(d.source.length <= 400).toBe(true)
})

test('diffOf of two empty texts is empty', () => {
  expect(diffOf('', '', 1000)).toEqual({ source: '', cut: 0 })
})

test('clock reads hh:mm and hh:mm:ss', () => {
  expect(clock(1_000_000)).toMatch(/^\d\d:\d\d$/)
  expect(clock(1_000_000, true)).toMatch(/^\d\d:\d\d:\d\d$/)
})
