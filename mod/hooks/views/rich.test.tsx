import { expect, mock, test } from 'claude-code/testing'
import type { MockClock } from 'claude-code/testing'
import type { EngineInterface, On, RenderElement, RenderInput } from 'claude-code'

import type { AgentRow, Timeline, UiState } from '../../types'
import { empty } from '../model/reduce'
import { initialUi } from '../state'
import { absolute, fileHref } from './editor'
import { deck, hero, inst, page } from './parts'
import { Grid, ring } from './raster'
import { screen } from './screen.testkit'
import type { ViewCtx } from './shell'
import { DECK, lookOf, spriteOf } from './style'

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
const NOW = 1_000_000
const SHAPES: Record<string, string> = { timeline: 'timeline-4', ui: 'ui-4' }

// ---------- drawn alone, by the test's own ui.render hook ----------

function draws(on: On, build: (ctx: ViewCtx, $: EngineInterface) => RenderElement | null): void {
  mock.clock(on, { now: NOW })
  on('ui.log', () => ({ value: undefined }))
  on('state.get', () => ({ value: { value: undefined, version: 0 } }))
  on('ui.render', { component: 'Pane', requestId: 'rich-test' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    const cols = e.component === 'Pane' ? e.props.bodyColumns : 62
    const ctx: ViewCtx = {
      e: e as RenderInput, t: empty, u: initialUi, cols, now: NOW, isFocused: true,
      look: lookOf($.ui.resolve(e)), site: 'rich-test',
    }
    return <Box flexDirection="column">{build(ctx, $)}</Box>
  })
}

const PANE = (requestId: string, columns: number, bodyRows = 40) =>
  ({
    plugin: 'mission-control',
    component: 'Pane',
    requestId,
    props: { title: 'Mission Control', isFocused: true, bodyColumns: columns, placement: 'dock', scroll: { offset: 0, bodyRows }, view: {} },
  }) as const

type Node = { type?: unknown; props?: Record<string, unknown>; children?: unknown }
const kids = (n: Node): Node[] => {
  const c = n.children ?? n.props?.children
  if (c === undefined || c === null) return []
  return (Array.isArray(c) ? c : [c]).flat(Infinity as 1) as Node[]
}
function walk(n: unknown, visit: (n: Node, inButton: boolean) => void, inButton = false): void {
  if (n === null || typeof n !== 'object') return
  if (Array.isArray(n)) {
    for (const k of n) walk(k, visit, inButton)
    return
  }
  const node = n as Node
  visit(node, inButton)
  for (const k of kids(node)) walk(k, visit, inButton || node.type === 'Button')
}
const count = (tree: unknown, type: string): number => {
  let n = 0
  walk(tree, x => {
    if (x.type === type) n += 1
  })
  return n
}
const rasterInButton = (tree: unknown): boolean => {
  let bad = false
  walk(tree, (x, inButton) => {
    if (x.type === 'Raster' && inButton) bad = true
  })
  return bad
}

const lead: AgentRow = { ...empty.agents.main!, status: 'running' }

test('inst: a Raster on the terminal, its same-size text fallback on every other surface', async ($, on) => {
  draws(on, (ctx, $) => inst(ctx, $, { key: 'who', ...spriteOf(lead, NOW, 'waiting') }))
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE('rich-test', 62), surface })
    const drawn = await ui.drawn()
    const box = await ui.find({ type: 'Box', key: 'inst-who' })
    expect(box?.props.width).toBe(9)
    if (surface === 'terminal') {
      const r = await ui.find({ type: 'Raster', key: 'who' })
      expect(r?.props.columns).toBe(9)
      expect(r?.props.rows).toBe(4)
      expect(box?.props.height).toBe(4)
    } else {
      expect(count(drawn, 'Raster')).toBe(0)
      const rows = screen(drawn)
      expect(rows).toHaveLength(4)
      expect(rows[0]).toBe('◈?')
    }
    await ui.unmount()
  }
})

test('inst: the text look draws the fallback on the terminal too; a fallback row is padded or cut to the width', async ($, on) => {
  draws(on, (ctx, $) =>
    inst({ ...ctx, look: 'text' }, $, {
      key: 'dial', columns: 7, rows: 2, sig: 'd', frames: () => [ring('CTX', 9)],
      fallback: [[{ text: 'CTX 9% and far too long' }]],
    }),
  )
  const ui = await $.ui.mount({ ...PANE('rich-test', 62), surface: 'terminal' })
  const drawn = await ui.drawn()
  expect(count(drawn, 'Raster')).toBe(0)
  const rows = screen(drawn)
  // BEHAVIOUR CHANGE (binding rule 1): a too-long fallback row was cut at the 7th character; it is now cut on a word, with …
  expect(rows).toEqual(['CTX 9%…', ''])
  await ui.unmount()
})

test('inst: frames of the wrong size are refused, not drawn', async ($, on) => {
  let err = ''
  draws(on, (ctx, $) => {
    try {
      return inst(ctx, $, { key: 'bad', columns: 9, rows: 4, sig: 'bad', frames: () => [ring('CTX', 9)], fallback: [] })
    } catch (e) {
      err = String(e)
      return null
    }
  })
  const ui = await $.ui.mount({ ...PANE('rich-test', 62), surface: 'terminal' })
  expect(err).toContain('7x4, not 9x4')
  await ui.unmount()
})

test('hero: the character at 2, lines at 14, the rings at 39 when 62 columns hold them, dropped below', async ($, on) => {
  const rings = { key: 'rings', columns: 23, rows: 4, sig: 'r', frames: () => [new Grid(23, 4)], fallback: [[{ text: 'CTX 9%' }]] }
  draws(on, (ctx, $) =>
    hero(ctx, $, {
      key: 'hero',
      who: { key: 'lead', ...spriteOf(lead, NOW) },
      lines: [
        { runs: 'Wiring the limiter into the middleware chain, before the auth step', lines: 2 },
        { key: 'hero-step', runs: [{ text: '▸', color: 'suggestion' }, { text: ' Edit rateLimit.ts' }], onPress: () => {} },
      ],
      right: rings,
    }),
  )
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE('rich-test', 62), surface })
    const drawn = await ui.drawn()
    expect(rasterInButton(drawn)).toBe(false)
    const rows = screen(drawn)
    expect(rows[0]!.indexOf('Wiring')).toBe(14)
    expect(rows[2]!.indexOf('▸ Edit')).toBe(14)
    for (const r of rows) expect(r.length).toBeLessThanOrEqual(62)
    if (surface !== 'terminal') expect(rows[0]!.indexOf('CTX 9%')).toBe(39)
    else expect(await ui.find({ type: 'Raster', key: 'rings' })).toBeTruthy()
    await ui.unmount()
    const narrow = await $.ui.mount({ ...PANE('rich-test', 50), surface })
    expect(screen(await narrow.drawn()).join('\n')).not.toContain('CTX 9%')
    expect(await narrow.find({ type: 'Raster', key: 'rings' })).toBe(undefined)
    await narrow.unmount()
  }
})

const LONG = 'Write tests for the upload rate limiter: the 429 path, the reset header and the burst of eleven requests. Use the staging bucket, never production, and say which callers skip auth before changing anything at all.'
const PATH = 'C:/Users/someone/projects/a-very-long-project-name/src/middleware/rate-limit/token-bucket-keyed-by-api-key.ts'

test('page never ends a line in … and wraps long text in full, at 62 and 40 columns on every surface', async ($, on) => {
  draws(on, (ctx, $) =>
    page(ctx, $, {
      key: 'p',
      frame: { pill: 'WORKING', right: 'agent 3 of 6' },
      title: 'write rate limit tests for the upload handler and every one of its callers',
      body: LONG,
      fields: [
        { label: 'AGENT', value: 'general-purpose', cells: [{ col: DECK.value, runs: 'build' }, { col: DECK.aside, runs: 'sonnet 5' }] },
        { label: 'REF', value: PATH },
      ],
      blocks: [{ key: 'result', label: 'RESULT', text: LONG }],
      actions: [{ hotkey: 'g', label: 'chat', key: 'p-g', onPress: () => {} }, { hotkey: 'v', label: 'transcript', key: 'p-v', onPress: () => {} }],
    }),
  )
  const words = (s: string) => s.replace(/\s+/g, ' ').trim()
  for (const cols of [62, 40]) {
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE('rich-test', cols), surface })
      const drawn = await ui.drawn()
      const rows = screen(drawn)
      for (const r of rows) {
        expect(r.endsWith('…')).toBe(false)
        expect(r.length).toBeLessThanOrEqual(cols)
      }
      const all = words(rows.join(' '))
      expect(all).toContain(words(LONG).slice(-40))
      expect(rows.map(r => r.trim()).join('')).toContain(PATH)
      expect(all).toContain('every one of its callers')
      expect(await ui.find({ type: 'Button', key: 'page-back' })).toBeTruthy()
      expect(rasterInButton(drawn)).toBe(false)
      if (surface !== 'terminal') expect(count(drawn, 'Raster')).toBe(0)
      await ui.unmount()
    }
  }
})

test('absolute and fileHref: relative paths join the root with its separator; the href is a vscode://file URL', async () => {
  expect(absolute('src/a.ts', 'C:\\repo')).toBe('C:\\repo\\src\\a.ts')
  expect(absolute('./src/a.ts', '/home/x/repo')).toBe('/home/x/repo/src/a.ts')
  expect(absolute('D:\\b.ts', 'C:\\repo')).toBe('D:\\b.ts')
  expect(absolute('/etc/hosts', 'C:\\repo')).toBe('/etc/hosts')
  expect(fileHref('C:\\repo\\a b.ts', 12)).toBe('vscode://file/C:/repo/a%20b.ts:12')
  expect(fileHref('/home/x/a.ts')).toBe('vscode://file/home/x/a.ts')
})

// ---------- the pane: page routing, b, the editor option, forget on close ----------

type Stored = Map<string, unknown>
function world(on: On, t: Timeline, u: UiState): { stored: Stored; clock: MockClock } {
  const stored: Stored = new Map()
  stored.set('timeline', t)
  stored.set('ui', u)
  const versions = new Map<string, number>()
  const clock = mock.clock(on, { now: NOW })
  on('ui.log', () => ({ value: undefined }))
  on('state.get', (_, e) => {
    const key = (e as { key: string }).key
    const v = stored.get(key)
    return { value: { value: v === undefined ? undefined : { shape: SHAPES[key], value: v }, version: versions.get(key) ?? 0 } }
  })
  on('state.set', (_, e) => {
    const w = e as unknown as { key: string; value: { value: unknown } }
    const version = (versions.get(w.key) ?? 0) + 1
    versions.set(w.key, version)
    stored.set(w.key, w.value.value)
    return { value: { isSet: true as const, version } }
  })
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.close', () => ({ value: undefined }))
  return { stored, clock }
}

const T: Timeline = {
  ...empty,
  tasks: [{ id: '10', subject: 'Wire the limiter into the middleware chain, before the auth step', activeForm: 'Wiring the limiter', status: 'in_progress', owner: 'main', updatedAt: NOW }],
  agents: {
    ...empty.agents,
    a1: { id: 'a1', parent: 'main', type: 'general-purpose', description: 'write rate limit tests for the upload handler', status: 'running', startedAt: NOW - 60_000, doing: '', stepCount: 0 },
  },
  steps: [{ id: 's1', seq: 1, agent: 'main', tool: 'Edit', label: 'Edit rateLimit.ts', status: 'running', startedAt: NOW - 5000, pending: { file_path: 'src/rateLimit.ts' } }],
  artifacts: [{ id: 'art1', kind: 'document', title: 'Rate limit design: a token bucket for each API key', ref: 'docs/limit.md', agent: 'main', count: 1, updatedAt: NOW }],
}

const PAGES: [UiState['page'] & object, string][] = [
  [{ kind: 'task', id: 'main:10' }, 'Wire the limiter into the middleware chain'],
  [{ kind: 'agent', id: 'a1' }, 'write rate limit tests for the upload handler'],
  [{ kind: 'step', id: 's1' }, 'src/rateLimit.ts'],
  [{ kind: 'artifact', id: 'art1' }, 'Rate limit design: a token bucket for each API key'],
]

for (const [p, text] of PAGES) {
  test(`page routing: ui.page ${p.kind} draws its page in place of the tab; b clears it`, async ($, on) => {
    const { stored } = world(on, T, { ...initialUi, tab: 'overview', page: p })
    for (const surface of SURFACES) {
      stored.set('ui', { ...initialUi, tab: 'overview', page: p })
      const ui = await $.ui.mount({ ...PANE('mission-control', 62), surface })
      const rows = screen(await ui.drawn())
      expect(rows.join(' ').replace(/\s+/g, ' ')).toContain(text)
      expect(await ui.find({ type: 'Button', key: 'tab-overview' })).toBeTruthy()
      expect(await ui.find({ type: 'Button', key: 'page-back' })).toBeTruthy()
      await ui.press({ key: 'page-back' })
      expect((stored.get('ui') as UiState).page).toBe(undefined)
      await ui.unmount()
      const again = await $.ui.mount({ ...PANE('mission-control', 62), surface })
      expect(await again.find({ type: 'Button', key: 'page-back' })).toBe(undefined)
      // Now lists the current task in its To do block by design, so only the other pages' words are gone.
      if (p.kind !== 'task') expect(screen(await again.drawn()).join(' ').replace(/\s+/g, ' ')).not.toContain(text)
      await again.unmount()
    }
  })
}

test('a page of something gone says so; a page value of an unknown kind is ignored', async ($, on) => {
  const { stored } = world(on, T, { ...initialUi, page: { kind: 'agent', id: 'nope' } })
  const a = await $.ui.mount({ ...PANE('mission-control', 62), surface: 'terminal' })
  expect(screen(await a.drawn()).join(' ')).toContain('This agent is gone.')
  await a.unmount()
  stored.set('ui', { ...initialUi, page: { kind: 'weird', id: 'x' } })
  const b = await $.ui.mount({ ...PANE('mission-control', 62), surface: 'terminal' })
  expect(await b.find({ type: 'Button', key: 'page-back' })).toBe(undefined)
  await b.unmount()
})

test('a tab press and /mc 1-5 leave the page', async ($, on) => {
  const { stored } = world(on, T, { ...initialUi, page: { kind: 'task', id: 'main:10' } })
  const ui = await $.ui.mount({ ...PANE('mission-control', 62), surface: 'terminal' })
  await ui.press({ key: 'tab-agents' })
  expect((stored.get('ui') as UiState).page).toBe(undefined)
  expect((stored.get('ui') as UiState).tab).toBe('agents')
  await ui.unmount()
  stored.set('ui', { ...initialUi, page: { kind: 'task', id: 'main:10' } })
  await $.command.run({ command: 'mc', args: '2' } as never)
  expect((stored.get('ui') as UiState).page).toBe(undefined)
})

test('the pane on the terminal draws the page with Rasters; on desktop, VS Code and mobile none', async ($, on) => {
  world(on, T, { ...initialUi, page: { kind: 'agent', id: 'a1' } })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE('mission-control', 62), surface })
    const drawn = await ui.drawn()
    if (surface === 'terminal') expect(count(drawn, 'Raster')).toBeGreaterThan(0)
    else expect(count(drawn, 'Raster')).toBe(0)
    expect(rasterInButton(drawn)).toBe(false)
    await ui.unmount()
  }
})

// MEANING CHANGED (cockpit): pages hold no Raster (R22), so the pulsing critter this test watched is the working agent's card on Agents.
test('forget runs on the pane closing: its pulsing Rasters stop painting', async ($, on) => {
  const { clock } = world(on, T, { ...initialUi, tab: 'agents' })
  const blits: string[] = []
  on('ui.blit', (_, e) => {
    blits.push(e.key)
    return { value: {} }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.notify', () => ({ value: { isSent: true as const, channel: 'terminal' } }) as never)
  on('ui.invalidate', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'mc' } }))
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('session.root', () => ({ value: 'C:/repo' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE('mission-control', 62), surface: 'terminal' })
  await ui.drawn()
  // The working agent's character pulses: the clock blits it each beat.
  await clock.advance(1000)
  await clock.advance(1000)
  expect(blits).toContain('agent-a1-who')
  await $.command.run({ command: 'mc', args: 'close' } as never)
  const before = blits.length
  await clock.advance(1000)
  await clock.advance(1000)
  expect(blits.length).toBe(before)
  await ui.unmount()
})

// ---------- open in editor, through the artifact page's o ----------

const DOC_PAGE: UiState = { ...initialUi, page: { kind: 'artifact', id: 'art1' } }

function editorWorld(on: On, opts: { exit?: number; reject?: boolean; copied?: boolean; ref?: string } = {}) {
  const t: Timeline = opts.ref !== undefined ? { ...T, artifacts: [{ ...T.artifacts[0]!, ref: opts.ref }] } : T
  const { stored } = world(on, t, DOC_PAGE)
  const runs: string[][] = []
  const copies: { text: string; surface?: string }[] = []
  const toasts: string[] = []
  on('session.root', () => ({ value: 'C:/repo' }))
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    if (opts.reject === true) throw new Error('spawn ENOENT')
    return { value: { exitCode: opts.exit ?? 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.copy', (_, e) => {
    copies.push({ text: e.text, surface: e.surface })
    return opts.copied === false ? { value: { isCopied: false as const, reason: 'no-clipboard' as const } } : { value: { isCopied: true as const } }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  return { stored, runs, copies, toasts }
}

test('openInEditor runs the editor with -r -g path on the press only, the path made absolute', async ($, on) => {
  const w = editorWorld(on)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE('mission-control', 62), surface })
    await ui.drawn()
    expect(w.runs).toEqual([])
    await ui.unmount()
  }
  const ui = await $.ui.mount({ ...PANE('mission-control', 62), surface: 'terminal' })
  await ui.press({ key: 'artifact-page-open' })
  expect(w.runs).toEqual([['code', '-r', '-g', 'C:/repo/docs/limit.md']])
  expect(w.toasts).toEqual([])
  expect(w.copies).toEqual([])
  await ui.unmount()
})

test('openInEditor: a non-zero exit copies the path and toasts why', async ($, on) => {
  const w = editorWorld(on, { exit: 2 })
  const ui = await $.ui.mount({ ...PANE('mission-control', 62), surface: 'desktop' })
  await ui.press({ key: 'artifact-page-open' })
  expect(w.copies).toEqual([{ text: 'C:/repo/docs/limit.md', surface: 'desktop' }])
  expect(w.toasts).toEqual(['Not opened: code exited 2. Path copied.'])
  await ui.unmount()
})

test('openInEditor: an editor that cannot start is tried once through cmd, then the path is copied and the toast says why', async ($, on) => {
  const w = editorWorld(on, { reject: true, copied: false })
  const ui = await $.ui.mount({ ...PANE('mission-control', 62), surface: 'terminal' })
  await ui.press({ key: 'artifact-page-open' })
  expect(w.runs).toEqual([
    ['code', '-r', '-g', 'C:/repo/docs/limit.md'],
    ['cmd', '/d', '/c', 'code', '-r', '-g', 'C:/repo/docs/limit.md'],
  ])
  expect(w.copies).toHaveLength(1)
  expect(w.toasts).toHaveLength(1)
  expect(w.toasts[0]).toContain('Not opened: code did not start')
  expect(w.toasts[0]).toContain('C:/repo/docs/limit.md')
  await ui.unmount()
})

test('openInEditor never hands cmd a path with a metacharacter', async ($, on) => {
  const w = editorWorld(on, { reject: true, ref: 'a.md & calc' })
  const ui = await $.ui.mount({ ...PANE('mission-control', 62), surface: 'terminal' })
  await ui.press({ key: 'artifact-page-open' })
  expect(w.runs).toEqual([['code', '-r', '-g', 'C:/repo/a.md & calc']])
  expect(w.toasts).toHaveLength(1)
  await ui.unmount()
})

test('the editor option names the editor o: open runs', { options: { editor: 'cursor' } }, async ($, on) => {
  const w = editorWorld(on, { ref: 'D:/elsewhere/notes.md' })
  const ui = await $.ui.mount({ ...PANE('mission-control', 62), surface: 'terminal' })
  await ui.press({ key: 'artifact-page-open' })
  expect(w.runs).toEqual([['cursor', '-r', '-g', 'D:/elsewhere/notes.md']])
  await ui.unmount()
})
