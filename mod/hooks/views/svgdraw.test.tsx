import { expect, mock, test } from 'claude-code/testing'
import type { EngineInterface, On, RenderElement, RenderInput } from 'claude-code'

import type { Tab, Timeline, UiState } from '../../types'
import { empty } from '../model/reduce'
import { initialUi } from '../state'
import type { ViewCtx } from './shell'
import { deckModel, SVG_MAX } from './svg'
import { bandSvgOf, deckSvg, lookFor } from './svgview'

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
const NOW = 5_000_000
const SHAPES: Record<string, string> = { timeline: 'timeline-4', ui: 'ui-4' }

const busy: Timeline = {
  ...empty,
  now: { focus: 'Wiring the limiter into the middleware chain', next: 'Run the upload tests', at: NOW - 60_000 },
  turns: [{ id: 't1', agent: 'main', prompt: 'go', startedAt: NOW - 300_000 }],
  agents: {
    ...empty.agents,
    a1: {
      id: 'a1',
      parent: 'main',
      type: 'Explore',
      description: 'find callers',
      status: 'running',
      startedAt: NOW - 60_000,
      doing: '',
      stepCount: 1,
    },
  },
  tasks: [
    { id: '1', subject: 'one', status: 'completed', owner: 'main', updatedAt: NOW },
    { id: '2', subject: 'two', status: 'in_progress', owner: 'main', updatedAt: NOW },
  ],
  steps: [{ id: 's1', seq: 1, agent: 'main', tool: 'Edit', label: 'Edit a.ts', status: 'running', startedAt: NOW - 5000 }],
  budget: { contextPct: 12, windows: [{ name: 'five_hour', pct: 40 }], at: NOW },
}

/**
 * Two test panes that draw the deck and the band Svgs as Now and the band
 * would, with the shell's look: `svg-test` the deck, `band-test` the band
 * (a pane of the test's own, so the mod's band hook does not answer it).
 */
function draws(on: On): void {
  mock.clock(on, { now: NOW })
  on('ui.log', () => ({ value: undefined }))
  on('ui.render', { component: 'Pane', requestId: 'svg-test' }, ($: EngineInterface, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const cols = e.component === 'Pane' ? e.props.bodyColumns : 62
    const ctx: ViewCtx = {
      e: e as RenderInput, t: busy, u: initialUi, cols, now: NOW,
      look: lookFor($.ui.resolve(e), e.surface), site: 'svg-test',
    }
    const svg: RenderElement | null = deckSvg(ctx, $)
    return <Box flexDirection="column">{svg ?? <Text>text deck</Text>}</Box>
  })
  on('ui.render', { component: 'Pane', requestId: 'band-test' }, ($: EngineInterface, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const look = lookFor($.ui.resolve(e), e.surface)
    const svg = bandSvgOf($, { e: e as RenderInput, look, t: busy, u: initialUi, now: NOW, cols: 120 })
    return <Box flexDirection="column">{svg ?? <Text>text band</Text>}</Box>
  })
}

const PANE = {
  plugin: 'mission-control',
  component: 'Pane',
  requestId: 'svg-test',
  props: { title: 't', isFocused: true, bodyColumns: 62, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

test('the look: rich on the terminal, svg on the desktop app only, text in VS Code and on mobile', async ($, on) => {
  const looks: Record<string, string> = {}
  mock.clock(on, { now: NOW })
  on('ui.render', { component: 'Pane', requestId: 'look-test' }, ($: EngineInterface, e) => {
    const { Text } = $.ui.resolve(e)
    looks[e.surface] = lookFor($.ui.resolve(e), e.surface)
    return <Text>look</Text>
  })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, requestId: 'look-test', surface })
    await ui.drawn()
    await ui.unmount()
  }
  expect(looks).toEqual({ terminal: 'rich', desktop: 'svg', vscode: 'text', mobile: 'text' })
})

test('Now\'s deck is one interactive Svg with an alt on the desktop app, under the limit; none elsewhere', async ($, on) => {
  draws(on)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const svgs = await ui.findAll({ type: 'Svg' })
    if (surface === 'desktop') {
      expect(svgs.length).toBe(1)
      const p = svgs[0]!.props as { source: string; alt: string; isInteractive?: boolean }
      expect(p.source.length).toBeLessThan(SVG_MAX)
      expect(p.alt).toContain('WORKING')
      expect(p.isInteractive).toBe(true)
      expect(await ui.find({ type: 'Raster' })).toBe(undefined)
    } else {
      expect(svgs.length).toBe(0)
    }
    await ui.unmount()
  }
})

test('the band is a second Svg on the desktop app, none on the terminal or in VS Code', async ($, on) => {
  draws(on)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, requestId: 'band-test', surface })
    const svgs = await ui.findAll({ type: 'Svg' })
    expect(svgs.length).toBe(surface === 'desktop' ? 1 : 0)
    if (surface === 'desktop') {
      const p = svgs[0]!.props as { source: string; alt: string }
      expect(p.source.length).toBeLessThan(SVG_MAX)
      expect(p.alt.length).toBeGreaterThan(0)
    }
    await ui.unmount()
  }
})

test('the deck\'s figures are the model\'s', async () => {
  const m = deckModel(busy, initialUi, NOW)
  expect([m.pill.word, m.tasks.done, m.tasks.total, m.live]).toEqual(['WORKING', 1, 2, 1])
  // The model has no step count now (the header holds no log); the rings carry the pane's words, not CTX and 5H.
  expect(m.rings.map(r => `${r.name} ${r.pct}`)).toEqual(['context 12', '5 hours 40'])
})

// ---------- the whole pane on the desktop app: no Raster anywhere ----------

/** The state as the engine holds it; `stored.set('ui', …)` between mounts changes the page drawn. */
function world(on: On): Map<string, unknown> {
  const stored = new Map<string, unknown>([['timeline', busy], ['ui', initialUi]])
  mock.clock(on, { now: NOW })
  on('ui.log', () => ({ value: undefined }))
  on('state.get', (_, e) => {
    const key = (e as { key: string }).key
    const v = stored.get(key)
    return { value: { value: v === undefined ? undefined : { shape: SHAPES[key], value: v }, version: 0 } }
  })
  return stored
}

const TABS: Tab[] = ['overview', 'tasks', 'agents', 'timeline', 'artifacts']

test('no Raster is drawn on the desktop app: every tab and the Options page', async ($, on) => {
  const pages: UiState[] = [...TABS.map(tab => ({ ...initialUi, tab })), { ...initialUi, page: { kind: 'options', id: '' } }]
  const stored = world(on)
  for (const u of pages) {
    stored.set('ui', u)
    const ui = await $.ui.mount({ ...PANE, requestId: 'mission-control', surface: 'desktop' })
    expect(await ui.find({ type: 'Raster' })).toBe(undefined)
    await ui.unmount()
  }
})
