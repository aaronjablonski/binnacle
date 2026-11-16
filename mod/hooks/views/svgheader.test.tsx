import { expect, test } from 'claude-code/testing'

import type { Timeline } from '../../types'
import { empty } from '../model/reduce'
import { initialUi } from '../state'
import { PALETTE } from './raster'
import { deckModel, nowDeckAlt, nowDeckSvg, SVG_MAX } from './svg'
import { deckHead } from './svgview'

// I-5: the desktop Now Svg is the cockpit header, in the pane's words, on the pane's ground.

const NOW = 5_000_000
const hex = (n: number): string => `#${n.toString(16).padStart(6, '0')}`

const working: Timeline = {
  ...empty,
  now: { focus: 'Wiring the limiter into the middleware chain', at: NOW - 60_000 },
  turns: [{ id: 't1', agent: 'main', prompt: 'go', startedAt: NOW - 3 * 60_000 }],
  steps: [{ id: 's1', seq: 1, agent: 'main', tool: 'Bash', label: 'Bash npm run build --silent', status: 'running', startedAt: NOW - 5000 }],
  tasks: [
    { id: '1', subject: 'one', status: 'completed', owner: 'main', updatedAt: NOW },
    { id: '2', subject: 'two', status: 'in_progress', owner: 'main', updatedAt: NOW },
  ],
  budget: { contextPct: 12, windows: [{ name: 'five_hour', pct: 40 }], at: NOW },
}
const waiting: Timeline = {
  ...working,
  steps: [{ id: 's2', seq: 2, agent: 'main', tool: 'Bash', label: 'Bash rm -rf build', status: 'running', startedAt: NOW - 90_000, asking: NOW - 90_000 }],
}
const stopped: Timeline = {
  ...working,
  steps: [],
  turns: [{ id: 't1', agent: 'main', prompt: 'go', startedAt: NOW - 300_000, endedAt: NOW - 1000, failed: true }],
  failure: { turnId: 't1', reason: 'The API is overloaded' },
}
const quiet: Timeline = {
  ...working,
  steps: [],
  turns: [{ id: 't1', agent: 'main', prompt: 'go', startedAt: NOW - 410_000 }],
}

/** The header's words as the pane's own functions give them: the same words reach the Svg. */
const D = (t: Timeline): ReturnType<typeof deckHead> => deckHead({ t, u: initialUi, now: NOW })
const svgOf = (t: Timeline, g: 'night' | 'day' = 'night'): string => nowDeckSvg(t, initialUi, NOW, 62, D(t), g)
const textsOf = (svg: string): string => [...svg.matchAll(/<text[^>]*>(.*?)<\/text>/g)].map(m => m[1]!.replace(/<[^>]+>/g, '')).join(' | ')

test('the pill says what the pane says: WORKING, and WAITING FOR YOU with the wait', () => {
  expect(deckModel(working, initialUi, NOW, D(working)).pill.word).toBe('WORKING')
  const w = deckModel(waiting, initialUi, NOW, D(waiting))
  expect(w.pill).toEqual({ word: 'WAITING FOR YOU', hue: 'amber' })
  expect(w.meta.map(r => r.text).join('')).toBe('1 min')
  const said = textsOf(svgOf(waiting))
  expect(said).toContain('WAITING FOR YOU')
  expect(said).toContain('1 min')
  expect(said).not.toMatch(/WAITING( |$| \|)(?!FOR)/)
})

test('STOPPED carries its reason in the stop colour', () => {
  const svg = svgOf(stopped)
  expect(textsOf(svg)).toContain('STOPPED')
  expect(textsOf(svg)).toContain('The API is overloaded')
  expect(textsOf(svg)).toContain('Stopped by an error')
  expect(svg).toContain(`fill="${hex(PALETTE.night.red)}"`)
  expect(nowDeckAlt(stopped, initialUi, NOW, D(stopped))).toContain('STOPPED, The API is overloaded')
})

test('a long quiet shows beside the turn time (R7), in whole minutes (R27)', () => {
  const said = textsOf(svgOf(quiet))
  expect(said).toContain('quiet 6 min')
  expect(said).toContain('this turn')
  expect(nowDeckAlt(quiet, initialUi, NOW, D(quiet))).toContain('quiet 6 min')
})

test('there is no running-step line and no "turn 3 · 12m" counter, in the Svg or its alt', () => {
  for (const t of [working, waiting, quiet]) {
    const svg = svgOf(t)
    const alt = nowDeckAlt(t, initialUi, NOW, D(t))
    expect(svg).not.toContain('▸')
    expect(textsOf(svg)).not.toMatch(/npm run build|rm -rf|sleep 900/)
    expect(textsOf(svg)).not.toMatch(/turn \d/)
    expect(textsOf(svg)).not.toMatch(/\b\d+m\b/)
    expect(alt).not.toContain('Running')
    expect(alt).not.toMatch(/turn \d|npm run build|rm -rf/)
  }
  const m = deckModel(working, initialUi, NOW, D(working)) as unknown as Record<string, unknown>
  for (const k of ['step', 'right', 'next', 'cache', 'steps']) expect(k in m).toBe(false)
})

test('the header carries the kicker, the goal, the budget line and the two gauges in the pane\'s words', () => {
  const said = textsOf(svgOf(working))
  expect(said).toContain('Working on')
  expect(said).toContain('Wiring the limiter')
  expect(said).toContain('context 12% used')
  expect(said).toContain('context')
  expect(said).toContain('5 hours')
  expect(said).toContain('40%')
  expect(said).not.toMatch(/CTX|5H/)
})

test('the alt says the same words as the header', () => {
  const alt = nowDeckAlt(waiting, initialUi, NOW, D(waiting))
  expect(alt).toContain('WAITING FOR YOU, 1 min')
  expect(alt).toContain('Paused on: Wiring the limiter')
  expect(alt).toContain('context 12% used')
  expect(alt).toContain('context 12%, 5 hours 40%')
  expect(alt.length).toBeLessThanOrEqual(600)
})

test('the palette is the pane\'s ground: night hexes at night, day hexes on a light theme', () => {
  const night = svgOf(working, 'night')
  const day = svgOf(working, 'day')
  expect(night).toContain(hex(PALETTE.night.ground))
  expect(night).not.toContain(hex(PALETTE.day.ground))
  expect(day).toContain(hex(PALETTE.day.ground))
  expect(day).toContain(hex(PALETTE.day.ink))
  expect(day).not.toContain(hex(PALETTE.night.ground))
  expect(day).not.toContain(hex(PALETTE.night.ink))
})

test('under the limit at every width, even with a huge goal and reason', () => {
  const huge: Timeline = { ...stopped, now: { focus: 'y'.repeat(9000), at: NOW }, failure: { turnId: 't1', reason: 'r'.repeat(120) } }
  for (const t of [working, waiting, stopped, quiet, huge]) {
    for (const cols of [20, 62, 200]) expect(nowDeckSvg(t, initialUi, NOW, cols, D(t)).length).toBeLessThan(SVG_MAX)
  }
})

// Replaces test/svg.test.ts "R2 through deckModel" and "a problem turns the pill amber WAITING": the pill is the pane's own words now, so the engine test reads them through `deckHead`.
test('an ask in auto mode is WORKING until a dialog covers the prompt, then WAITING FOR YOU; outside auto it is WAITING FOR YOU at once', () => {
  const ask: Timeline = { ...working, autoAsk: true, steps: [{ id: 's3', seq: 3, agent: 'main', tool: 'Bash', label: 'Bash rm -rf build', status: 'running', startedAt: NOW - 30_000, asking: NOW - 30_000 }] }
  const word = (t: Timeline, covered: boolean): string => deckModel(t, initialUi, NOW, deckHead({ t, u: initialUi, now: NOW, ...(covered ? { isPromptCovered: true as const } : {}) }), covered).pill.word
  expect(word(ask, false)).toBe('WORKING')
  expect(word(ask, true)).toBe('WAITING FOR YOU')
  const { autoAsk: _auto, ...manual } = ask
  expect(word(manual, false)).toBe('WAITING FOR YOU')
})
