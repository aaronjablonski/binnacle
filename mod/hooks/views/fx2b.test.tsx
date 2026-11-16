import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Timeline, UiState } from '../../types'
import { initialUi } from '../state'
import { asked, busy, idle, NOW, watching } from './now.fixtures.testkit'
import { tokenText } from './budget'
import { screen } from './screen.testkit'

// The screens fix round, FX2b (Fable round 2 I3 to I12, M-findings): what the content of the cockpit screens
// does at narrow widths, in cuts and in bars. Each test names its finding.

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

const PANE = (columns: number, rows: number, extra: Record<string, unknown> = {}) =>
  ({
    plugin: 'mission-control',
    component: 'Pane',
    requestId: 'mission-control',
    props: { title: 'Mission Control', isFocused: true, bodyColumns: columns, placement: 'dock', scroll: { offset: 0, bodyRows: rows }, view: {}, isPromptCovered: true, ...extra },
  }) as const

async function pane($: Engine, columns: number, rows = 46, extra: Record<string, unknown> = {}): Promise<string[]> {
  const ui = await $.ui.mount({ ...PANE(columns, rows, extra), surface: 'vscode' } as never)
  const out = screen(await ui.drawn())
  await ui.unmount()
  return out
}

async function band($: Engine, columns: number): Promise<string[]> {
  const ui = await $.ui.mount({
    plugin: 'mission-control',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: columns, scroll: { offset: 0, bodyRows: 10 }, view: {} },
    surface: 'mobile',
  } as never)
  const out = screen(await ui.drawn())
  await ui.unmount()
  return out
}

const NARROW = [48, 40, 32]

for (const w of NARROW) {
  test(`F I5 at ${w} columns: a section title is never cut to "…", and the ask keeps its sentence`, async ($, on) => {
    world(on, asked())
    const rows = await pane($, w)
    expect(rows.some(r => r.trim() === '…' || r.includes(' …  ') || r.startsWith('  … '))).toBe(false)
    expect(rows.some(r => r.startsWith('  Agents'))).toBe(true)
    // The ask's sentence: whole on one row ("General asks to run a command" from 40) or wrapped to two, never cut and never left out.
    const text = rows.join(' ').replace(/▍/g, ' ').replace(/\s+/g, ' ')
    expect(text).toContain('General asks to run a')
    expect(text).toMatch(/General asks to run a (command|\s*\S*\s*command)/)
    expect(text).not.toMatch(/asks…|General asks to run a…/)
  })
}

test('F I5: the Agents sum shortens ("1 + 1 waiting") before the title is cut, then drops the hairline, then goes', async ($, on) => {
  world(on, asked())
  const at32 = await pane($, 32)
  expect(at32.find(r => r.startsWith('  Agents'))).toBe('  Agents ─────── 1 + 1 waiting')
  const at62 = await pane($, 62)
  expect(at62.find(r => r.startsWith('  Agents'))?.endsWith('1 working · 1 waiting')).toBe(true)
})

test('F I5: Needs you at 32 columns wraps its sentence to two rows and drops "asked 40s ago"; the marker is as tall as the block', async ($, on) => {
  world(on, asked())
  const rows = await pane($, 32)
  const head = rows.findIndex(r => r.startsWith('  Needs you'))
  expect(rows[head + 1]).toContain('General asks to run a')
  expect(rows[head + 2]).toContain('command')
  expect(rows.join('\n')).not.toContain('asked 40s ago')
  expect([1, 2, 3, 4].every(i => rows[head + i]!.startsWith('▍'))).toBe(true)
  // At 62 columns the age stays beside the sentence on one row.
  const wide = await pane($, 62)
  const h = wide.findIndex(r => r.startsWith('  Needs you'))
  expect(wide[h + 1]).toMatch(/General asks to run a command +asked 40s ago$/)
})

test('F I4: the asked band at 104 columns draws the tool and the whole command two spaces apart', async ($, on) => {
  world(on, asked())
  const rows = await band($, 104)
  expect(rows[0]).toContain('Bash  npm run deploy -- --env staging')
})

for (const cols of [80, 72, 64]) {
  test(`F I4: the asked band at ${cols} columns never glues the tool to the command`, async ($, on) => {
    world(on, asked())
    const ui = await $.ui.mount({
      plugin: 'mission-control',
      component: 'AbovePrompt',
      props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: cols, scroll: { offset: 0, bodyRows: 10 }, view: {} },
      surface: 'mobile',
    } as never)
    const rows = screen(await ui.drawn())
    await ui.unmount()
    expect(rows.join('\n')).not.toMatch(/Bashnpm|Bashdeploy/)
    // The command is whole, cut at two words or more, or left out: never one word and an ellipsis.
    expect(rows[0]).not.toMatch(/Bash {2}\S+…/)
  })
}

for (const w of [40, 32]) {
  test(`F I12 at ${w} columns: the current task shortens its tag, then drops it, and wraps to two rows before its title is cut`, async ($, on) => {
    world(on, busy())
    const rows = await pane($, w)
    const at = rows.findIndex(r => r.startsWith('▍ ▸'))
    expect(at).toBeGreaterThan(-1)
    const joined = rows.slice(at, at + 2).join(' ').replace(/▍/g, ' ').replace(/\s+/g, ' ')
    // The whole title is there, on one row or two, never ending in an ellipsis.
    expect(joined).toContain('Wire the limiter into the chain')
    expect(rows[at]!.includes('…')).toBe(false)
  })
}

test('F I12: at 48 columns the current task keeps its title whole and shortens the tag to "now"', async ($, on) => {
  world(on, busy())
  const rows = await pane($, 48)
  const at = rows.findIndex(r => r.startsWith('▍ ▸'))
  expect(rows[at]).toMatch(/^▍ ▸ Wire the limiter into the chain +now$/)
})

test('R40 (F I6): the idle budget line at 62 columns is "644k of 1M used · cache warm 2 min", whole minutes, beside the gauges', async ($, on) => {
  world(on, idle())
  const rows = await pane($, 62)
  expect(rows.find(r => r.includes('644k'))?.startsWith('  644k of 1M used · cache warm 2 min')).toBe(true)
})

test('F M13: under 30 rows the header is the compact one, so To do and an agent stay in view', async ($, on) => {
  world(on, busy())
  const rows = await pane($, 62, 24)
  expect(rows.some(r => r.startsWith('  To do'))).toBe(true)
  expect(rows.some(r => r.includes('Explorer'))).toBe(true)
  // The gauges and the critter block are gone from the header.
  expect(rows.join('\n')).not.toContain('this week')
  const tall = await pane($, 62, 46)
  expect(tall.join('\n')).toContain('this week')
})

for (const [cols, edge] of [[62, 59], [80, 77], [90, 87]] as const) {
  test(`F M9: at ${cols} columns the gauge words end at column ${edge}, the content edge`, async ($, on) => {
    world(on, busy())
    const rows = await pane($, cols)
    const row = rows.find(r => r.includes('context') && r.includes('this week')) ?? ''
    expect(row.trimEnd().length - 1).toBe(edge)
  })
}

test('F M1: the Watch row keys draw dim', async ($, on) => {
  world(on, watching())
  const ui = await $.ui.mount({ ...PANE(62, 46), surface: 'terminal' } as never)
  const buttons = await ui.findAll({ type: 'Button' })
  const keys = buttons.filter(b => /^watch-(transcript|chat|dismiss)/.test(b.key ?? ''))
  expect(keys.length).toBeGreaterThan(0)
  for (const b of keys) expect(b.props as { dimColor?: boolean }).toMatchObject({ dimColor: true })
  await ui.unmount()
})

test('F M10: the idle strip wraps "the last was …" to a second row before it cuts it', async ($, on) => {
  world(on, idle())
  const rows = await pane($, 140, 30)
  const at = rows.findIndex(r => r.includes('All 14 done'))
  expect(at).toBeGreaterThan(-1)
  const text = rows.slice(at, at + 2).join(' ')
  expect(text).toContain('the last was “Open the pull request”')
})

test('F M10: at 140 columns when asked, the asking agent is among the cards and the cut is named by a "+ n more working" line', async ($, on) => {
  const t = asked()
  world(on, { ...t, agents: { ...t.agents, x1: { ...t.agents.e1!, id: 'x1', description: 'a third one', startedAt: NOW - 30_000 }, x2: { ...t.agents.e1!, id: 'x2', description: 'a fourth one', startedAt: NOW - 20_000 } } })
  const rows = await pane($, 140, 24)
  const text = rows.join('\n')
  expect(text).toContain('waiting for your answer'.slice(0, 0) + 'Waiting for your answer')
  expect(text).toMatch(/\+ \d+ more working/)
})

test('tokenText (F M3) drops a trailing .0', () => {
  expect([950, 1500, 4000, 5000, 9999, 41_000, 1_000_000, 1_300_000].map(tokenText)).toEqual(['950', '1.5k', '4k', '5k', '10k', '41k', '1M', '1.3M'])
})
