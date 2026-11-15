import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { EngineInterface, On, RenderElement, RenderInput } from 'claude-code'

import type { UiState } from '../../types'
import { empty } from '../model/reduce'
import { initialUi } from '../state'
import { meter, pillRun, pips, spark } from './fit'
import { barCell, blank, deck, fitHints, footer, heightOf, more, opened, pill, readout, row, section, sparkCell, stackCell } from './parts'
import type { DeckRow } from './parts'
import type { ReadoutCell } from './parts'
import { colOf, screen } from './screen.testkit'
import { cellCol, DECK } from './style'
import type { ViewCtx } from './shell'

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
const NOW = 1_000_000

// A test pane, drawn by the test's own ui.render hook (the engine beneath the
// mod), so each primitive is laid out alone at a chosen width.
function draws(on: On, build: (ctx: ViewCtx, $: EngineInterface) => RenderElement | null, focused = false): void {
  mock.clock(on, { now: NOW })
  on('ui.log', () => ({ value: undefined }))
  on('state.get', () => ({ value: { value: undefined, version: 0 } }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    const cols = e.component === 'Pane' ? e.props.bodyColumns : 62
    const u: UiState = initialUi
    const ctx: ViewCtx = { e: e as RenderInput, t: empty, u, cols, now: NOW, isFocused: focused }
    return <Box flexDirection="column">{build(ctx, $)}</Box>
  })
}

const PANE = (columns: number, isFocused = false) =>
  ({
    plugin: 'mission-control',
    component: 'Pane',
    requestId: 'parts-test',
    props: {
      title: 'parts',
      isFocused,
      bodyColumns: columns,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  }) as const

async function rows($: Engine, surface: (typeof SURFACES)[number], columns = 62, isFocused = false): Promise<string[]> {
  const ui = await $.ui.mount({ ...PANE(columns, isFocused), surface })
  const out = screen(await ui.drawn())
  await ui.unmount()
  return out
}

test('row: gutter flag at 0, glyph at 2, name at 4, metric at 38, time at 50, at 62 columns', async ($, on) => {
  draws(on, (ctx, $) =>
    row(ctx, $, { key: 'r1', flag: 'inView', glyph: '▸', glyphColor: 'suggestion', name: 'find every caller of stepRow', metric: '72k', time: '1m', onPress: () => {} }),
  )
  for (const surface of SURFACES) {
    const [r] = await rows($, surface)
    expect(colOf(r, '◂')).toBe(0)
    expect(colOf(r, '▸')).toBe(2)
    expect(colOf(r, 'find every caller')).toBe(4)
    expect(colOf(r, '72k')).toBe(38)
    expect(colOf(r, '1m')).toBe(50)
  }
})

test('row: a tool name of 5 at 4 puts the argument at 10; depth moves the glyph and name by 2 each', async ($, on) => {
  draws(on, (ctx, $) => (
    <>
      {row(ctx, $, { key: 'a', glyph: '✖', glyphColor: 'error', tool: 'Bash', name: 'npm test -- timeline', metric: 'general', time: '4s' })}
      {row(ctx, $, { key: 'b', glyph: '▸', depth: 1, guide: '├', name: 'child', metric: '8k', time: '2m' })}
      {row(ctx, $, { key: 'c', glyph: '✓', depth: 2, guide: '│ └', name: 'grandchild', time: '9s' })}
    </>
  ))
  const [a, b, c] = await rows($, 'terminal')
  expect(colOf(a, 'Bash')).toBe(4)
  expect(colOf(a, 'npm test')).toBe(10)
  expect(colOf(a, 'general')).toBe(38)
  expect(colOf(b, '├')).toBe(2)
  expect(colOf(b, '▸')).toBe(4)
  expect(colOf(b, 'child')).toBe(6)
  expect(colOf(b, '8k')).toBe(38)
  expect(colOf(c, '│ └')).toBe(2)
  expect(colOf(c, '✓')).toBe(6)
  expect(colOf(c, 'grandchild')).toBe(8)
  expect(colOf(c, '9s')).toBe(50)
})

test('row: a long name ends by column 36 at a word boundary', async ($, on) => {
  const name = 'Grouping timeline steps by agent and humanising every label we draw'
  draws(on, (ctx, $) => row(ctx, $, { key: 'r', glyph: '▸', name, metric: '72k', time: '1m' }))
  const [r] = await rows($, 'terminal')
  const drawnName = (r ?? '').slice(4, 38).trimEnd()
  expect(4 + drawnName.length <= 36).toBe(true)
  expect(drawnName.endsWith('…')).toBe(true)
  for (const w of drawnName.slice(0, -1).split(' ')) expect(name.split(' ')).toContain(w)
})

test('row: narrower tiers drop the metric, then move the time, then keep the name only', async ($, on) => {
  draws(on, (ctx, $) => row(ctx, $, { key: 'r', glyph: '▸', name: 'write timeline tests', metric: '88k', time: '40s' }))
  const at55 = (await rows($, 'terminal', 55))[0]
  expect(at55).not.toContain('88k')
  expect(colOf(at55, '40s')).toBe(38)
  const at40 = (await rows($, 'terminal', 40))[0]
  expect(at40).not.toContain('88k')
  expect(colOf(at40, '40s')).toBe(26)
  const at34 = (await rows($, 'terminal', 34))[0]
  expect(at34).not.toContain('88k')
  expect(at34).not.toContain('40s')
  expect(colOf(at34, 'write timeline tests')).toBe(4)
  for (const [cols, r] of [[55, at55], [40, at40], [34, at34]] as const) expect((r ?? '').length <= cols).toBe(true)
})

test('row: one Button keyed by the row, the gutter a sibling Text of width 2; no onPress draws Text', async ($, on) => {
  draws(on, (ctx, $) => (
    <>
      {row(ctx, $, { key: 'press-me', flag: 'problem', glyph: '▸', name: 'pressable', onPress: () => {} })}
      {row(ctx, $, { key: 'still', glyph: '·', name: 'a note' })}
    </>
  ))
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE(62), surface })
    const button = await ui.find({ type: 'Button', key: 'press-me' })
    expect(button?.text).toContain('pressable')
    expect(button?.props).toMatchObject({ plain: true })
    const flag = await ui.find({ type: 'Text', text: /^! $/ })
    expect(flag?.props).toMatchObject({ color: 'error' })
    expect(await ui.find({ type: 'Button', key: 'still' })).toBe(undefined)
    expect((await ui.findAll({ type: 'Button' })).length).toBe(1)
    await ui.unmount()
  }
})

test('section: accent corner at 0, bold label at 2, dim heads at 38 and 50; NEEDS YOU in warning', async ($, on) => {
  draws(on, (ctx, $) => (
    <>
      {section(ctx, $, 'AGENTS', 'tokens', 'time')}
      {section(ctx, $, 'NEEDS YOU', 'why', 'waiting', { tone: 'wait' })}
    </>
  ))
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE(62), surface })
    const [a, b] = screen(await ui.drawn())
    expect(colOf(a, '┌')).toBe(0)
    expect(colOf(a, 'AGENTS')).toBe(2)
    expect(colOf(a, 'tokens')).toBe(38)
    expect(colOf(a, 'time')).toBe(50)
    expect(colOf(b, 'waiting')).toBe(50)
    const corners = (await ui.findAll({ type: 'Text', text: /^┌$/ })).map(f => f.props.color)
    expect(corners).toEqual(['suggestion', 'warning'])
    expect((await ui.find({ type: 'Text', text: /^AGENTS$/ }))?.props).toMatchObject({ bold: true })
    expect((await ui.find({ type: 'Text', text: /^NEEDS YOU$/ }))?.props).toMatchObject({ bold: true, color: 'warning' })
    await ui.unmount()
  }
})

test('section: the time head moves to the last cell at 40 and the heads go at 34', async ($, on) => {
  draws(on, (ctx, $) => section(ctx, $, 'AGENTS', 'tokens', 'time'))
  const [at40] = await rows($, 'terminal', 40)
  expect(at40).not.toContain('tokens')
  expect(colOf(at40, 'time')).toBe(26)
  const [at34] = await rows($, 'terminal', 34)
  expect(at34).toBe('┌ AGENTS')
})

test('opened: dim keys at 6, values at 14, at most 3 lines, then plain hotkeyed actions from 6, 3 apart', async ($, on) => {
  draws(on, (ctx, $) =>
    opened(
      ctx,
      $,
      [
        { key: 'status', value: 'failed after 4s' },
        { key: 'result', value: 'FAIL timeline.test.tsx' },
        { key: 'result', value: '2 tests failed' },
        { key: 'extra', value: 'never drawn' },
      ],
      [
        { hotkey: 'g', label: 'chat', key: 'act-chat', onPress: () => {} },
        { hotkey: 'k', label: 'keep', key: 'act-keep', onPress: () => {} },
        { hotkey: 'c', label: 'copy', key: 'act-copy', onPress: () => {} },
      ],
    ),
  )
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE(62), surface })
    const r = screen(await ui.drawn())
    expect(r.length).toBe(4)
    expect(colOf(r[0], 'status')).toBe(6)
    expect(colOf(r[0], 'failed after 4s')).toBe(14)
    expect(colOf(r[2], '2 tests failed')).toBe(14)
    expect(r.join('\n')).not.toContain('never drawn')
    expect(r[3]).toBe('      g: chat   k: keep   c: copy')
    const keep = await ui.find({ type: 'Button', key: 'act-keep' })
    expect(keep?.props).toMatchObject({ hotkey: 'k', plain: true })
    expect((await ui.find({ type: 'Text', text: /^status$/ }))?.props).toMatchObject({ dimColor: true })
    await ui.unmount()
  }
})

test('opened: actions that do not fit the width are left off from the end', async ($, on) => {
  draws(on, (ctx, $) =>
    opened(ctx, $, [{ key: 'asks', value: 'to run this' }], [
      { hotkey: 'g', label: 'chat', key: 'a1', onPress: () => {} },
      { hotkey: 'x', label: 'dismiss', key: 'a2', onPress: () => {} },
      { hotkey: 'n', label: 'next', key: 'a3', onPress: () => {} },
    ]),
  )
  const r = await rows($, 'terminal', 32)
  for (const x of r) expect(x.length <= 32).toBe(true)
  expect(r[1]).toBe('      g: chat   x: dismiss')
})

const CELLS: ReadoutCell[] = [
  { label: 'TASKS', value: [{ text: '9', bold: true }, { text: '/14', dim: true }], gfx: barCell(9, 14) },
  { label: 'AGENTS', value: '2 live', gfx: stackCell([{ count: 2, color: 'suggestion' }, { count: 3 }, { count: 1, color: 'error' }]) },
  { label: 'STEPS', value: '52', gfx: sparkCell([2, 2, 3, 5, 3, 7, 5, 2, 3, 5]), drop: 2 },
  { label: 'CTX', value: '9%', gfx: barCell(9, 100), drop: 3 },
  { label: '7D', value: '22%', gfx: barCell(22, 100), drop: 1 },
]

test('readout: label, value and a 10-wide diagram per cell, cells on 2, 14, 26, 38, 50', async ($, on) => {
  draws(on, (ctx, $) => readout(ctx, $, CELLS))
  for (const surface of SURFACES) {
    const [labels, values, gfx] = await rows($, surface)
    expect([2, 14, 26, 38, 50].map((c, i) => colOf(labels, CELLS[i]!.label) === c)).toEqual([true, true, true, true, true])
    expect(colOf(values, '9/14')).toBe(2)
    expect(colOf(values, '2 live')).toBe(14)
    expect(colOf(values, '22%')).toBe(50)
    for (const c of [2, 14, 26, 38, 50]) {
      const cell = (gfx ?? '').slice(c, c + 12)
      expect(cell.slice(0, 10)).toMatch(/^[━─▁▂▃▄▅▆▇█]{10}$/)
      expect(cell.slice(10).trim()).toBe('')
    }
    expect((gfx ?? '').slice(26, 36)).toBe('▃▃▄▆▄█▆▃▄▆')
  }
})

test('readout: fewer cells by the priority rule at 55, 40 and 34', async ($, on) => {
  draws(on, (ctx, $) => readout(ctx, $, CELLS))
  const labels = async (cols: number) => ((await rows($, 'terminal', cols))[0] ?? '').trim().split(/\s+/)
  expect(await labels(55)).toEqual(['TASKS', 'AGENTS', 'STEPS', 'CTX'])
  expect(await labels(40)).toEqual(['TASKS', 'AGENTS', 'CTX'])
  expect(await labels(34)).toEqual(['TASKS', 'AGENTS'])
})

test('diagram cells are exactly 10 wide, in the bar rules', async ($, on) => {
  draws(on, () => null)
  const width = (rs: { text: string }[]) => rs.reduce((n, r) => n + r.text.length, 0)
  expect(width(barCell(0, 0))).toBe(10)
  expect(width(barCell(1, 1000))).toBe(10)
  expect(barCell(1, 1000)[0]).toEqual({ text: '━', color: 'suggestion' })
  expect(barCell(78, 100, 'warning')[0]?.color).toBe('warning')
  expect(barCell(5, 10)[1]).toEqual({ text: '─────', color: 'subtle' })
  expect(width(stackCell([{ count: 2, color: 'suggestion' }, { count: 3 }, { count: 1, color: 'error' }]))).toBe(10)
  expect(width(stackCell([{ count: 0 }, { count: 0 }]))).toBe(10)
  expect(width(sparkCell([1, 2, 3]))).toBe(10)
})

test('footer: at most 3 dim hints from column 2, only while the pane has the focus', async ($, on) => {
  const hints = (ctx: ViewCtx, $: EngineInterface) =>
    footer(ctx, $, [
      { hotkey: 'n', label: 'next error', key: 'hint-n', onPress: () => {} },
      { hotkey: 'p', label: 'prev', key: 'hint-p', onPress: () => {} },
      { text: 'esc prompt' },
      { text: 'never drawn' },
    ])
  draws(on, hints, true)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE(62, true), surface })
    const [r] = screen(await ui.drawn())
    expect(r).toBe('  n: next error   p: prev   esc prompt')
    expect((await ui.find({ type: 'Button', key: 'hint-n' }))?.props).toMatchObject({ hotkey: 'n', plain: true, dimColor: true })
    expect((await ui.find({ type: 'Text', text: /^esc prompt$/ }))?.props).toMatchObject({ dimColor: true })
    await ui.unmount()
  }
})

test('footer: nothing while the pane is not focused', async ($, on) => {
  draws(on, (ctx, $) => footer(ctx, $, [{ text: 'esc prompt' }]), false)
  expect(await rows($, 'terminal')).toEqual([])
})

test('more and blank: "+ n more" dim at 2 and 4 (moved by depth), one empty row', async ($, on) => {
  draws(on, (ctx, $) => (
    <>
      {more(ctx, $, 6)}
      {blank(ctx, $)}
      {more(ctx, $, 2, 'done', 1)}
    </>
  ))
  const r = await rows($, 'terminal')
  expect(r).toEqual(['  + 6 more', '', '    + 2 done'])
})

const key = (hotkey: string, label: string) => ({ hotkey, label, key: `hint-${hotkey}`, onPress: () => undefined })

test('fitHints: three hints that fit are all kept, in order', () => {
  const hints = [{ text: '↵ open' }, key('d', 'all done'), key('e', 'export')]
  expect(fitHints(hints, 62)).toEqual(hints)
})

test('fitHints: a narrow footer gives up the engine-key text first, so the hotkeys stay', () => {
  const hints = [{ text: '↵ open' }, key('d', 'newest 3'), key('e', 'export')]
  const kept = fitHints(hints, 32)
  expect(kept.map(h => ('hotkey' in h ? h.hotkey : h.text))).toEqual(['d', 'e'])
})

test('fitHints: with no text left it drops from the end, and always keeps one', () => {
  const hints = [key('d', 'all done'), key('e', 'export')]
  expect(fitHints(hints, 16).map(h => ('hotkey' in h ? h.hotkey : h.text))).toEqual(['d'])
  expect(fitHints(hints, 2)).toHaveLength(1)
})

test('fitHints: only 3 hints are ever kept', () => {
  expect(fitHints([key('a', 'a'), key('b', 'b'), key('c', 'c'), key('d', 'd')], 80)).toHaveLength(3)
})

test('row: a metric or time cell that does not fit is cut at a word, never inside one, at 62, 40 and 32', async ($, on) => {
  const metric = 'doc ×12 more runs'
  const time = 'about 12m ago now'
  draws(on, (ctx, $) => row(ctx, $, { key: 'r', glyph: '▸', name: 'write timeline tests', metric, time }))
  const wholeWords = (cell: string, source: string): boolean => {
    const stem = cell.endsWith('…') ? cell.slice(0, -1) : cell
    return source.startsWith(stem) && (stem === source || source[stem.length] === ' ')
  }
  for (const surface of SURFACES) {
    const at62 = (await rows($, surface, 62))[0] ?? ''
    expect(wholeWords(at62.slice(38, 50).trimEnd(), metric)).toBe(true)
    expect(at62.slice(38, 50).trimEnd().endsWith('…')).toBe(true)
    expect(wholeWords(at62.slice(50).trimEnd(), time)).toBe(true)
    const at40 = (await rows($, surface, 40))[0] ?? ''
    expect(wholeWords(at40.slice(26).trimEnd(), time)).toBe(true)
    expect(at40.slice(26).trimEnd().endsWith('…')).toBe(true)
    const at32 = (await rows($, surface, 32))[0] ?? ''
    expect(at32.length <= 32).toBe(true)
    expect(at32).not.toContain('doc')
  }
})

// ---------- Neo: deck, pill, row tethers ----------

const NOW_DECK: (DeckRow | null)[] = [
  { label: 'FOCUS', cells: [{ col: DECK.gauge, runs: [{ text: 'Grouping timeline steps by agent', bold: true }] }, { col: DECK.aside, runs: [{ text: '20s', dim: true }] }] },
  { label: 'NEXT', cells: [{ col: DECK.gauge, runs: 'Humanise step labels' }] },
  null,
  {
    label: 'TASKS',
    cells: [
      { col: DECK.gauge, runs: pips(9, 14), whole: true },
      { col: DECK.value, runs: [{ text: '9', bold: true }, { text: '/14', dim: true }] },
      { col: DECK.aside, runs: [{ text: '1h23', dim: true }] },
    ],
  },
  {
    label: 'STEPS',
    cells: [
      { col: DECK.gauge, runs: spark([2, 1, 2, 3, 2, 3, 5, 4, 3, 2, 5, 7, 6, 5, 3, 2, 2, 3, 4, 5, 3, 5], 22), narrow: spark([5, 7, 6, 5, 3, 2, 2, 3, 4, 5], 10), whole: true },
      { col: DECK.value, runs: [{ text: '52', bold: true }] },
      { col: DECK.aside, runs: [{ text: '✖ 1', color: 'error' }] },
    ],
  },
  { label: 'BUDGET', cells: [{ col: DECK.gauge, runs: meter('CTX', 9), whole: true }, { col: cellCol(2), runs: meter('5H', 78), whole: true }, { col: DECK.value, runs: meter('7D', 22), whole: true }] },
]

test('deck: rails in column 0 and the last column, a bracket that opens also closes, at 62, 40 and 32', async ($, on) => {
  draws(on, (ctx, $) => deck(ctx, $, NOW_DECK, { key: 'now' }))
  for (const cols of [62, 40, 32]) {
    for (const surface of SURFACES) {
      const r = await rows($, surface, cols)
      expect(r).toHaveLength(NOW_DECK.length)
      expect(r[0]?.[0]).toBe('┏')
      expect(r[r.length - 1]?.[0]).toBe('┗')
      for (const mid of r.slice(1, -1)) expect(mid[0]).toBe('┃')
      expect(r[0]?.[cols - 1]).toBe('┓')
      expect(r[r.length - 1]?.[cols - 1]).toBe('┛')
      for (const mid of r.slice(1, -1)) expect(mid[cols - 1]).toBe('┃')
      for (const row of r) expect(row.length).toBe(cols)
      // the blank rail row holds its rails and nothing else
      expect(r[2]?.slice(1, cols - 1).trim()).toBe('')
    }
  }
})

test('deck: the label at 2, the gauge at 14, the value at 38 and the aside at 50 at 62 columns; nothing past 59', async ($, on) => {
  draws(on, (ctx, $) => deck(ctx, $, NOW_DECK, { key: 'now' }))
  for (const surface of SURFACES) {
    const r = await rows($, surface, 62)
    expect(colOf(r[0], 'FOCUS')).toBe(2)
    expect(colOf(r[0], 'Grouping timeline')).toBe(14)
    expect(colOf(r[0], '20s')).toBe(50)
    expect(colOf(r[1], 'NEXT')).toBe(2)
    expect(colOf(r[1], 'Humanise')).toBe(14)
    expect(colOf(r[3], 'TASKS')).toBe(2)
    expect(colOf(r[3], '▪▪▪▪▪▪▪▪▪▸▫▫▫▫')).toBe(14)
    expect(colOf(r[3], '9/14')).toBe(38)
    expect(colOf(r[3], '1h23')).toBe(50)
    expect((r[4] ?? '')[13]).toBe(' ')
    expect((r[4] ?? '').slice(14, 36)).toMatch(/^[▁▂▃▄▅▆▇█]{22}$/)
    expect(colOf(r[4], '52')).toBe(38)
    expect(colOf(r[5], 'CTX ◔ 9%')).toBe(14)
    expect(colOf(r[5], '5H ◕ 78%')).toBe(26)
    expect(colOf(r[5], '7D ◔ 22%')).toBe(38)
    for (const row of r) expect(row.slice(60, 61)).toBe(' ')
  }
})

test('deck: below 62 the aside goes; below 50 the value goes too; a gauge that does not fit takes its narrow form or goes', async ($, on) => {
  draws(on, (ctx, $) => deck(ctx, $, NOW_DECK, { key: 'now' }))
  const at55 = await rows($, 'terminal', 55)
  expect(at55[0]).not.toContain('20s')
  expect(at55[3]).not.toContain('1h23')
  expect(colOf(at55[3], '9/14')).toBe(38)
  expect(colOf(at55[4], '52')).toBe(38)
  expect(colOf(at55[5], '7D ◔ 22%')).toBe(38)
  const at40 = await rows($, 'terminal', 40)
  expect(at40[3]).not.toContain('9/14')
  expect(at40[4]).not.toContain('52')
  expect(at40[5]).not.toContain('7D')
  expect(colOf(at40[3], '▪▪▪▪▪▪▪▪▪▸▫▫▫▫')).toBe(14)
  expect((at40[4] ?? '').slice(14, 36)).toMatch(/^[▁▂▃▄▅▆▇█]{22}$/)
  expect(colOf(at40[5], '5H ◕ 78%')).toBe(26)
  const at32 = await rows($, 'terminal', 32)
  // the 22-wide trace does not fit 14 to 29: its 10-wide narrow form does
  expect((at32[4] ?? '').slice(14, 24)).toMatch(/^[▁▂▃▄▅▆▇█]{10}$/)
  expect((at32[4] ?? '').slice(24, 31).trim()).toBe('')
  // a whole cell with no narrow form is left out, never cut
  expect(at32[5]).not.toContain('5H')
  expect(colOf(at32[5], 'CTX ◔ 9%')).toBe(14)
  // text is cut at a word with …
  const focus = (at32[0] ?? '').slice(14, 31).trimEnd()
  expect(focus.endsWith('…')).toBe(true)
  expect('Grouping timeline steps by agent'.startsWith(focus.slice(0, -1))).toBe(true)
  expect(focus.length).toBeLessThanOrEqual(16)
})

test('deck: corners in the accent and rails in subtle; the warning tone turns corners and rails warning', async ($, on) => {
  draws(on, (ctx, $) => (
    <>
      {deck(ctx, $, [{ label: 'A' }, { label: 'B' }, { label: 'C' }], { key: 'calm' })!}
      {deck(ctx, $, [{ label: 'D' }, { label: 'E' }, { label: 'F' }], { key: 'hot', tone: 'warning' })!}
    </>
  ))
  const ui = await $.ui.mount({ ...PANE(62), surface: 'terminal' })
  const colour = async (re: RegExp) => (await ui.findAll({ type: 'Text', text: re })).map(f => f.props.color)
  expect(await colour(/^┏ $/)).toEqual(['suggestion', 'warning'])
  expect(await colour(/^┓$/)).toEqual(['suggestion', 'warning'])
  expect(await colour(/^┗ $/)).toEqual(['suggestion', 'warning'])
  expect(await colour(/^┛$/)).toEqual(['suggestion', 'warning'])
  expect(await colour(/^┃ $/)).toEqual(['subtle', 'warning'])
  expect(await colour(/^┃$/)).toEqual(['subtle', 'warning'])
  expect((await ui.find({ type: 'Text', text: /^A$/ }))?.props).toMatchObject({ dimColor: true })
  await ui.unmount()
})

test('deck: the left-only variant draws no right rail; a one-row deck folds to two rails in the tone', async ($, on) => {
  draws(on, (ctx, $) => (
    <>
      {deck(ctx, $, [{ label: 'CREW', cells: [{ col: DECK.gauge, runs: 'pods' }, { col: DECK.value, runs: '2 live' }] }, { label: 'TASKS' }], { key: 'strip', side: 'left', cols: 50 })!}
      {deck(ctx, $, [{ label: [pillRun('WORKING', 'suggestion')], cells: [{ col: DECK.gauge, runs: 'focus' }] }], { key: 'band' })!}
    </>
  ))
  const ui = await $.ui.mount({ ...PANE(62), surface: 'terminal' })
  const r = screen(await ui.drawn())
  expect(r[0]?.[0]).toBe('┏')
  expect(colOf(r[0], '2 live')).toBe(38)
  expect(r[0]?.endsWith('2 live')).toBe(true)
  expect(r[1]).toBe('┗ TASKS')
  expect(r[2]?.[0]).toBe('┃')
  expect(r[2]?.[61]).toBe('┃')
  expect(colOf(r[2], ' WORKING ')).toBe(2)
  const folded = await ui.findAll({ type: 'Text', text: /^┃ ?$/ })
  expect(folded.map(f => f.props.color)).toEqual(['suggestion', 'suggestion'])
  await ui.unmount()
})

test('deck: a row with onPress is one plain Button keyed by the row (the press target), holding only strings and Texts', async ($, on) => {
  draws(on, (ctx, $) =>
    deck(ctx, $, [{ key: 'crew', label: 'CREW', cells: [{ col: DECK.gauge, runs: 'pods' }], onPress: () => {} }, { label: 'TASKS' }], { key: 'now' }),
  )
  const ui = await $.ui.mount({ ...PANE(62), surface: 'terminal' })
  const buttons = await ui.findAll({ type: 'Button' })
  expect(buttons).toHaveLength(1)
  expect(buttons[0]?.props).toMatchObject({ plain: true })
  expect(await ui.find({ type: 'Button', key: 'crew' })).not.toBe(undefined)
  const hasBox = (n: unknown): boolean => {
    if (n === null || typeof n !== 'object') return false
    if (Array.isArray(n)) return n.some(hasBox)
    const el = n as { type?: unknown; props?: { children?: unknown }; children?: unknown }
    if (el.type === 'Box') return true
    return hasBox(el.children ?? el.props?.children)
  }
  const findButton = (n: unknown): unknown => {
    if (n === null || typeof n !== 'object') return undefined
    if (Array.isArray(n)) {
      for (const k of n) {
        const f = findButton(k)
        if (f !== undefined) return f
      }
      return undefined
    }
    const el = n as { type?: unknown; props?: { children?: unknown }; children?: unknown }
    if (el.type === 'Button') return el
    return findButton(el.children ?? el.props?.children)
  }
  const button = findButton(await ui.drawn()) as { children?: unknown; props?: { children?: unknown } }
  expect(hasBox(button.children ?? button.props?.children)).toBe(false)
  const r = screen(await ui.drawn())
  expect(r[0]?.[61]).toBe('┓')
  expect(colOf(r[0], 'pods')).toBe(14)
  await ui.unmount()
})

test('pill: a Text with backgroundColor and inverseText, one space each side, bold', async ($, on) => {
  draws(on, (ctx, $) => pill('NEEDS YOU', 'warning', ctx.e, $, 'pill-needs'))
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE(62), surface })
    const t = await ui.find({ type: 'Text', text: ' NEEDS YOU ' })
    expect(t?.props).toMatchObject({ backgroundColor: 'warning', color: 'inverseText', bold: true })
    expect(screen(await ui.drawn())[0]).toBe(' NEEDS YOU')
    await ui.unmount()
  }
})

test('row: a tether prefix puts ├╌ at 2 and the hull at 4; two deep, ┆ at 2, the tether at 4 and the hull at 6', async ($, on) => {
  draws(on, (ctx, $) => (
    <>
      {row(ctx, $, { key: 't1', glyph: '◉', glyphColor: 'suggestion', depth: 1, tether: { last: false }, name: 'find every caller', metric: '72k', time: '1m' })}
      {row(ctx, $, { key: 't2', glyph: '◬', depth: 2, tether: { last: false, outer: true }, name: 'review the hooks', metric: '64k', time: '1m' })}
      {row(ctx, $, { key: 't3', glyph: '▣', depth: 2, tether: { last: true }, name: 'write tests', time: '9s' })}
      {row(ctx, $, { key: 't4', glyph: '■', depth: 1, tether: { last: true }, name: 'last child' })}
    </>
  ))
  const ui = await $.ui.mount({ ...PANE(62), surface: 'terminal' })
  const [a, b, c, d] = screen(await ui.drawn())
  expect(colOf(a, '├╌')).toBe(2)
  expect(colOf(a, '◉')).toBe(4)
  expect(colOf(a, 'find every caller')).toBe(6)
  expect(colOf(a, '72k')).toBe(38)
  expect(colOf(b, '┆')).toBe(2)
  expect(colOf(b, '├╌')).toBe(4)
  expect(colOf(b, '◬')).toBe(6)
  expect(colOf(b, 'review the hooks')).toBe(8)
  expect(colOf(c, '┆')).toBe(-1)
  expect(colOf(c, '╰╌')).toBe(4)
  expect(colOf(c, '▣')).toBe(6)
  expect(colOf(d, '╰╌')).toBe(2)
  expect(colOf(d, '■')).toBe(4)
  const tethers = await ui.findAll({ type: 'Text', text: /^(├╌|┆ ├╌|  ╰╌|╰╌)$/ })
  expect(tethers.map(t => t.props.color)).toEqual(['subtle', 'subtle', 'subtle', 'subtle'])
  await ui.unmount()
})

test('row: the waiting and stalled flags draw ? and z in the gutter, in the warning colour', async ($, on) => {
  draws(on, (ctx, $) => (
    <>
      {row(ctx, $, { key: 'asks', flag: 'waiting', glyph: '◉', name: 'asks the person', onPress: () => {} })}
      {row(ctx, $, { key: 'stuck', flag: 'stalled', glyph: '◉', name: 'has gone quiet', onPress: () => {} })}
    </>
  ))
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE(62), surface })
    const all = screen(await ui.drawn())
    expect(all.find(r => r.includes('asks the person'))?.slice(0, 3)).toBe('? ◉')
    expect(all.find(r => r.includes('has gone quiet'))?.slice(0, 3)).toBe('z ◉')
    expect((await ui.find({ type: 'Text', text: /^\? $/ }))?.props).toMatchObject({ color: 'warning' })
    expect((await ui.find({ type: 'Text', text: /^z $/ }))?.props).toMatchObject({ color: 'warning' })
    await ui.unmount()
  }
})

test('heightOf: the rows a built deck, a section and a blank take, as the screen lays them out', async ($, on) => {
  const got: { measured: number; laid: number }[] = []
  draws(on, (ctx, $) => {
    const els = [
      deck(ctx, $, [
        { key: 'r1', label: 'ONE', cells: [{ col: DECK.gauge, runs: [{ text: 'a' }] }] },
        { key: 'r2', label: 'TWO', cells: [{ col: DECK.gauge, runs: [{ text: 'b' }] }] },
      ]),
      section(ctx, $, 'LIST', 'tokens', 'time'),
      blank(ctx, $, 'gap'),
      row(ctx, $, { key: 'x', glyph: '▸', name: 'a row' }),
    ]
    for (const el of els) got.push({ measured: heightOf(el), laid: screen(el).length })
    return null
  })
  await rows($, 'terminal')
  expect(got.length).toBe(4)
  for (const g of got) expect(g.measured).toBe(g.laid)
})
