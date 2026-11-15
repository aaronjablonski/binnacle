import { expect, test } from 'vitest'

import { C, glyphColor } from '../mod/hooks/views/style'

test('the palette names theme keys only', () => {
  expect(C).toEqual({
    accent: 'suggestion',
    live: 'suggestion',
    wait: 'warning',
    fail: 'error',
    model: 'merged',
    result: 'success',
    subtle: 'subtle',
    running: 'warning',
    done: 'success',
    error: 'error',
    doc: 'merged',
    rule: 'subtle',
    tabFg: 'inverseText',
    lead: 'claude',
    spark: 'claude',
    inverse: 'inverseText',
  })
})

test('the deprecated glyphColor keeps the v1 map until wave 2 replaces its callers; it maps every status to a theme key or to none', () => {
  expect(glyphColor('running')).toBe('warning')
  expect(glyphColor('in_progress')).toBe('warning')
  expect(glyphColor('done')).toBe('success')
  expect(glyphColor('completed')).toBe('success')
  expect(glyphColor('error')).toBe('error')
  expect(glyphColor('denied')).toBe('error')
  expect(glyphColor('interrupted')).toBe(undefined)
  expect(glyphColor('pending')).toBe(undefined)
})
