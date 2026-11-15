import { expect, test } from 'vitest'

import { C, glyphColor } from '../mod/hooks/views/style'

test('the palette names theme keys only', () => {
  expect(C).toEqual({
    accent: 'suggestion',
    running: 'warning',
    done: 'success',
    error: 'error',
    doc: 'merged',
    rule: 'subtle',
    tabFg: 'inverseText',
  })
})

test('glyphColor maps every status to a theme key or to none', () => {
  expect(glyphColor('running')).toBe('warning')
  expect(glyphColor('in_progress')).toBe('warning')
  expect(glyphColor('done')).toBe('success')
  expect(glyphColor('completed')).toBe('success')
  expect(glyphColor('error')).toBe('error')
  expect(glyphColor('denied')).toBe('error')
  expect(glyphColor('interrupted')).toBe(undefined)
  expect(glyphColor('pending')).toBe(undefined)
})
