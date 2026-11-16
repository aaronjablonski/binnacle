import { expect, test } from 'vitest'

import { beadCount, compartments, growLists, levels, listSplit, NOW_SECTIONS, rowsUsed, sectionRows, wrapFull } from '../mod/hooks/views/fit'
import type { SectionCount } from '../mod/hooks/views/fit'
import { SPRITE } from '../mod/hooks/views/raster'
import { DECK, lookOf, spriteOf } from '../mod/hooks/views/style'

// The element tables as `$.ui.resolve(e)` hands them out: every surface's
// table is completed with every element name, and an element the surface
// lacks constructs a Box (a fragment there).
const real = (name: string) => () => ({ type: name })
const missing = () => ({ type: 'Box' })
const NAMES = ['Box', 'Text', 'Button', 'Input', 'Select', 'Link', 'Code', 'Markdown', 'Progress', 'Client', 'Raster', 'Image', 'Svg']
const table = (has: string[]) => Object.fromEntries(NAMES.map(n => [n, has.includes(n) || ['Box', 'Text', 'Button'].includes(n) ? real(n) : missing]))
const TABLES = {
  terminal: table(['Client', 'Raster', 'Image']),
  desktop: table(['Svg', 'Client']),
  vscode: table(['Svg']),
  mobile: table(['Svg']),
  bare: table([]),
}

test('lookOf follows the element table: Raster is rich, Svg is svg, neither is text; a key alone is not enough', () => {
  expect(lookOf(TABLES.terminal)).toBe('rich')
  expect(lookOf(TABLES.desktop)).toBe('svg')
  expect(lookOf(TABLES.vscode)).toBe('svg')
  expect(lookOf(TABLES.mobile)).toBe('svg')
  expect(lookOf(TABLES.bare)).toBe('text')
  expect(lookOf({})).toBe('text')
  expect(lookOf({ Raster: () => { throw new Error('refused') } })).toBe('text')
})

test('lookOf: the text look wins on every table; any other look follows the table', () => {
  for (const t of Object.values(TABLES)) expect(lookOf(t, { look: 'text' })).toBe('text')
  expect(lookOf(TABLES.terminal, { look: 'rich' })).toBe('rich')
  expect(lookOf(TABLES.mobile, { look: 'rich' })).toBe('svg')
  expect(lookOf(TABLES.bare, { look: 'rich' })).toBe('text')
})

const agent = (id: string, type: string, status: 'running' | 'done' | 'error' = 'running') => ({ id, type, status })

test('spriteOf: role from the type, state from the status; working pulses in two frames', () => {
  const s = spriteOf(agent('a1', 'Explore'), 0)
  expect(s.role).toBe('scout')
  expect(s.state).toBe('working')
  expect(s.size).toBe('L')
  expect(s.columns).toBe(SPRITE.L.columns)
  expect(s.rows).toBe(SPRITE.L.rows)
  const frames = s.frames()
  expect(frames).toHaveLength(2)
  expect(frames[0]!.columns).toBe(9)
  expect(frames[0]!.rows).toBe(4)
})

test('spriteOf: main is the lead; a state given overrides the status; still states have one frame', () => {
  expect(spriteOf(agent('main', 'general-purpose'), 0).role).toBe('lead')
  const w = spriteOf(agent('a2', 'code-reviewer'), 0, 'waiting', 'S')
  expect(w.role).toBe('check')
  expect(w.state).toBe('waiting')
  expect(w.columns).toBe(SPRITE.S.columns)
  expect(w.rows).toBe(SPRITE.S.rows)
  expect(w.frames()).toHaveLength(1)
  expect(spriteOf(agent('a3', 'x', 'done'), 0).frames()).toHaveLength(1)
  expect(spriteOf(agent('a3', 'x', 'error'), 0).state).toBe('failed')
})

test('spriteOf: the text fallback is the sprite box, hull and signal on the first row', () => {
  const w = spriteOf(agent('a2', 'Explore'), 0, 'waiting')
  expect(w.fallback).toHaveLength(4)
  for (const r of w.fallback) expect(r.reduce((n, x) => n + x.text.length, 0)).toBe(9)
  expect(w.fallback[0]!.map(r => r.text).join('')).toBe('◉?       ')
  const s = spriteOf(agent('a2', 'Explore'), 0, 'done', 'S')
  expect(s.fallback).toHaveLength(2)
  expect(s.fallback[0]!.map(r => r.text).join('')).toBe('●    ')
})

test('spriteOf: the signature changes with role, state and size, not with the clock', () => {
  const a = spriteOf(agent('a1', 'Explore'), 0)
  const b = spriteOf(agent('a1', 'Explore'), 1000)
  expect(a.sig).toBe(b.sig)
  expect(spriteOf(agent('a1', 'Explore'), 0, 'waiting').sig).not.toBe(a.sig)
  expect(spriteOf(agent('a1', 'Explore'), 0, undefined, 'S').sig).not.toBe(a.sig)
})

test('levels: eighths of the rows, scaled to the largest; any non-zero value shows one', () => {
  expect(levels([0, 5, 10], 1)).toEqual([0, 4, 8])
  expect(levels([0, 5, 10], 3)).toEqual([0, 12, 24])
  expect(levels([1, 1000], 1)).toEqual([1, 8])
  expect(levels([0, 0], 2)).toEqual([0, 0])
  expect(levels([], 2)).toEqual([])
  expect(levels([Number.NaN, -3, 4], 1)).toEqual([0, 0, 8])
})

test('beadCount: any non-zero value lights one, only 100 lights all', () => {
  expect(beadCount(0, 11)).toBe(0)
  expect(beadCount(1, 11)).toBe(1)
  expect(beadCount(50, 11)).toBe(5)
  expect(beadCount(99.9, 11)).toBe(10)
  expect(beadCount(100, 11)).toBe(11)
  expect(beadCount(140, 11)).toBe(11)
  expect(beadCount(Number.NaN, 11)).toBe(0)
  expect(beadCount(50, 0)).toBe(0)
})

const long = (): SectionCount[] => [
  { key: 'latest', count: 30, ...NOW_SECTIONS.latest },
  { key: 'agents', count: 30, ...NOW_SECTIONS.agents },
  { key: 'tasks', count: 30, ...NOW_SECTIONS.tasks },
  { key: 'kept', count: 30, ...NOW_SECTIONS.kept },
  { key: 'notes', count: 30, ...NOW_SECTIONS.notes },
]
// The Now deck and its chrome: tabs 2, the deck 11, a blank after it.
const CHROME = 14
const rowsOf = (got: { key: string; rows: number }[]) => Object.fromEntries(got.map(g => [g.key, g.rows]))

test('sectionRows at 24 rows: the sections that fit, the rest left out, every row used', () => {
  const body = 24 - CHROME
  const got = sectionRows(body, long())
  // LATEST and AGENTS take their floors; TASKS (header, blank, row) does not fit
  // the two rows left, so they go back to the lists dealt first.
  expect(rowsOf(got)).toEqual({ latest: 3, agents: 4 })
  // header + rows each, one blank between sections
  expect(rowsUsed(got)).toBe(body)
})

test('sectionRows at 36 rows: every floor, the spare dealt one at a time in order, every row used', () => {
  const body = 36 - CHROME
  const got = sectionRows(body, long())
  expect(rowsUsed(got)).toBe(body)
  expect(rowsOf(got)).toEqual({ latest: 3, agents: 4, tasks: 2, kept: 2, notes: 2 })
})

test('sectionRows at 50 rows: lists grow to their caps and fill the rows', () => {
  const body = 50 - CHROME
  const got = sectionRows(body, long())
  expect(rowsUsed(got)).toBe(body)
  const r = rowsOf(got)
  expect(r.latest).toBeGreaterThan(5)
  expect(r.latest).toBeLessThanOrEqual(8)
  expect(r.agents).toBeLessThanOrEqual(6)
  expect(r.kept).toBeLessThanOrEqual(4)
  expect(r.notes).toBeLessThanOrEqual(4)
})

test('sectionRows: an empty section is left out, a short list takes only its count, no blank is doubled', () => {
  const got = sectionRows(40, [
    { key: 'latest', count: 1, ...NOW_SECTIONS.latest },
    { key: 'agents', count: 0, ...NOW_SECTIONS.agents },
    { key: 'notes', count: 2, ...NOW_SECTIONS.notes },
  ])
  expect(got).toEqual([
    { key: 'latest', rows: 1 },
    { key: 'notes', rows: 2 },
  ])
  expect(rowsUsed(got)).toBe(2 + 3 + 1)
})

test('sectionRows: with no cap a list takes every row there is', () => {
  const got = sectionRows(30, [{ key: 'steps', count: 100 }])
  expect(got).toEqual([{ key: 'steps', rows: 29 }])
  expect(sectionRows(0, [{ key: 'steps', count: 100 }])).toEqual([])
  expect(sectionRows(1, [{ key: 'steps', count: 100 }])).toEqual([])
})

const widths = (c: ReturnType<typeof compartments>) => c.comps.map(x => `${x.key} ${x.width}`)
const total = (c: ReturnType<typeof compartments>) => c.comps.reduce((n, x) => n + x.width, 0) + c.gap * Math.max(0, c.comps.length - 1)

test('compartments at 185: all five at the table widths, three columns between', () => {
  const c = compartments(185, false)
  expect(widths(c)).toEqual(['now 52', 'tasks 34', 'agents 36', 'latest 28', 'budget 23'])
  expect(c.gap).toBe(3)
  expect(total(c)).toBe(185)
})

test('compartments at 150: TASKS goes; the spare goes to the lists', () => {
  const c = compartments(150, false)
  expect(c.comps.map(x => x.key)).toEqual(['now', 'agents', 'latest', 'budget'])
  expect(c.comps[0]!.width).toBe(52)
  expect(c.comps[3]!.width).toBe(23)
  expect(c.gap).toBe(3)
  expect(total(c)).toBe(150)
})

test('compartments at 120: LATEST goes too', () => {
  const c = compartments(120, false)
  expect(c.comps.map(x => x.key)).toEqual(['now', 'agents', 'budget'])
  expect(c.comps[0]!.width).toBe(52)
  expect(c.comps[2]!.width).toBe(23)
  expect(total(c)).toBe(120)
})

test('compartments at 96: NOW 48 beside AGENTS over LATEST 46', () => {
  const c = compartments(96, false)
  expect(widths(c)).toEqual(['now 48', 'activity 46'])
  expect(total(c)).toBe(96)
  expect(compartments(95, false).comps).toEqual([])
})

test('compartments: NEEDS YOU takes the second place whenever something waits; others drop whole', () => {
  for (const cols of [96, 120, 150, 185, 220]) {
    const c = compartments(cols, true)
    expect(c.comps[0]!.key).toBe('now')
    expect(c.comps[1]!.key).toBe('needs')
    expect(total(c)).toBeLessThanOrEqual(cols)
  }
  expect(widths(compartments(185, true))).toEqual(['now 52', 'needs 34', 'agents 36', 'latest 28', 'budget 23'])
})

test('wrapFull wraps every word, breaks a word wider than the line, keeps paragraphs, never writes …', () => {
  const text = 'Write tests for the upload rate limiter: the 429 path, the reset header and the burst of eleven requests.'
  const lines = wrapFull(text, 20)
  for (const l of lines) {
    expect(l.length).toBeLessThanOrEqual(20)
    expect(l.endsWith('…')).toBe(false)
  }
  expect(lines.join(' ')).toBe(text)
  expect(wrapFull('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij'])
  expect(wrapFull('one\n\ntwo', 10)).toEqual(['one', '', 'two'])
  expect(wrapFull('', 10)).toEqual([])
})

test('sectionRows: an item of `per` rows costs that many, its header one more', () => {
  // 1 header + 2 a row: 7 rows hold 3 two-row items.
  expect(sectionRows(7, [{ key: 'agents', count: 10, per: 2 }])).toEqual([{ key: 'agents', rows: 3 }])
  // A second section pays its blank too: 1 + 2 = 3 for agents, 1 + 1 + 1 = 3 for runs, then one more agent.
  expect(sectionRows(8, [{ key: 'agents', count: 10, per: 2 }, { key: 'runs', count: 4 }])).toEqual([{ key: 'agents', rows: 2 }, { key: 'runs', rows: 1 }])
})

test('growLists: never fewer than the old cap, more as the pane grows, every item once they fit', () => {
  const lists = (q: number, d: number) => [{ key: 'queued', count: q, least: 5 }, { key: 'done', count: d, least: 3 }]
  // A short pane keeps the old caps: 5 queued and a more line, 3 done and a more line.
  expect([...growLists(4, lists(12, 9))]).toEqual([['queued', 6], ['done', 4]])
  // A tall pane grows both, dealt in turn.
  const tall = growLists(30, lists(12, 9))
  expect(tall.get('queued')! > 6 && tall.get('done')! > 4).toBe(true)
  // Room for everything: every item, so no more line.
  expect([...growLists(60, lists(12, 9))]).toEqual([['queued', 12], ['done', 9]])
  expect(listSplit(12, 12)).toEqual({ shown: 12, more: 0 })
  expect(listSplit(12, 6)).toEqual({ shown: 5, more: 7 })
  // An empty list takes nothing.
  expect([...growLists(30, lists(0, 2))]).toEqual([['done', 2]])
})
