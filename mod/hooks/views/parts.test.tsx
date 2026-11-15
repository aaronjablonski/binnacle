import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { EngineInterface, On, RenderElement, RenderInput } from 'claude-code'

import type { UiState } from '../../types'
import { empty } from '../model/reduce'
import { initialUi } from '../state'
import { barCell, blank, fitHints, footer, more, opened, readout, row, section, sparkCell, stackCell } from './parts'
import type { ReadoutCell } from './parts'
import { colOf, screen } from './screen.testkit'
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
