import { expect, test } from 'vitest'

import { windowRows } from '../mod/hooks/model/window'

test('a window in the middle has pad rows on each side', () => {
  expect(windowRows(2000, 500, 30)).toEqual({ from: 480, to: 550 })
})

test('at the top the window starts at 0', () => {
  expect(windowRows(2000, 0, 30)).toEqual({ from: 0, to: 50 })
})

test('an offset past the end gives the last window', () => {
  expect(windowRows(100, 500, 30)).toEqual({ from: 50, to: 100 })
})

test('no rows is an empty window', () => {
  expect(windowRows(0, 0, 30)).toEqual({ from: 0, to: 0 })
})

test('fewer rows than the body draws them all', () => {
  expect(windowRows(10, 0, 30)).toEqual({ from: 0, to: 10 })
})

test('a pad of the body height reaches one body either side', () => {
  expect(windowRows(2000, 500, 40, 40)).toEqual({ from: 460, to: 580 })
})

test('a negative offset reads as the top', () => {
  expect(windowRows(2000, -5, 30)).toEqual({ from: 0, to: 50 })
})
