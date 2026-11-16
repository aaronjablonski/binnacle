import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Timeline, UiState } from '../../types'
import { initialUi } from '../state'
import { BAND_MOCK } from './band.mock.testkit'
import { toolName } from './fit'
import { asked, busy, idle, NOW, stopped, watching } from './now.fixtures.testkit'
import { screen } from './screen.testkit'

// The fidelity test (plan "Fidelity bar") for the band: the real band, drawn
// with the mock's session data (now.fixtures.testkit.ts), against the boards
// of CockpitBand in gen-cockpit.js row by row (band.mock.testkit.ts). A ¤ cell
// (a Raster in the mock) matches anything: the text look draws the critter's
// same-size text form there, and the terminal's Raster is checked in its own
// test. The only differences allowed are the rulings' deviations and
// real-data differences, each a named patch on the mock rows below; a failure
// prints the patched mock and the drawing side by side, with the patches
// applied.

const SHAPES: Record<string, string> = { timeline: 'timeline-4', ui: 'ui-4' }

function world(on: On, t: Timeline, u: UiState = initialUi): void {
  mock.clock(on, { now: NOW })
  on('ui.log', () => ({ value: undefined }))
  on('state.get', (_, e) => {
    const key = (e as { key: string }).key
    const v = key === 'timeline' ? t : key === 'ui' ? u : undefined
    return { value: { value: v === undefined ? undefined : { shape: SHAPES[key], value: v }, version: 0 } }
  })
}

const BAND = (columns: number, extra: Record<string, unknown> = {}) =>
  ({
    plugin: 'mission-control',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: columns, scroll: { offset: 0, bodyRows: 10 }, view: {}, ...extra },
  }) as const

/** The band in the text look (mobile draws no Raster): its rows, the critter as its text form. */
async function drawn($: Engine, columns: number): Promise<string[]> {
  const ui = await $.ui.mount({ ...BAND(columns), surface: 'mobile' })
  const out = screen(await ui.drawn())
  await ui.unmount()
  return out
}

function rowMatches(want: string, got: string): boolean {
  const w = [...want]
  const g = [...got]
  for (let i = 0; i < Math.max(w.length, g.length); i++) {
    const a = w[i] ?? ' '
    if (a !== '¤' && a !== (g[i] ?? ' ')) return false
  }
  return true
}

function sideBySide(name: string, want: string[], got: string[], patches: string[], width: number): string {
  const lines = [`${name}: mock with ${patches.length} deviations (left) | drawn (right)`, ...patches.map(p => `  - ${p}`)]
  for (let i = 0; i < Math.max(want.length, got.length); i++) {
    const w = want[i] ?? ''
    const g = got[i] ?? ''
    lines.push(`${String(i).padStart(2)} ${rowMatches(w, g) ? ' ' : '!'} ${w.padEnd(width)} | ${g}`)
  }
  return lines.join('\n')
}

/** Replace text in one row, exactly once, so a patch that misses fails loudly; the next wide gap (4 spaces or more) gives or takes the columns the new text adds, so what follows keeps its column (the row stays flush right). */
const sub = (row: number, from: string, to: string) => (rows: string[]): void => {
  const at = rows[row]!.indexOf(from)
  if (at < 0) throw new Error(`patch: row ${row} has no "${from}": ${rows[row]}`)
  const grow = to.length - from.length
  const head = rows[row]!.slice(0, at) + to
  let tail = rows[row]!.slice(at + from.length)
  const gap = /\s{4,}/.exec(tail)
  if (gap !== null) tail = tail.slice(0, gap.index) + ' '.repeat(Math.max(1, gap[0].length - grow)) + tail.slice(gap.index + gap[0].length)
  rows[row] = head + tail
}

/** A board being patched: its rows and the names of the patches applied. */
class Board {
  rows: string[]
  names: string[] = []
  constructor(name: keyof typeof BAND_MOCK) {
    this.rows = [...BAND_MOCK[name]]
  }
  patch(name: string, fn: (rows: string[]) => void): this {
    fn(this.rows)
    this.names.push(name)
    return this
  }
  check(name: string, got: string[], width: number): void {
    const ok = this.rows.length === got.length && this.rows.every((r, i) => rowMatches(r, got[i] ?? ''))
    expect(ok ? 'matches' : sideBySide(name, this.rows, got, this.names, width)).toBe('matches')
  }
}

/** R25: the critter box holds its badge column (micro: 5 wide), the mock's is 4 wide. */
const R25 = 'R25: the critter box is 5 wide (the badge column is always reserved): a ¤ at column 4'
const badgeCol = (rows: string[]): void => {
  for (let r = 0; r < rows.length; r++) {
    rows[r] = [...rows[r]!.padEnd(5)].map((ch, i) => (i === 4 ? '¤' : ch)).join('').replace(/\s+$/, '')
  }
}

test('fidelity: CockpitBand working (104 columns) matches the mock but for the listed deviations', async ($, on) => {
  world(on, busy())
  const got = await drawn($, 104)
  new Board('work').patch(R25, badgeCol).check('CockpitBand work', got, 104)
})

test('fidelity: CockpitBand asked matches the mock but for the listed deviations', async ($, on) => {
  world(on, asked())
  const got = await drawn($, 104)
  new Board('ask')
    .patch(R25, badgeCol)
    .patch('R1: the sentence reads "asks to run a command", then the tool and the command', sub(0, 'Builder asks to run  Bash', 'Builder asks to run a command  Bash'))
    .patch('R23 and real data: the asker is general-purpose, so its name reads General', sub(0, 'Builder asks', 'General asks'))
    .check('CockpitBand ask', got, 104)
})

test('fidelity: CockpitBand with Watch matches the mock but for the listed deviations', async ($, on) => {
  // The mock's band keeps the work board's 62 % and 34 %; the Watch fixture of Now has 85 %, so its budget is the busy one.
  world(on, { ...watching(), budget: busy().budget })
  const got = await drawn($, 104)
  new Board('watch').patch(R25, badgeCol).check('CockpitBand watch', got, 104)
})

test('fidelity: CockpitBand idle matches the mock but for the listed deviations', async ($, on) => {
  world(on, idle())
  const got = await drawn($, 104)
  new Board('idle')
    .patch('R29 and whole minutes: "cache stays warm about 2 min" (the countdown is never m:ss)', sub(0, 'cache warm 2:51', 'cache stays warm about 2 min'))
    .check('CockpitBand idle', got, 104)
})

test('fidelity: CockpitBand at 64 columns matches the mock', async ($, on) => {
  world(on, busy())
  const got = await drawn($, 64)
  new Board('c64').check('CockpitBand 64', got, 64)
})

test('fidelity: CockpitBand asked at 40 columns matches the mock but for the listed deviations', async ($, on) => {
  world(on, asked())
  const got = await drawn($, 40)
  new Board('c40')
    .patch('brief: at 40 columns the ask still names its tool, so the row gains "Bash" after the count of asks, and the separators close to two spaces to make room', sub(0, '1 needs you   ·   9 of 14', `1 needs you  ·  ${toolName('Bash', 12)}  ·  9 of 14`))
    .check('CockpitBand 40', got, 40)
})

test('stopped (R8): the band reads Stopped and the reason in red, with no amber', async ($, on) => {
  world(on, stopped())
  const ui = await $.ui.mount({ ...BAND(104), surface: 'mobile' })
  const rows = screen(await ui.drawn())
  expect(rows[0]).toContain('Stopped   The API was overloaded (529)')
  expect(rows[1]).toContain('9 of 14 done')
  expect((await ui.find({ type: 'Text', text: /^The API was overloaded \(529\)$/ }))?.props).toMatchObject({ color: 'error' })
  expect((await ui.findAll({ type: 'Text' })).some(x => x.props.color === 'warning')).toBe(false)
  await ui.unmount()
})
