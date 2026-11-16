import { expect, test } from 'claude-code/testing'

import { empty } from '../model/reduce'
import { weekSpec } from './budget'
import { restingSpec } from './overview'
import { decode, encode, PALETTE } from './raster'
import type { Grid } from './raster'

// FX4: the week chart and the resting row take the ground's palette, as the other pieces do.

const colours = (g: Grid): Set<number> => new Set(decode(encode(g)).flatMap(([, fg, bg]) => [fg, bg]))
const DAYS = [
  { day: '2026-11-10', tokens: { 'claude-opus-5-5': 400_000 }, total: 500_000, sessions: 1 },
  { day: '2026-11-11', tokens: { 'claude-opus-5-5': 100_000 }, total: 200_000, sessions: 1 },
]

test('ground day: the week chart draws day colours, never the night iris', () => {
  const g = weekSpec(DAYS, 'day').spec.frames()[0]!
  expect(g.pal).toEqual(PALETTE.day)
  expect(colours(g).has(PALETTE.day.iris)).toBe(true)
  expect(colours(g).has(PALETTE.night.iris)).toBe(false)
})

test('ground night (and no ground): the week chart is as before, night colours', () => {
  for (const g of [weekSpec(DAYS, 'night').spec.frames()[0]!, weekSpec(DAYS).spec.frames()[0]!]) {
    expect(g.pal).toEqual(PALETTE.night)
    expect(colours(g).has(PALETTE.night.iris)).toBe(true)
  }
})

test('the week chart redraws when the ground changes: its sig names the ground', () => {
  expect(weekSpec(DAYS, 'day').spec.sig).not.toBe(weekSpec(DAYS, 'night').spec.sig)
})

test('ground day: the resting row is built on the day palette', () => {
  expect(restingSpec(empty, 'day').frames()[0]!.pal).toEqual(PALETTE.day)
  expect(restingSpec(empty, 'night').frames()[0]!.pal).toEqual(PALETTE.night)
  expect(restingSpec(empty, 'day').sig).not.toBe(restingSpec(empty, 'night').sig)
})
