import { describe, expect, it } from 'vitest'

import { arrowTarget, isArrowScroll } from '../mod/hooks/views/ring'

// R54: the arrows always walk rows, never the window.

describe('isArrowScroll', () => {
  it('is the person, one row, no pointer', () => {
    expect(isArrowScroll({ origin: { kind: 'person' }, by: 1 })).toBe(true)
    expect(isArrowScroll({ origin: { kind: 'person' }, by: -1 })).toBe(true)
  })
  it('is not the wheel, a page key, Home or End, or a plugin', () => {
    expect(isArrowScroll({ origin: { kind: 'person' }, by: 1, pointer: { row: 3, column: 4 } })).toBe(false)
    expect(isArrowScroll({ origin: { kind: 'person' }, by: 30 })).toBe(false)
    expect(isArrowScroll({ origin: { kind: 'person' }, by: -120 })).toBe(false)
    expect(isArrowScroll({ origin: { kind: 'plugin' }, by: 1 })).toBe(false)
  })
})

describe('arrowTarget', () => {
  const s = { order: ['tab-overview', 'tab-tasks', 'row-a', 'row-b', 'row-c', 'arm-x'], tabs: ['tab-overview', 'tab-tasks', 'arm-x'], start: 'row-a' }
  it('steps one content row, held at the ends', () => {
    expect(arrowTarget(s, 'row-a', 1)).toBe('row-b')
    expect(arrowTarget(s, 'row-b', -1)).toBe('row-a')
    expect(arrowTarget(s, 'row-c', 1)).toBe('row-c')
    expect(arrowTarget(s, 'row-a', -1)).toBe('row-a')
  })
  it('from no row or a tab: down to the start, up to the last row', () => {
    expect(arrowTarget(s, undefined, 1)).toBe('row-a')
    expect(arrowTarget(s, 'tab-tasks', 1)).toBe('row-a')
    expect(arrowTarget(s, undefined, -1)).toBe('row-c')
  })
  it('never lands on a tab or a hidden arm, and is undefined with no rows', () => {
    expect(arrowTarget(s, 'row-c', -1)).toBe('row-b')
    expect(arrowTarget({ order: ['tab-overview'], tabs: ['tab-overview'] }, undefined, 1)).toBe(undefined)
  })
})
