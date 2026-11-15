import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { EngineInterface, On, RenderElement, RenderInput } from 'claude-code'

import type { AgentRow, ArtifactRow, Step, TaskItem, Timeline, UiState } from '../../types'
import { empty } from '../model/reduce'
import { initialUi } from '../state'
import { agentPage, agentsView } from './agents'
import { artifactPage, artifactsView } from './artifacts'
import { budgetView } from './budget'
import { stepPage } from './detail'
import { needsSection } from './needs'
import { optionsPage } from './options'
import { overviewView } from './overview'
import { screen } from './screen.testkit'
import type { ViewCtx } from './shell'
import { slimView } from './slim'
import { richStrip } from './stripband'
import { taskPage, tasksView } from './tasks'
import { timelineView } from './timeline'

// Sweeps every rich deck, view and page over widths, drawn alone by the
// test's own ui.render hook (so a page is reached under 32 columns too,
// where the pane itself would draw slim). A view that throws is caught and
// recorded: the pane's own catch turns it into "This tab failed", which is
// the refusal these sweeps exist to rule out.

const NOW = 10_000_000

const task = (id: string, subject: string, status: TaskItem['status'], extra: Partial<TaskItem> = {}): TaskItem => ({
  id, subject, status, owner: 'main', updatedAt: NOW - 120_000, ...extra,
})
const step = (id: string, seq: number, tool: string, label: string, status: Step['status'], extra: Partial<Step> = {}): Step => ({
  id, seq, agent: 'main', tool, label, status, startedAt: NOW - 50_000 + seq * 1000, ...(status !== 'running' ? { endedAt: NOW - 40_000 + seq * 1000 } : {}), ...extra,
})
const agent = (id: string, type: string, description: string, status: AgentRow['status'] = 'running', extra: Partial<AgentRow> = {}): AgentRow => ({
  id, parent: 'main', type, description, status, startedAt: NOW - 600_000, doing: 'Reading the reducer for usage attribution', stepCount: 4, tokensIn: 48_000, tokensOut: 3_100, model: 'claude-opus-5-5', ...extra,
})
const artifact = (id: string, kind: ArtifactRow['kind'], title: string, extra: Partial<ArtifactRow> = {}): ArtifactRow => ({
  id, kind, title, agent: 'main', count: 1, updatedAt: NOW - 90_000, ...extra,
})

/** A busy session: long names, long tools, a waiting agent, every kind of row. */
export const BUSY: Timeline = {
  ...empty,
  seq: 30,
  now: { focus: 'Consolidating the lintel guards into one shared rule across every deck', next: 'Sweep every view for mid-word cuts', at: NOW - 30_000 },
  turns: [
    { id: 't1', agent: 'main', prompt: 'Fix the review findings for the rich build', startedAt: NOW - 900_000, endedAt: NOW - 700_000 },
    { id: 't2', agent: 'main', prompt: 'Continue with the important findings and their tests', startedAt: NOW - 600_000 },
  ],
  tasks: [
    task('1', 'Consolidate the lintel guards', 'completed', { tokens: 120_000, ms: 300_000 }),
    task('2', 'Open detail pages with Enter everywhere', 'in_progress', { activeForm: 'Opening detail pages with Enter everywhere', tokens: 80_000, ms: 200_000 }),
    task('3', 'Sweep every view for mid-word cuts', 'pending'),
    task('4', 'Grow every list with the pane height', 'pending'),
    task('1', 'Subagent planning checklist item', 'in_progress', { owner: 'a1' }),
  ],
  agents: {
    main: { ...empty.agents.main!, tokensIn: 400_000, tokensOut: 20_000, model: 'claude-opus-5-5' },
    a1: agent('a1', 'Explore', 'Find every caller of the lintel and the readout guards', 'running', { taskId: '2' }),
    a2: agent('a2', 'general-purpose', 'Write the sweep tests for widths between twenty-two and sixty-two', 'done', { endedAt: NOW - 100_000, taskId: '2', result: 'Wrote eleven tests across three files' }),
    a3: agent('a3', 'code-reviewer', 'Review the consolidation for drift', 'running', { taskId: '1' }),
  },
  steps: [
    step('s1', 1, 'Bash', 'Bash npm test', 'error', { agent: 'a2' }),
    step('s2', 2, 'SubagentHandback', 'SubagentHandback the full report for the caller', 'done', { agent: 'a2' }),
    step('s3', 3, 'NotebookEdit', 'NotebookEdit analysis notebook second cell', 'done'),
    step('s4', 4, 'TodoWrite', 'TodoWrite seven items', 'done'),
    step('s5', 5, 'MultiEdit', 'MultiEdit mod/hooks/views/parts.tsx', 'done'),
    step('s6', 6, 'Read', 'Read mod/hooks/views/raster.ts', 'running', { agent: 'a1' }),
    step('s7', 7, 'Bash', 'Bash git status --short', 'running', { agent: 'a3', asking: NOW - 60_000 }),
    step('s8', 8, 'Edit', 'Edit mod/hooks/views/overview.tsx', 'running'),
  ],
  artifacts: [
    artifact('r1', 'result', 'Lintel sweep across every width', { summary: 'No refusal between twenty-two and sixty-two columns', stepId: 's5' }),
    artifact('p1', 'page', 'Mission Control review findings', { ref: 'https://claude.ai/artifact/abc', count: 3 }),
    artifact('d1', 'document', 'docs/superpowers/specs/2026-11-15-mission-control-rich-design.md', { ref: 'docs/superpowers/specs/2026-11-15-mission-control-rich-design.md' }),
  ],
  changed: ['mod/hooks/views/parts.tsx', 'mod/hooks/views/raster.ts', 'test/raster.test.ts'],
  budget: { contextPct: 41, contextTokens: 82_000, windows: [{ name: 'five_hour', pct: 64, resetsAt: NOW + 3_600_000 }, { name: 'seven_day', pct: 22, resetsAt: NOW + 86_400_000 }], at: NOW },
  cache: { at: NOW - 60_000 },
}

type Build = (ctx: ViewCtx, $: EngineInterface) => RenderElement | null | undefined

/** Every rich deck, view and page, by name. */
export const BUILDS: Record<string, Build> = {
  now: (c, $) => overviewView(c, $),
  needs: (c, $) => needsSection(c, $),
  budget: (c, $) => budgetView(c, $),
  slim: (c, $) => slimView(c, $),
  strip: (c, $) => richStrip(c, $, { maxRows: 12 }),
  tasks: (c, $) => tasksView(c, $),
  agents: (c, $) => agentsView(c, $),
  crew: (c, $) => agentsView({ ...c, u: { ...c.u, agentsMode: 'tree' } }, $),
  steps: (c, $) => timelineView(c, $),
  artifacts: (c, $) => artifactsView(c, $),
  'task page': (c, $) => taskPage(c, $, 'main:2'),
  'agent page': (c, $) => agentPage(c, $, 'a2'),
  'step page': (c, $) => stepPage(c, $, 's2'),
  'artifact page': (c, $) => artifactPage(c, $, 'r1'),
  'options page': (c, $) => optionsPage(c, $, ''),
}

const state: { build?: Build; failed: string[] } = { failed: [] }

/** The test's own Pane: draws `state.build` alone, in the rich look, and records a throw. */
export function sweeps(on: On, t: Timeline = BUSY, u: UiState = initialUi): { failed: string[] } {
  const stored = new Map<string, unknown>([['timeline', t], ['ui', u]])
  mock.clock(on, { now: NOW })
  on('ui.log', () => ({ value: undefined }))
  on('state.get', (_, e) => {
    const v = stored.get((e as { key: string }).key)
    return { value: { value: v === undefined ? undefined : { shape: 'x', value: v }, version: 0 } }
  })
  on('ui.render', ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    if (e.component !== 'Pane') return null as never
    const cols = e.props.bodyColumns
    const ctx: ViewCtx = { e: e as RenderInput, t, u, cols, now: NOW, bodyRows: e.props.scroll.bodyRows, look: 'rich', site: 'sweep' }
    try {
      return <Box flexDirection="column">{state.build?.(ctx, $) ?? null}</Box>
    } catch (err) {
      state.failed.push(`${cols}: ${err instanceof Error ? err.message : String(err)}`)
      return <Text>failed</Text>
    }
  })
  state.failed = []
  return state
}

export const PANE = (columns: number, bodyRows = 40) =>
  ({
    plugin: 'mission-control',
    component: 'Pane',
    requestId: 'sweep',
    surface: 'terminal',
    props: { title: 'sweep', isFocused: false, bodyColumns: columns, placement: 'dock', scroll: { offset: 0, bodyRows }, view: {} },
  }) as const

/** The screen rows of `name` at `cols`, or the failures. */
export async function draw($: Engine, name: string, cols: number): Promise<string[]> {
  state.build = BUILDS[name]
  const ui = await $.ui.mount(PANE(cols) as never)
  const rows = screen(await ui.drawn())
  await ui.unmount()
  return rows
}

for (const name of Object.keys(BUILDS)) {
  test(`${name}: every rich deck, view and page mounts at 22 to 62 columns without refusal`, async ($, on) => {
    const s = sweeps(on)
    const bad: string[] = []
    for (let cols = 22; cols <= 62; cols++) {
      s.failed = []
      const rows = await draw($, name, cols)
      if (s.failed.length > 0) bad.push(`${name} @ ${s.failed.join('; ')}`)
      else if (rows.some(r => /This tab failed|^Failed: /.test(r.trim()))) bad.push(`${name} @ ${cols}: refused`)
    }
    expect(bad).toEqual([])
  })
}
