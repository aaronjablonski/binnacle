import { expect, test } from 'claude-code/testing'

import { empty } from '../model/reduce'
import { initialUi } from '../state'
import { ACCENT_HUES, PALETTE } from './raster'
import { setAccent } from './style'
import { bandSvg, nowDeckSvg } from './svg'
import { deckHead } from './svgview'
import type { Timeline } from '../../types'

// FX4: the desktop Svg's structural accent follows the Accent option; state and role colours stay.

const NOW = 5_000_000
const t: Timeline = {
  ...empty,
  now: { focus: 'Wiring the limiter', at: NOW - 60_000 },
  turns: [{ id: 't1', agent: 'main', prompt: 'go', startedAt: NOW - 300_000 }],
  tasks: [
    { id: '1', subject: 'one', status: 'completed', owner: 'main', updatedAt: NOW },
    { id: '2', subject: 'two', status: 'in_progress', owner: 'main', updatedAt: NOW },
  ],
  budget: { contextPct: 12, windows: [{ name: 'five_hour', pct: 40 }], at: NOW },
}

const hex = (n: number): string => `#${n.toString(16).padStart(6, '0')}`
const docs = (): string[] => [nowDeckSvg(t, initialUi, NOW, 62, deckHead({ t, u: initialUi, now: NOW })), bandSvg(t, initialUi, NOW, 62)]


test('the default accent draws the night iris in the Svg', () => {
  setAccent('iris')
  const all = docs().join('')
  expect(all).toContain(hex(PALETTE.night.iris))
})

test('accent sky: the Svg carries the sky hexes and no night iris, soft or deep', () => {
  setAccent('sky')
  const all = docs().join('')
  expect(all).toContain(hex(ACCENT_HUES.sky.night.iris))
  for (const c of [PALETTE.night.iris, PALETTE.night.irisSoft, PALETTE.night.irisDeep]) expect(all).not.toContain(hex(c))
  // state colours do not move: the ring's red and mint stay what they were
  setAccent('iris')
  const base = docs().join('')
  for (const c of [PALETTE.night.mint, PALETTE.night.red, PALETTE.night.amber]) expect(all.includes(hex(c))).toBe(base.includes(hex(c)))
})
