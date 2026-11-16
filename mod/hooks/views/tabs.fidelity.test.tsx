import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Timeline, UiState } from '../../types'
import { initialUi } from '../state'
import { artifactsTimeline, NOW, stepsTimeline, stepsUi, tasksTimeline } from './tabs.fixtures.testkit'
import { MOCK } from './tabs.mock.testkit'
import { screen } from './screen.testkit'

// The fidelity test (plan "Fidelity bar"): the real Tasks, Steps and Artifacts tabs, drawn with the mock's
// session data (tabs.fixtures.testkit.ts), against the boards of gen-cockpit.js row by row
// (tabs.mock.testkit.ts). A mock Raster cell (¤) matches anything: the text look draws the instrument's
// same-size text form there, and the terminal's Raster boxes are checked in their own tests. The only
// differences allowed are the rulings' mock deviations and real-data differences, each a named patch on the
// mock rows below; a failure prints the patched mock and the drawing side by side, with the patches applied.

const SHAPES: Record<string, string> = { timeline: 'timeline-4', ui: 'ui-4' }

/** The engine's state beneath the mod: the timeline and the pane's state. */
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

/** `left` with `right` ending at column 59 (the content's last column at 62). */
const flush = (left: string, right: string): string => left.padEnd(60 - right.length) + right

/** Insert a row at `r`, taking a blank row from above the footer. */
const addRow = (r: number, text: string) => (rows: string[]): string[] => {
  const out = [...rows.slice(0, r), text, ...rows.slice(r)]
  const blank = out.lastIndexOf('', out.length - 2)
  out.splice(blank, 1)
  return out
}

/** A row of figures: `left`, a middle figure ending at column 49 and a last one ending at 59. */
const fig = (left: string, mid: string, last: string): string => flush(left.padEnd(50 - mid.length) + mid, last)

/** The row with its last figure replaced by `time` (flush right at 59). */
const retime = (row: string, time: string): string => flush(row.replace(/ +[0-9]+m$/, '').trimEnd(), time)

/** A section head as the engine draws it: the title, a hairline, the sum flush right, one space either side of the hairline. */
const head = (title: string, sum: string): string => `  ${title} ${'─'.repeat(60 - 2 - title.length - 2 - sum.length)} ${sum}`

/** The shell's footer carries the Options key flush right (task C6): `0 options` ends at column 59. */
const FOOTER_OPTIONS = 'shell footer: `0 options` flush right at 51 to 59 (the Options key, drawn by the shell in every footer)'
const withOptions = (row: number) => (rows: string[]): void => void (rows[row] = flush(rows[row]!.trimEnd(), '0 options'))

function check(name: string, b: Board, got: string[], width = 62): void {
  // On a mismatch the received value is both boards side by side.
  expect(b.rows.every((r, i) => rowMatches(r, got[i] ?? '')) ? 'matches' : sideBySide(name, b.rows, got, b.names, width)).toBe('matches')
  expect(got.length).toBe(46)
  b.rows.forEach((r, i) => expect([i, rowMatches(r, got[i] ?? '')]).toEqual([i, true]))
}

test('fidelity: CockpitTasks at 62 columns matches the mock but for the listed deviations', async ($, on) => {
  world(on, tasksTimeline(), { ...initialUi, tab: 'tasks' })
  const got = await drawn($, 62, 46)
  const b = new Board('CockpitTasks')
  b.patch('real data: 41 min over 9 done is 4.6 min a task, times 5 left is 23 min, which rounds to 25 (the mock says 20)', b.sub(4, 'about 20 min', 'about 25 min'))
  b.patch('order and R23 and real data: the agents are in the order they started (Explorer first), R25: the micro critter box is 5 wide, its badge column at 8 (the mock has 4); the type is General (general-purpose), doing() reads Searching src/server for “upload(” and is cut at a word for the room; R27: 2 min and 1 min', rows => {
    rows[15] = flush('    ¤¤¤¤¤ Explorer  Searching src/server for…', '2 min')
    rows[16] = '    ¤¤¤¤¤'
    rows[17] = ''
    rows[18] = flush('    ¤¤¤¤¤ General  Editing middleware/index.ts', '1 min')
    rows[19] = '    ¤¤¤¤¤'
  })
  b.patch('column heads: tokens ends at 49 like its figures (the mock ends it at 50)', rows => void (rows[27] = head('Done', '9  ·  tokens      time')))
  b.patch(FOOTER_OPTIONS, withOptions(45))
  check('CockpitTasks', b, got)
})

/** Marks a step's row as in view in the transcript, as its `ToolUse` render reports it (the mod's own observer keeps the set). */
async function inView($: Engine, id: string): Promise<{ unmount: () => Promise<void> }> {
  return $.ui.mount({
    plugin: 'mission-control', surface: 'vscode', component: 'ToolUse', requestId: id,
    props: { tool_use_id: id, tool: 'Edit', input: {}, isRunning: false, isErrored: false, isInterrupted: false, onScreen: { first: 0, last: 2, of: 3 } },
  } as never)
}

test('fidelity: CockpitSteps at 62 columns matches the mock but for the listed deviations', async ($, on) => {
  const { t, ids } = stepsTimeline()
  const open: UiState = {
    ...stepsUi({ stepOpen: ids.failed }),
    tab: 'timeline',
    stepBody: { stepId: ids.failed, body: { input: {}, text: 'exit 1 · 2 of 14 tests failed\nexpected 429, received 200', cut: 0, isError: true } },
  } as UiState
  world(on, t, open)
  const marks = []
  for (const id of ids.view) marks.push(await inView($, id))
  const got = await drawn($, 62, 46)
  for (const m of marks) await m.unmount()
  const b = new Board('CockpitSteps')
  b.patch('R23: the agent is general-purpose, so it reads General (the mock says Builder)', rows => {
    rows[13] = rows[13]!.replace('Builder', 'General')
    rows[14] = rows[14]!.replace('Builder', 'General')
  })
  b.patch('R27: a step takes 2m 14s only under 10 min on Steps, so 3m is 3m 00s, 4m is 4m 00s, 9m is 9m 00s', rows => {
    rows[14] = retime(rows[14]!, '3m 00s')
    rows[19] = retime(rows[19]!, '4m 00s')
    rows[20] = retime(rows[20]!, '4m 00s')
    rows[21] = retime(rows[21]!, '9m 00s')
  })
  b.patch('footer: n is armed by the footer, so it is a Button and the engine draws its colon; p prev stays beside it so the walk goes both ways (a fourth hint)', b.sub(45, 'n next error   f find', 'n: next error   p: prev   f find'))
  b.patch(FOOTER_OPTIONS, withOptions(45))
  check('CockpitSteps', b, got)
})

test('fidelity: CockpitArtifacts at 62 columns matches the mock but for the listed deviations', async ($, on) => {
  world(on, artifactsTimeline(), { ...initialUi, tab: 'artifacts' })
  const got = await drawn($, 62, 46)
  const b = new Board('CockpitArtifacts')
  b.patch('R33 and R30: the filled button is drawn as `[ label ]` (Button variant primary) and the words are "saved to this session and copied" (the mock: to the journal and the clipboard)', rows => void (rows[6] = '  [ Export digest ]  saved to this session and copied'))
  b.patch('R30: "The digest will contain" is longer than "It will hold", so the bar takes its own row under it and the legend one more row under that; real data: made counts the 2 artifacts and the 6 files, so the legend says 8 made (the mock says 6 files)', rows => {
    rows[8] = '  The digest will contain'
    rows[9] = '  ' + '¤'.repeat(58)
    return addRow(10, '  ■ summary  ■ 9 tasks  ■ 3 kept  ■ 8 made')(rows)
  })
  b.patch('column heads: kind, edits and from end at 49 like their figures (the mock ends them at 50)', rows => {
    rows[13] = head('Artifacts', '2  ·  kind       age')
    rows[21] = head('Files changed', '6  ·  edits      last')
    rows[27] = head('Kept', '3  ·  from       age')
  })
  b.patch('R27: ages read 9 min, 12 min and 2 min (the mock: 9m, 12m, 2m)', rows => {
    rows[14] = fig('▍ ↗ Rate limit design', 'page', '9 min')
    rows[19] = fig('  ▤ docs/rate-limit-plan.md', 'doc', '12 min')
    rows[22] = rows[22]!.replace(/ +2m$/, '').trimEnd().padEnd(51) + '2 min'.padStart(9)
  })
  b.patch('order and real data: Kept lists the newest first, and a kept step is from its tool (Write), not a note', rows => {
    rows[28] = fig('  ★ the failing 429 test', 'Bash', '3 min')
    rows[29] = fig('  ★ The limiter runs after bodyLimit', 'Write', '6 min')
    rows[30] = fig('  ★ limiter order matters', 'Read', '9 min')
  })
  b.patch(FOOTER_OPTIONS, withOptions(45))
  check('CockpitArtifacts', b, got)
})


// ---------- Raster boxes on the terminal ----------

type El = { type?: unknown; props?: Record<string, unknown>; children?: unknown }
type Box = { row: number; col: number; w: number; h: number }

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
    out.push({ row, col, w: Number(p.columns), h: Number(p.rows) })
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

async function boxesOf($: Engine, columns: number, rows: number): Promise<Box[]> {
  const ui = await $.ui.mount({ ...PANE(columns, rows), surface: 'terminal' })
  const boxes = rasters(await ui.drawn()).out
  await ui.unmount()
  return boxes
}

test('fidelity: on the terminal the Tasks Rasters sit where the mock puts them: lintel, the effort chart, sill, the tethered critters (the to-do bar is Text, R22)', async ($, on) => {
  world(on, tasksTimeline(), { ...initialUi, tab: 'tasks' })
  const boxes = await boxesOf($, 62, 46)
  // The mock: lintel 3,0 62x1; todoT 6,2 58x1; effort 8,18 42x2; sill 11,0 62x1; tether 15,4 4x5 (two critters 4x2).
  // Drawn: the bar is Text (R22); each tethered critter is its own 5x2 box (the badge column, R25), the second at row 18.
  expect(boxes).toEqual([
    { row: 3, col: 0, w: 62, h: 1 },
    { row: 8, col: 18, w: 42, h: 2 },
    { row: 11, col: 0, w: 62, h: 1 },
    { row: 15, col: 4, w: 5, h: 2 },
    { row: 18, col: 4, w: 5, h: 2 },
  ])
})

test('fidelity: on the terminal the Steps map sits where the mock puts it: 58 x 2 at row 7, column 2', async ($, on) => {
  const { t } = stepsTimeline()
  world(on, t, { ...stepsUi(), tab: 'timeline' })
  const boxes = await boxesOf($, 62, 46)
  expect(boxes).toEqual([{ row: 7, col: 2, w: 58, h: 2 }])
})

test('fidelity: on the terminal the Artifacts Rasters are the lintel and the sill (the digest bar is Text, R22)', async ($, on) => {
  world(on, artifactsTimeline(), { ...initialUi, tab: 'artifacts' })
  const boxes = await boxesOf($, 62, 46)
  // The mock: lintel 3,0 62x1; digest 8,18 42x1; sill 10,0 62x1. Drawn: the digest bar is Text, one row lower with its label, the sill at 11.
  expect(boxes).toEqual([
    { row: 3, col: 0, w: 62, h: 1 },
    { row: 11, col: 0, w: 62, h: 1 },
  ])
})
