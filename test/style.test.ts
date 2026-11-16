import { expect, test } from 'vitest'

import { C } from '../mod/hooks/views/style'

test('the palette names theme keys only', () => {
  expect(C).toEqual({
    accent: 'suggestion',
    live: 'suggestion',
    wait: 'warning',
    fail: 'error',
    model: 'merged',
    result: 'success',
    subtle: 'subtle',
    error: 'error',
    doc: 'merged',
    rule: 'subtle',
    lead: 'claude',
    spark: 'claude',
    inverse: 'inverseText',
  })
})
