import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Timeline, UiState } from '../../types'
import { initialUi } from '../state'
import { asked, busy, endedOpen, idle, longList, noList, NOW, stopped, watching } from './now.fixtures.testkit'
import { MOCK } from './now.mock.testkit'
import { r49Tabs, R49_TABS, screen } from './screen.testkit'

// The fidelity test (plan "Fidelity bar"): the real Now and slim, drawn with
// the mock's session data (now.fixtures.testkit.ts), against the boards of
// gen-cockpit.js row by row (now.mock.testkit.ts). A mock Raster cell (¤)
// matches anything: the text look draws the instrument's same-size text form
// there, and the terminal's Raster boxes are checked in their own test. The
// only differences allowed are the rulings' mock deviations and real-data
// differences, each a named patch on the mock rows below; a failure prints
// the patched mock and the drawing side by side, with the patches applied.

const SHAPES: Record<string, string> = { timeline: 'timeline-4', ui: 'ui-4' }

/** The engine's state beneath the mod, holding what the returned holder holds at each read. */
function world(on: On, t: Timeline, u: UiState = initialUi): { t: Timeline; u: UiState } {
  const held = { t, u }
  mock.clock(on, { now: NOW })
  on('ui.log', () => ({ value: undefined }))
  on('state.get', (_, e) => {
    const key = (e as { key: string }).key
    const v = key === 'timeline' ? held.t : key === 'ui' ? held.u : undefined
    return { value: { value: v === undefined ? undefined : { shape: SHAPES[key], value: v }, version: 0 } }
  })
  return held
}

const PANE = (columns: number, rows: number, covered: boolean) =>
  ({
    plugin: 'binnacle',
    component: 'Pane',
    requestId: 'binnacle',
    props: {
      title: 'Binnacle', isFocused: true, bodyColumns: columns, placement: 'dock',
      scroll: { offset: 0, bodyRows: rows }, view: {}, ...(covered ? { isPromptCovered: true as const } : {}),
    },
  }) as const

type El = { type?: unknown; props?: Record<string, unknown>; children?: unknown }

async function mount($: Engine, columns: number, rows: number, covered: boolean, surface: 'vscode' | 'terminal') {
  return $.ui.mount({ ...PANE(columns, rows, covered), surface })
}

/** The pane in the text look (VS Code draws no Raster): the terminal's rows, the instruments as their text forms. */
async function drawn($: Engine, columns: number, rows: number, covered = false): Promise<string[]> {
  const ui = await mount($, columns, rows, covered, 'vscode')
  const out = screen(await ui.drawn())
  await ui.unmount()
  return out
}

/** A row matches when every cell does: a ¤ cell matches anything, any other cell itself. */
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

/** A board being patched: its rows and the names of the patches applied, in order. */
class Board {
  rows: string[]
  names: string[] = []
  constructor(name: string) {
    this.rows = [...MOCK[name]!.rows]
  }
  /** One deviation: `name` says which ruling or what real data, `fn` rewrites the rows. */
  patch(name: string, fn: (rows: string[]) => string[] | void): this {
    const got = fn(this.rows)
    if (got !== undefined) this.rows = got
    this.names.push(name)
    return this
  }
  /** Replace text in one row (exactly once, so a patch that misses fails loudly). */
  sub(row: number, from: string, to: string): (rows: string[]) => void {
    return rows => {
      if (!rows[row]!.includes(from)) throw new Error(`patch: row ${row} has no "${from}": ${rows[row]}`)
      rows[row] = rows[row]!.replace(from, to)
    }
  }
}

/** Overwrite `rows[r]` from `col` with `text`. */
const put = (row: string, col: number, text: string): string => {
  const cells = [...row.padEnd(col)]
  ;[...text].forEach((ch, i) => (cells[col + i] = ch))
  return cells.join('').replace(/\s+$/, '')
}

// Deviations every pane board shares.
/** R25: a critter box is 6 wide (the badge column at 7 is always reserved), so the mock's 5-wide box takes one more ¤ column. */
const R25 = 'R25: the critter box holds its badge column (col 7 small, col 5 micro slim)'
const badgeCol = (from: number, to: number, col: number) => (rows: string[]): void => {
  for (let r = from; r <= to; r++) rows[r] = put(rows[r]!, col, '¤')
}
/** Remove one row, shifting the ones under it up, and add a blank row above the footer to keep the height. */
const dropRow = (r: number) => (rows: string[]): string[] => {
  const out = [...rows.slice(0, r), ...rows.slice(r + 1)]
  out.splice(out.length - 1, 0, '')
  return out
}
/** Insert a row at `r`, taking a blank row from above the footer. */
const addRow = (r: number, text: string) => (rows: string[]): string[] => {
  const out = [...rows.slice(0, r), text, ...rows.slice(r)]
  const blank = out.lastIndexOf('', out.length - 2)
  out.splice(blank, 1)
  return out
}

/** The section heads (and the calm line) that start a block of Now's body. */
const HEADS: [string, RegExp][] = [
  ['calm', /^ {2}✓ Nothing needs you/], ['Needs you', /^ {2}Needs you ─/], ['Watch', /^ {2}Watch ─/], ['To do', /^ {2}To do ─/],
  ['Notes', /^ {2}Notes and decisions ─/], ['Artifacts', /^ {2}Artifacts ─/], ['This turn', /^ {2}This turn ─/], ['Agents', /^ {2}Agents ─/],
]
/**
 * R45, R47, R48, R50: Now's body under the full header (rows 0 to 11, the
 * sill) laid out again: the named blocks in `order`, `gap` blank rows before
 * each (R50: two once To do has every row it wants and rows are left), and
 * the Agents block pinned to the foot of the pane (its last row right above
 * the blank row over the footer), the rows left over going above it (R50).
 * A block is cut from the mock at its head and ends before the blank rows
 * that precede the next head; `add` gives blocks the mock does not draw.
 * There is no hint row: R45 takes Watch off Now entirely.
 */
const relay = (order: string[], o: { gap?: number; add?: Record<string, string[]> } = {}) => (rows: string[]): string[] => {
  const foot = rows[rows.length - 1]!
  const body = rows.slice(12, rows.length - 1)
  const starts = body.flatMap((r, at) => HEADS.filter(([, re]) => re.test(r)).map(([name]) => ({ name, at })))
  const blocks: Record<string, string[]> = { ...(o.add ?? {}) }
  starts.forEach((st, k) => {
    let end = k + 1 < starts.length ? starts[k + 1]!.at : body.length
    while (end > st.at && body[end - 1]!.trim() === '') end--
    blocks[st.name] = body.slice(st.at, end)
  })
  const gap = o.gap ?? 1
  const out = rows.slice(0, 12)
  for (const name of order) {
    const b = blocks[name]
    if (b === undefined) throw new Error(`patch: no ${name} block in the mock`)
    for (let k = 0; k < gap; k++) out.push('')
    if (name === 'Agents') {
      if (name !== order[order.length - 1]) throw new Error('patch: Agents is the last block (R47)')
      // R50: Agents at the foot: it ends on the row above the blank row over the footer.
      const start = rows.length - 2 - b.length
      if (start < out.length) throw new Error(`patch: Agents cannot start at ${start}, under row ${out.length}`)
      while (out.length < start) out.push('')
    }
    out.push(...b)
  }
  if (out.length > rows.length - 1) throw new Error(`patch: the re-laid body runs past the footer (${out.length} rows)`)
  while (out.length < rows.length - 1) out.push('')
  return [...out, foot]
}
/** A section head as the pane draws it at 62 columns: the title, a hairline, the sum flush right at 59. */
const head = (title: string, sum: string): string => `  ${title} ${'─'.repeat(60 - 2 - title.length - 2 - sum.length)} ${sum}`

test('fidelity: CockpitNow (busy) at 62 columns matches the mock but for the listed deviations', { options: { header: 'full' } }, async ($, on) => {
  world(on, busy())
  const got = await drawn($, 62, 46)
  const b = new Board('CockpitNow').patch(R49_TABS, r49Tabs)
    .patch('R29: no cache countdown while working', b0 => void (b0[10] = b0[10]!.replace(' · cache warm 4:48', '                  ')))
    .patch('R14: one done row above the current task', dropRow(18))
    .patch('R14 + height rule: the row the second done row gave back shows the last open task instead of "+ 1 more to do"', rows => void (rows[23] = '  ○ Open the pull request'))
    .patch(R25, badgeCol(6, 8, 7))
    .patch(R25, badgeCol(26, 31, 7))
  b.patch('R23 and real data: the second agent is general-purpose, so its name reads General', b.sub(29, 'Builder  write the rate limit tests        ', 'General  write the rate limit tests        '))
  b.patch('R27: card times are 2 min and 1 min (seconds only in the first minute)', rows => {
    rows[26] = rows[26]!.replace('     2m 14s', '      2 min')
    rows[29] = rows[29]!.replace('     1m 40s', '      1 min')
  })
  b.patch('footer: the options key is `0` (a Button hotkey takes a digit or a lowercase letter, so the comma of the mock cannot be armed)', b.sub(45, ', options', '0 options'))
  b.patch('R48: Now draws no calm line ("✓ Nothing needs you"); R47: Notes and decisions come before Agents; R50: To do has every row it wants, so the blocks stand two blank rows apart and Agents sits at the foot of the pane', relay(['To do', 'Notes', 'Agents'], { gap: 2 }))
  // On a mismatch the received value is both boards side by side.
  expect(b.rows.every((r, i) => rowMatches(r, got[i] ?? '')) ? 'matches' : sideBySide('CockpitNow', b.rows, got, b.names, 62)).toBe('matches')
  expect(got.length).toBe(46)
  b.rows.forEach((r, i) => expect([i, rowMatches(r, got[i] ?? '')]).toEqual([i, true]))
})

test('fidelity: CockpitNowNeedsYou at 62 columns matches the mock but for the listed deviations', { options: { header: 'full' } }, async ($, on) => {
  world(on, asked())
  const got = await drawn($, 62, 46, true)
  const b = new Board('CockpitNowNeedsYou').patch(R49_TABS, r49Tabs)
    .patch('R29: no cache countdown while working', rows => void (rows[10] = rows[10]!.replace(' · cache warm 4:48', '                  ')))
  b.patch('R3-B M8: the header critter text form reads "● lead" on one row, so its box reaches the badge column (col 7), which the mock leaves to the badge', badgeCol(6, 8, 7))
  b.patch('R5: the asker is a subagent and Explorer still runs, so the task is not paused: "Working on"', b.sub(6, 'Paused on', 'Working on'))
  b.patch('R23 and real data: the asker is general-purpose: General', b.sub(14, 'Builder asks to run a command', 'General asks to run a command'))
  b.patch('R3 and R39: no call hands the keys to the prompt, so the amber chip reads " esc  back to the prompt " (plain Text; Enter opens the step) where the mock draws the button " ↵ go to prompt "; its dim words are "then allow or deny"', rows => void (rows[16] = '▍ ¤¤¤¤¤   esc  back to the prompt   then allow or deny'))
  b.patch(R25, badgeCol(14, 16, 7))
  b.patch('R14: one done row above the current task', dropRow(21))
  b.patch('R5: the current task keeps now · 12 min', rows => void (rows[22] = '▍ ▸ Wire the limiter into the chain             now · 12 min'))
  b.patch('R14 + height rule: the freed row shows the last open task', rows => void (rows[26] = '  ○ Open the pull request'))
  b.patch(R25, badgeCol(29, 34, 7))
  b.patch('R23: General', b.sub(32, 'Builder  wire the limiter middleware      ', 'General  wire the limiter middleware      '))
  b.patch('R27: 2 min', b.sub(29, '     2m 14s', '      2 min'))
  b.patch("R30 (F M11): the wait shows in the pill and the block only; the asker's card keeps its own time, 1 min", b.sub(32, '            40s', '          1 min'))
  b.patch('R3: the footer offers no "go to prompt"; `n next ask` only with more than one ask', b.sub(45, '↵ go to prompt   n next ask   esc prompt', '↵ open   esc prompt'))
  b.patch('R47 and R50: spare rows go to the two-row spacing before agent cards, so Agents keeps one card, the asker\'s (F M10: the agents that need you are kept first), and "+ 1 more working" for Explorer', rows => {
    const out = [...rows]
    // After the R14 drop: the head on 28, Explorer's card 29 to 31, the asker's 32 to 34, "31 finished earlier" on 35.
    if (!out[29]!.includes('Explorer') || !out[32]!.includes('General')) throw new Error('patch: the cards are not where the mock has them')
    out.splice(29, 3)
    out.splice(32, 0, '         + 1 more working')
    out.splice(out.length - 1, 0, '', '')
    return out
  })
  b.patch('R47: Notes and decisions come before Agents; R50: the blocks stand two blank rows apart and Agents sits at the foot of the pane', relay(['Needs you', 'To do', 'Notes', 'Agents'], { gap: 2 }))
  // On a mismatch the received value is both boards side by side.
  expect(b.rows.every((r, i) => rowMatches(r, got[i] ?? '')) ? 'matches' : sideBySide('CockpitNowNeedsYou', b.rows, got, b.names, 62)).toBe('matches')
  expect(got.length).toBe(46)
  b.rows.forEach((r, i) => expect([i, rowMatches(r, got[i] ?? '')]).toEqual([i, true]))
})

test('fidelity: CockpitNowWatch at 62 columns matches the mock but for the listed deviations', { options: { header: 'full' } }, async ($, on) => {
  world(on, watching())
  const got = await drawn($, 62, 46)
  const b = new Board('CockpitNowWatch').patch(R49_TABS, r49Tabs)
    .patch('R29: no cache countdown while working', rows => void (rows[10] = rows[10]!.replace(' · cache warm 4:48', '                  ')))
  b.patch('R3-B M8: the header critter text form reads "● lead" on one row, so its box reaches the badge column (col 7), which the mock leaves to the badge', badgeCol(6, 8, 7))
  b.patch('R6 and F M2: the long run reads "Explorer has run 64 min (limit 60)" (no median for its type here); R3-B M5: the minutes read as the card reads them, 1 h 4 min (R27)', b.sub(16, 'Explorer has run 64 min, past the usual 60', 'Explorer has run 1 h 4 min (limit 60)'))
  b.patch('height rule: spare rows go to To do (up to 7), so the two open tasks show in place of "+ 2 more to do"', rows => {
    rows[27] = '  ○ Update the changelog'
    return addRow(28, '  ○ Open the pull request')(rows)
  })
  b.patch(R25, badgeCol(31, 36, 7))
  b.patch('R27: the long runner reads 1 h 4 min (bold); 1 min', rows => {
    rows[31] = rows[31]!.replace('    64 min', ' 1 h 4 min')
    rows[34] = rows[34]!.replace('     1m 40s', '      1 min')
  })
  b.patch('real data: doing() shows a folder by its name, "vendor"', b.sub(32, 'vendor/ for', 'vendor for'))
  b.patch('R23: General', b.sub(34, 'Builder  write the rate limit tests        ', 'General  write the rate limit tests        '))
  b.patch('R45 and R48: the Watch block and the calm line leave Now, with no hint row; R47: Notes and decisions come before Agents; R50: the blocks stand two blank rows apart and Agents sits at the foot of the pane',
    relay(['To do', 'Notes', 'Agents'], { gap: 2 }))
  b.patch('R45: with no Watch on Now its keys go (v transcript, x dismiss): the footer is the working one, and the options key is `0` (a Button hotkey takes a digit or a lowercase letter)', b.sub(45, 'v transcript   x dismiss', '0 options   esc prompt'))
  // On a mismatch the received value is both boards side by side.
  expect(b.rows.every((r, i) => rowMatches(r, got[i] ?? '')) ? 'matches' : sideBySide('CockpitNowWatch', b.rows, got, b.names, 62)).toBe('matches')
  expect(got.length).toBe(46)
  b.rows.forEach((r, i) => expect([i, rowMatches(r, got[i] ?? '')]).toEqual([i, true]))
})

test('fidelity: CockpitNowIdle at 62 columns matches the mock but for the listed deviations', { options: { header: 'full' } }, async ($, on) => {
  world(on, idle())
  const got = await drawn($, 62, 46)
  const b = new Board('CockpitNowIdle').patch(R49_TABS, r49Tabs)
    .patch(R25, badgeCol(6, 8, 7))
  b.patch('R40: the countdown is in whole minutes (the mock ticks m:ss), so "cache warm 2 min"', b.sub(10, 'cache warm 2:51  ', 'cache warm 2 min '))
  b.patch('real data: no retry is recorded, so the agents fact has no detail', b.sub(23, '     1 was retried after a failure', ''))
  b.patch('M5 and R39: one action, one name: the rest footer says "e export digest", as the Artifacts button "e: Export digest" (the mock says "export handoff")', b.sub(45, 'e export handoff   esc', 'e export digest   esc'))
  b.patch('R48: no calm line; R47: To do, Notes and decisions, then the new Artifacts block (the newest 3, here the 2 of the fixture), This turn, Agents; R50: the blocks stand two blank rows apart and Agents sits at the foot of the pane',
    relay(['To do', 'Notes', 'Artifacts', 'This turn', 'Agents'], { gap: 2, add: { Artifacts: [head('Artifacts', '2'), '  ↗ the plan · 45 min', '  ↗ Rate limit design · 50 min'] } }))
  // On a mismatch the received value is both boards side by side.
  expect(b.rows.every((r, i) => rowMatches(r, got[i] ?? '')) ? 'matches' : sideBySide('CockpitNowIdle', b.rows, got, b.names, 62)).toBe('matches')
  expect(got.length).toBe(46)
  b.rows.forEach((r, i) => expect([i, rowMatches(r, got[i] ?? '')]).toEqual([i, true]))
})

test('fidelity: CockpitSlim busy at 26 columns matches the mock but for the listed deviations', async ($, on) => {
  world(on, busy())
  const got = await drawn($, 26, 46)
  const b = new Board('SlimBusy').patch(R25, badgeCol(20, 24, 5))
  b.patch('real data: the step edits test/rateLimit.test.ts, which does not fit the 19 columns left, so doing() keeps the verb alone (F I7); the mock says "Editing tests", wording the data does not hold', b.sub(24, 'Editing tests', 'Editing'))
  b.patch('R23: General', b.sub(23, 'Builder', 'General'))
  b.patch('real data: the kept decision\'s own words, wrapped', rows => {
    rows[31] = ' ★ Decided: the limiter'
    rows[32] = '   runs after bodyLimit'
  })
  // On a mismatch the received value is both boards side by side.
  expect(b.rows.every((r, i) => rowMatches(r, got[i] ?? '')) ? 'matches' : sideBySide('CockpitSlim (busy)', b.rows, got, b.names, 26)).toBe('matches')
  expect(got.length).toBe(46)
  b.rows.forEach((r, i) => expect([i, rowMatches(r, got[i] ?? '')]).toEqual([i, true]))
})

test('fidelity: CockpitSlim asked at 26 columns matches the mock but for the listed deviations', async ($, on) => {
  world(on, asked())
  const got = await drawn($, 26, 46, true)
  const b = new Board('SlimAsk')
  b.patch('R5: not paused (Explorer still runs): "Working on"', b.sub(3, 'Paused on', 'Working on'))
  b.patch('R23: General', b.sub(9, 'Builder', 'General'))
  b.patch('real data: the command wraps where its words fall', rows => {
    rows[10] = '▍ npm run deploy -- --env'
    rows[11] = '▍ staging'
  })
  b.patch('R3 and R39: the amber chip is plain Text, " esc  to the prompt " (the short form for the 22 columns), where the mock draws the button " ↵ go to prompt "', b.sub(12, ' ↵ go to prompt', ' esc  to the prompt'))
  b.patch('R30: "1 working · 1 waiting" does not fit beside the title at 26, so it takes its own row', rows => {
    rows[23] = ' Agents                 ›'
    return addRow(24, ' 1 working · 1 waiting')(rows)
  })
  b.patch(R25, badgeCol(25, 29, 5))
  b.patch('R23 and real data: the type of the waiting agent is General (general-purpose), not Builder', b.sub(28, 'Builder', 'General'))
  // On a mismatch the received value is both boards side by side.
  expect(b.rows.every((r, i) => rowMatches(r, got[i] ?? '')) ? 'matches' : sideBySide('CockpitSlim (asked)', b.rows, got, b.names, 26)).toBe('matches')
  expect(got.length).toBe(46)
  b.rows.forEach((r, i) => expect([i, rowMatches(r, got[i] ?? '')]).toEqual([i, true]))
})

// ---------- Raster boxes on the terminal ----------

type Box = { key: string; row: number; col: number; w: number; h: number }

const kidsOf = (el: El): unknown[] => {
  const c = el.children ?? el.props?.children
  return c === undefined ? [] : Array.isArray(c) ? c.flat(Infinity) : [c]
}
const textOf = (n: unknown): string => {
  if (n === null || n === undefined || typeof n === 'boolean') return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join('')
  const el = n as El
  if (el.type === 'Button' && el.props?.plain !== true) return `[ ${kidsOf(el).map(textOf).join('')} ]`
  if (el.type === 'Button' && typeof el.props?.hotkey === 'string') return `${el.props.hotkey}: ${kidsOf(el).map(textOf).join('')}`
  return kidsOf(el).map(textOf).join('')
}

/** Lays the tree out as the terminal does (Box height and width kept, a Raster its own size) and lists the Rasters where they land. */
function rasters(node: unknown, col = 0, row = 0, out: Box[] = []): { w: number; h: number; out: Box[] } {
  if (node === null || node === undefined || typeof node === 'boolean') return { w: 0, h: 0, out }
  if (typeof node === 'string' || typeof node === 'number') return { w: String(node).length, h: 1, out }
  if (Array.isArray(node)) {
    let h = 0
    let w = 0
    for (const k of node) {
      const r = rasters(k, col, row + h, out)
      h += r.h
      w = Math.max(w, r.w)
    }
    return { w, h, out }
  }
  const el = node as El
  const p = el.props ?? {}
  if (el.type === 'Raster') {
    out.push({ key: String(p.key ?? '?'), row, col, w: Number(p.columns), h: Number(p.rows) })
    return { w: Number(p.columns), h: Number(p.rows), out }
  }
  if (el.type !== 'Box') return { w: textOf(el).length, h: 1, out }
  if (p.display === 'none') return { w: 0, h: 0, out }
  const pad = typeof p.paddingLeft === 'number' ? p.paddingLeft : 0
  const gap = typeof p.columnGap === 'number' ? p.columnGap : 0
  let w = 0
  let h = 0
  if (p.flexDirection === 'column') {
    for (const k of kidsOf(el)) {
      const r = rasters(k, col + pad, row + h, out)
      h += r.h
      w = Math.max(w, r.w + pad)
    }
  } else {
    let x = col + pad
    kidsOf(el).forEach((k, i) => {
      if (i > 0) x += gap
      const r = rasters(k, x, row, out)
      const kw = typeof (k as El)?.props?.width === 'number' ? ((k as El).props!.width as number) : r.w
      x += kw
      h = Math.max(h, r.h)
    })
    w = x - col
  }
  return { w: typeof p.width === 'number' ? p.width : w, h: typeof p.height === 'number' ? p.height : h, out }
}

// MEANING CHANGED (motion sketch 1, task motion): the to-do bar is now a 1-row Raster in the rich look, where the mock put it
// (16,2 58x1), so a landed task flashes by blits; its text form is still the `━` runs of R22. The test was "the to-do bar is Text, R22".
test('fidelity: on the terminal the Rasters sit where the mock puts them: lintel, lead, gauges, sill, to-do bar, cards', { options: { header: 'full' } }, async ($, on) => {
  world(on, busy())
  const ui = await mount($, 62, 46, false, 'terminal')
  const boxes = rasters(await ui.drawn()).out.map(({ row, col, w, h }) => ({ row, col, w, h }))
  await ui.unmount()
  // The mock: lintel 3,0 62x1; main 6,2 5x3; gauges 5,40 20x5; sill 11,0 62x1; todo 16,2 58x1; ag 27,2 and 30,2 5x3.
  // Drawn: the critters are 6 wide (R25); with no calm line (R48) and two blank rows between blocks (R50) the bar is one row
  // higher than the mock's: To do 14 to 22, Notes 25 to 28; the cards come after Notes and decisions (R47) and Agents sits at
  // the foot of the pane (R50): its head on 36, the cards from 37.
  expect(boxes).toEqual([
    { row: 3, col: 0, w: 62, h: 1 },
    { row: 6, col: 2, w: 6, h: 3 },
    { row: 5, col: 40, w: 20, h: 5 },
    { row: 11, col: 0, w: 62, h: 1 },
    { row: 15, col: 2, w: 58, h: 1 },
    { row: 37, col: 2, w: 6, h: 3 },
    { row: 40, col: 2, w: 6, h: 3 },
  ])
})

test('fidelity: the Needs you asker, the idle crew and slim\'s micro critters sit where the mock puts them', { options: { header: 'full' } }, async ($, on) => {
  const held = world(on, asked())
  let ui = await mount($, 62, 46, true, 'terminal')
  let boxes = rasters(await ui.drawn()).out
  await ui.unmount()
  // The mock's asker: 14,2 5x3. Here 15: two blank rows under the sill (R50).
  expect(boxes.find(x => x.row === 15 && x.col === 2)).toEqual(expect.objectContaining({ w: 6, h: 3 }))
  held.t = idle()
  ui = await mount($, 62, 46, false, 'terminal')
  boxes = rasters(await ui.drawn()).out
  await ui.unmount()
  // The mock's resting crew: 26,2 19x2 (four roles); here three roles: 14x2. R47 and R48: Agents is last, after Notes,
  // Artifacts and This turn, with no calm line; R50: Agents sits at the foot of the pane, so the crew is on 42.
  expect(boxes.find(x => x.row === 42 && x.col === 2)).toEqual(expect.objectContaining({ h: 2 }))
  held.t = busy()
  ui = await mount($, 26, 46, false, 'terminal')
  boxes = rasters(await ui.drawn()).out
  await ui.unmount()
  // The mock: lintel 0,0 26x1; sill 6,0; crew 20,1 4x5 (one Raster for both); here one 5x2 box each at 20,1 and 23,1.
  expect(boxes.map(({ row, col, w, h }) => ({ row, col, w, h }))).toEqual([
    { row: 0, col: 0, w: 26, h: 1 },
    { row: 6, col: 0, w: 26, h: 1 },
    { row: 20, col: 1, w: 5, h: 2 },
    { row: 23, col: 1, w: 5, h: 2 },
  ])
})

// ---------- the states the rulings add, and the strip (for the report) ----------

// R44: the rows asserted below are the full header's (the kicker on row 6), so this runs with `header: 'full'`.
test('renders: R8 stopped, R12 no list and ended with tasks open, R13 a long list, the inline strip (R34)', { options: { header: 'full' } }, async ($, on) => {
  const held = world(on, stopped())
  const show = (name: string, rows: string[]): string => `${name}\n${rows.map((r, i) => `${String(i).padStart(2)} | ${r}`).join('\n')}`
  const out: string[] = []
  const cases: [string, Timeline, number, number, boolean][] = [
    ['R8 stopped (62)', stopped(), 62, 46, false],
    ['R12 no list (62)', noList(), 62, 46, false],
    ['R12 ended with tasks open (62)', endedOpen(), 62, 46, false],
    ['R13 forty tasks (62)', longList(), 62, 46, false],
    ['R34 strip, busy (96 x 17)', busy(), 96, 17, false],
    ['R34 strip, busy (120 x 17)', busy(), 120, 17, false],
    ['R34 strip, asked (130 x 17)', asked(), 130, 17, true],
  ]
  for (const [name, t, cols, rows, covered] of cases) {
    held.t = t
    const got = await drawn($, cols, rows, covered)
    got.forEach(r => expect(r.length).toBeLessThanOrEqual(cols))
    out.push(show(name, got))
  }
  // Printed for the task report: these states have no mock.
  ;(globalThis as unknown as { console: { log: (s: string) => void } }).console.log(out.join('\n\n'))
  held.t = stopped()
  const s = await drawn($, 62, 46)
  expect(s[4]).toContain('STOPPED')
  expect(s[4]).toContain('The API was overloaded (529)')
  expect(s[6]).toContain('Stopped by an error')
  held.t = noList()
  expect((await drawn($, 62, 46)).some(r => r.includes('No to-do list for this request'))).toBe(true)
  held.t = endedOpen()
  const e = await drawn($, 62, 46)
  expect(e[4]).toContain('IDLE')
  expect(e[4]).not.toContain('ALL DONE')
  expect(e[6]).toContain('Stopped with 5 to do open')
})
