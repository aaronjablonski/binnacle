import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Timeline, UiState } from '../../types'
import { initialUi } from '../state'
import { NOW, listSession, mapSession } from './agents.fixtures.testkit'
import { MOCK } from './agents.mock.testkit'
import { screen } from './screen.testkit'

// The fidelity test (plan "Fidelity bar"): the real Agents list and crew map,
// drawn with the mocks' session data (agents.fixtures.testkit.ts), against the
// boards of gen-cockpit.js (CockpitAgents) and gen-crew.js (CrewMapClear), row
// by row (agents.mock.testkit.ts). A mock Raster cell (¤) matches anything:
// the text look draws the instrument's same-size text form there. The only
// differences allowed are the rulings' deviations and real-data differences,
// each a named patch on the mock rows below; a failure prints the patched mock
// and the drawing side by side, with the patches applied. The tab bar's rows 1
// and 2 are the shell's (not this task's) and are left out; row 0 is checked.
//
// CrewMapClear is the older look (a lintel with a pill, caps labels, `live`,
// state at 41, tokens ending at 54, time at 61). R26 re-lays it in the
// cockpit's words, with the columns ending at 59 (time) and 49 (tokens) and the
// state before them, bands in the order Doing now, Up next, Done; `relay`
// below is that re-laying done mechanically on each table row of the mock.

const SHAPES: Record<string, string> = { timeline: 'timeline-4', ui: 'ui-4' }

function world(on: On, t: Timeline, u: UiState): void {
  mock.clock(on, { now: NOW })
  on('ui.log', () => ({ value: undefined }))
  on('state.get', (_, e) => {
    const key = (e as { key: string }).key
    const v = key === 'timeline' ? t : key === 'ui' ? u : undefined
    return { value: { value: v === undefined ? undefined : { shape: SHAPES[key], value: v }, version: 0 } }
  })
}

const PANE = (columns: number, rows: number) =>
  ({
    plugin: 'mission-control',
    component: 'Pane',
    requestId: 'mission-control',
    props: { title: 'Mission Control', isFocused: true, bodyColumns: columns, placement: 'dock', scroll: { offset: 0, bodyRows: rows }, view: {} },
  }) as const

/** The pane in the text look (VS Code draws no Raster): the terminal's rows, the instruments as their text forms. */
async function drawn($: Engine, columns: number, rows: number): Promise<string[]> {
  const ui = await $.ui.mount({ ...PANE(columns, rows), surface: 'vscode' })
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
  constructor(rows: string[]) {
    this.rows = [...rows]
  }
  /** One deviation: `name` says which ruling or what real data, `fn` rewrites the rows. */
  patch(name: string, fn: (rows: string[]) => string[] | void): this {
    const got = fn(this.rows)
    if (got !== undefined) this.rows = got
    this.names.push(name)
    return this
  }
}

/** Overwrite `row` from `col` with `text`. */
const put = (row: string, col: number, text: string): string => {
  const cells = [...row.padEnd(col)]
  ;[...text].forEach((ch, i) => (cells[col + i] = ch))
  return cells.join('').replace(/\s+$/, '')
}

/** Replace the right-aligned text `from` at the end of a row with `to`, still ending in the same column. */
function retime(row: string, from: string, to: string): string {
  const at = row.lastIndexOf(from)
  if (at < 0) throw new Error(`patch: "${from}" is not in ${row}`)
  const end = at + from.length
  const head = row.slice(0, at).replace(/\s+$/, '')
  if (head.length >= end - to.length) throw new Error(`patch: "${to}" collides in ${row}`)
  return head.padEnd(end - to.length) + to
}

const compare = (name: string, b: Board, got: string[], width: number, from = 3): void => {
  const same = b.rows.every((r, i) => i < from || rowMatches(r, got[i] ?? ''))
  expect(same ? 'matches' : sideBySide(name, b.rows, got, b.names, width)).toBe('matches')
  expect(got.length).toBe(b.rows.length)
  expect(got[0]).toBe(b.rows[0])
}

// ---------- the list ----------

/** R25: a critter box holds its badge column (col 7 small), so the mock's 5-wide ¤ run takes one more. */
const R25 = 'R25: the critter box holds its badge column (col 7)'

test('fidelity: CockpitAgents (list) at 62 columns matches the mock but for the listed deviations', async ($, on) => {
  world(on, listSession(), { ...initialUi, tab: 'agents' })
  const got = await drawn($, 62, 46)
  const b = new Board(MOCK.CockpitAgents!.rows)
  b.patch(R25, rows => {
    for (const r of [13, 14, 15, 16, 17, 18]) rows[r] = put(rows[r]!, 7, '¤')
  })
  b.patch('R27: card times read 2 min and 1 min (seconds only in the first minute)', rows => {
    rows[13] = retime(rows[13]!, '2m 14s', '2 min')
    rows[16] = retime(rows[16]!, '1m 40s', '1 min')
  })
  b.patch('R26: a failed agent is a micro critter with a red ! (a ¤ box, badge column included) in place of ×; its reason and keys sit at 9, under the name', rows => {
    rows[20] = put(put(`  ¤¤¤¤¤  ${rows[20]!.slice(4, 36).trimEnd()}`, 47, '12k'), 55, '3 min')
    rows[21] = `  ¤¤¤¤¤  ${rows[21]!.trim()}`
    rows[22] = `         ${rows[22]!.trim()}`
  })
  b.patch('R27: finished times read 5 min, 7 min, 1 min', rows => {
    rows[25] = retime(rows[25]!, '5m 10s', '5 min')
    rows[26] = retime(rows[26]!, '7m 44s', '7 min')
    rows[27] = retime(rows[27]!, '1m 52s', '1 min')
  })
  b.patch('C6 (brief): the footer carries the Options key', rows => void (rows[45] = put(rows[45]!, 51, '0 options')))
  compare('CockpitAgents', b, got, 62)
})

// ---------- the crew map ----------

const STATE_AT = 36
const TOKENS_END = 49
const TIME_END = 59

/** The longest head of `text` that ends at a word and leaves a `…`, at most `room` wide (the cut `wordFit` makes). */
function cut(text: string, room: number): string {
  if (text.length <= room) return text
  let out = ''
  for (const w of text.split(' ')) {
    const next = out === '' ? w : `${out} ${w}`
    if (next.length + 1 > room) break
    out = next
  }
  return `${out}…`
}

type Kind = 'task' | 'agent' | 'plain' | 'main' | 'child'

const TYPE_WORD: Record<string, string> = { scout: 'Explorer', build: 'Builder', check: 'Code reviewer' }

/**
 * R26 on one table row of the mock: the state moves from 41 to 36, the tokens
 * from ending at 54 to ending at 49, the time from ending at 61 to ending at
 * 59, the pips to end at 34 (two before the state); a name is cut at a word to
 * the room before the pips (or the state); `1 live` is `1 working` (never
 * "live"), `12m` and `3m 10s` read `12 min` and `3 min` (R27); on an unfolded
 * agent row the role word is the real type in friendly case (R23).
 */
function relay(row: string, kind: Kind): string {
  const left = row.slice(0, 41)
  const state = row.slice(41, 49).trim().replace(/^(\d+) live$/, '$1 working')
  const tokens = row.slice(49, 55).trim()
  const time = row.slice(55).trim().replace(/^(\d+)m( \d+s)?$/, '$1 min')
  const pips = /(▪+)\s*$/.exec(kind === 'plain' || kind === 'task' ? left : '')?.[1] ?? ''
  const nameAt = kind === 'task' || kind === 'main' ? 9 : kind === 'agent' ? 17 : kind === 'child' ? 12 : left.trimEnd().length
  const prefix = left.slice(0, nameAt)
  const raw = left.slice(nameAt).replace(/▪+\s*$/, '').trim()
  const first = pips !== '' ? STATE_AT - 1 - pips.length : STATE_AT
  let out: string
  if (kind === 'child') {
    const [role, ...rest] = raw.split(/\s+/)
    const type = TYPE_WORD[role!]!
    const descAt = nameAt + type.length + 2
    const room = STATE_AT - 2 - descAt + 1
    out = prefix + type + (room >= 4 ? `  ${cut(rest.join(' '), room)}` : '')
  } else {
    const name = kind === 'plain' ? raw : cut(raw, Math.max(1, first - 1 - nameAt))
    out = prefix.trimEnd().padEnd(nameAt) + name
  }
  if (pips !== '') out = put(out, first, pips)
  if (state !== '') out = put(out, STATE_AT, state)
  if (tokens !== '') out = put(out, TOKENS_END - tokens.length + 1, tokens)
  if (time !== '') out = put(out, TIME_END - time.length + 1, time)
  return out
}

const TOGGLES = '  l: List    t: Map    r: Working only'

/** Where the rows that differ between the folded and the unfolded mock sit. */
type Layout = { doneFirst: number; doneLast: number; children: number[]; next: number }

/** The mock's rows (folded or unfolded) re-laid per R26, as the named patches the drawing is held to. */
function relaid(rows: string[], L: Layout): Board {
  const b = new Board(rows)
  const n = rows.length
  b.patch('R26: the tab bar is the shell\'s; the toggle row is the cockpit\'s (the open one bold between spaces, "Working only")', r => void (r[3] = TOGGLES))
  b.patch('R26: the lintel is the cockpit\'s (a ¤ row without a pill or a readout)', r => void (r[5] = '¤'.repeat(62)))
  b.patch('R26: "Crew map" and the column heads are dim sentence case, State at 36, Tokens ending at 49, Time ending at 59', r => {
    r[6] = put(put(put('  Crew map', STATE_AT, 'State'), TOKENS_END - 5, 'Tokens'), TIME_END - 3, 'Time')
  })
  b.patch('R25: a critter box holds its badge column (col 7 for main, col 15 for an agent)', r => {
    for (const i of [7, 8, 9]) r[i] = put(r[i]!, 7, '¤')
    for (const i of [12, 13, 14]) r[i] = put(r[i]!, 15, '¤')
  })
  b.patch('R26 and R27: the table rows re-laid (state 36, tokens end 49, time end 59, pips end 34), names cut at a word, 1 live is 1 working, 12m is 12 min', r => {
    r[7] = relay(r[7]!, 'main')
    r[11] = relay(r[11]!, 'task')
    r[12] = relay(r[12]!, 'agent')
    r[15] = relay(r[15]!, 'plain')
    for (let i = L.doneFirst; i <= L.doneLast; i++) r[i] = relay(r[i]!, L.children.includes(i) ? 'child' : 'task')
    r[L.next + 1] = relay(r[L.next + 1]!, 'task')
    r[L.next + 2] = relay(r[L.next + 2]!, 'task')
    r[n - 3] = relay(r[n - 3]!, 'plain')
  })
  b.patch('R23: main reads Claude and its model has no version; the second agent line is its real type (Builder, from `builder`) and its model', r => {
    r[7] = r[7]!.replace(/main {2}/, 'Claude')
    r[8] = r[8]!.replace('opus 5.5', 'opus')
    r[13] = r[13]!.replace('build · sonnet 5', 'Builder · sonnet')
  })
  b.patch('R26: cockpit words: the step reads Editing (doing), not the tool name', r => void (r[14] = r[14]!.replace('Edit middleware', 'Editing middleware')))
  b.patch('R26: bands read Doing now, Up next, Done, in that order (the mock has NOW, DONE, NEXT); the trunk ends on the last row', r => {
    const out = [...r.slice(0, 10), '    │  Doing now', ...r.slice(11, 17)]
    out.push('    │  Up next', r[L.next + 1]!, r[L.next + 2]!.replace('╰─', '├─'), r[L.next - 1]!, '    │  Done')
    out.push(...r.slice(L.doneFirst, L.doneLast + 1).map((x, i, all) => (i === all.length - 1 ? x.replace('├─', '╰─') : x)))
    out.push(...r.slice(L.next + 3))
    return out
  })
  b.patch('R26: "Total" is sentence case; the total is the sum of the rows (832k; the mock\'s 812k is not)', r => {
    const at = r.findIndex(x => x.includes('TOTAL'))
    r[at] = r[at]!.replace('TOTAL', 'Total').replace('812k', '832k')
  })
  b.patch('R26/R28: the footer keys; r reads "working only", not "running only"; the engine draws the colon of d', r => {
    r[r.length - 1] = '  ↵ open   d: unfold done   r working only   esc prompt'
  })
  return b
}

test('fidelity: CrewMapClear (folded) at 62 columns, re-laid per R26, matches but for the listed deviations', async ($, on) => {
  world(on, mapSession(), { ...initialUi, tab: 'agents', agentsMode: 'tree' })
  const got = await drawn($, 62, 33)
  const b = relaid(MOCK.CrewMapClear!.rows, { doneFirst: 18, doneLast: 24, children: [], next: 26 })
  compare('CrewMapClear', b, got, 62)
  expect(got.length).toBeLessThanOrEqual(33)
})

test('fidelity: CrewMapClear (one done task unfolded) at 62 columns matches but for the listed deviations', async ($, on) => {
  world(on, mapSession(), { ...initialUi, tab: 'agents', agentsMode: 'tree', folded: ['open:task:11'] })
  const got = await drawn($, 62, 39)
  const b = relaid(MOCK.CrewMapClearOpen!.rows, { doneFirst: 18, doneLast: 30, children: [19, 20, 21, 22, 23, 24], next: 32 })
  b.patch('R26: the footer hint of d reads "fold done" while any group is unfolded', r => void (r[r.length - 1] = '  ↵ open   d: fold done   r working only   esc prompt'))
  compare('CrewMapClear (open)', b, got, 62)
})
