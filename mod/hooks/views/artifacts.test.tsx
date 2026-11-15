import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { ArtifactRow, Step, Timeline, UiState } from '../../types'
import { empty } from '../model/reduce'

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
const NOW = 1_000_000
const SHAPES: Record<string, string> = { timeline: 'timeline-4', ui: 'ui-3' }

type Stored = Map<string, unknown>

// The engine's $.state beneath the mod: seeded with a timeline, remembering
// every write so a press can be read back.
function world(on: On, t: Timeline, u?: UiState): { stored: Stored; clock: MockClock } {
  const stored: Stored = new Map()
  stored.set('timeline', t)
  if (u) stored.set('ui', u)
  const versions = new Map<string, number>()
  const clock = mock.clock(on, { now: NOW })
  on('ui.log', () => ({ value: undefined }))
  on('state.get', (_, e) => {
    const key = (e as { key: string }).key
    const v = stored.get(key)
    return {
      value: {
        value: v === undefined ? undefined : { shape: SHAPES[key], value: v },
        version: versions.get(key) ?? 0,
      },
    }
  })
  on('state.set', (_, e) => {
    const w = e as unknown as { key: string; value: { value: unknown } }
    const version = (versions.get(w.key) ?? 0) + 1
    versions.set(w.key, version)
    stored.set(w.key, w.value.value)
    return { value: { isSet: true as const, version } }
  })
  return { stored, clock }
}

const seed = (on: On, t: Timeline, u?: UiState): Stored => world(on, t, u).stored

const PANE = (columns: number) =>
  ({
    plugin: 'mission-control',
    component: 'Pane',
    requestId: 'mission-control',
    props: {
      title: 'Mission Control',
      isFocused: false,
      bodyColumns: columns,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  }) as const

const step = (id: string, seq: number, label: string): Step => ({
  id,
  seq,
  agent: 'main',
  tool: 'Write',
  label,
  status: 'done',
  startedAt: NOW - 5000,
})
const art = (kind: ArtifactRow['kind'], title: string, extra: Partial<ArtifactRow> = {}): ArtifactRow => ({
  id: `${kind}:${title}`,
  kind,
  title,
  agent: 'main',
  count: 1,
  updatedAt: NOW - 60_000,
  ...extra,
})
const tl = (artifacts: ArtifactRow[], extra: Partial<Timeline> = {}): Timeline => ({ ...empty, artifacts, ...extra })
const ART_UI: UiState = {
  tab: 'artifacts', filter: { kind: 'all' }, agentsMode: 'list', folded: [], openTurns: [],
  dismissed: [], query: '', runningOnly: false, notified: [], toasted: [],
}

async function mount($: Engine, surface: (typeof SURFACES)[number], columns = 62) {
  return $.ui.mount({ ...PANE(columns), surface })
}

const textOf = async (ui: Awaited<ReturnType<typeof mount>>, key: string): Promise<string> =>
  (await ui.find({ key }))?.text ?? ''

test('lists a page, a document, a result and a link with their glyphs', async ($, on) => {
  seed(
    on,
    tl(
      [
        art('page', 'Rate limit design', { ref: 'claude.ai/artifact/x', updatedAt: NOW - 540_000 }),
        art('document', 'docs/plan.md', {
          ref: 'docs/plan.md',
          summary: 'Implementation plan',
          stepId: 's1',
          updatedAt: NOW - 720_000,
        }),
        art('result', 'Review findings', { summary: 'from workflow review', updatedAt: NOW - 240_000 }),
        art('link', 'PR #41', { ref: 'github.com/x/pull/41', updatedAt: NOW - 1000 }),
      ],
      { steps: [step('s1', 1, 'Write docs/plan.md')] },
    ),
    ART_UI,
  )
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const page = await textOf(ui, 'art-page:Rate limit design')
    expect(page).toContain('↗')
    expect(page).toContain('Rate limit design')
    expect(page).toContain('page · 9m')
    expect(page).toContain('claude.ai/artifact/x')
    const doc = await textOf(ui, 'art-document:docs/plan.md')
    expect(doc).toContain('▤')
    expect(doc).toContain('document · 12m')
    expect(doc).toContain('Implementation plan')
    expect(await textOf(ui, 'art-result:Review findings')).toContain('◆')
    expect(await textOf(ui, 'art-link:PR #41')).toContain('⎇')
    const keys = (await ui.findAll({ type: 'Button' }))
      .map(b => String(b.key))
      .filter(k => k.startsWith('art-'))
    expect(keys).toEqual(['art-link:PR #41', 'art-result:Review findings', 'art-page:Rate limit design', 'art-document:docs/plan.md'])
    await ui.unmount()
  }
})

test('a document written three times shows ×3', async ($, on) => {
  seed(on, tl([art('document', 'a.md', { ref: 'a.md', count: 3 })]), ART_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect(await textOf(ui, 'art-document:a.md')).toContain('a.md · ×3')
    await ui.unmount()
  }
})

test('pressing a document opens the step that wrote it', async ($, on) => {
  const stored = seed(
    on,
    tl([art('document', 'a.md', { ref: 'a.md', stepId: 's1' })], { steps: [step('s1', 1, 'Write a.md')] }),
    ART_UI,
  )
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    await ui.press({ key: 'art-document:a.md' })
    const u = stored.get('ui') as UiState
    expect(u.tab).toBe('timeline')
    expect(u.detail?.stepId).toBe('s1')
    await ui.unmount()
    stored.set('ui', ART_UI)
  }
})

test('pressing a link with no step copies its ref', async ($, on) => {
  seed(on, tl([art('link', 'PR #41', { ref: 'github.com/x/pull/41' }), art('result', 'Findings')]), ART_UI)
  const copies: { text: string; surface: string }[] = []
  const toasts: string[] = []
  let isCopied = true
  on('ui.copy', (_, e) => {
    const c = e as unknown as { text: string; surface: string }
    copies.push({ text: c.text, surface: c.surface })
    return isCopied
      ? { value: { isCopied: true as const } }
      : { value: { isCopied: false as const, reason: 'no-clipboard' as const } }
  })
  on('ui.toast', (_, e) => {
    toasts.push((e as unknown as { text: string }).text)
    return { value: undefined }
  })
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    isCopied = true
    await ui.press({ key: 'art-link:PR #41' })
    expect(copies[copies.length - 1]).toEqual({ text: 'github.com/x/pull/41', surface })
    expect(toasts[toasts.length - 1]).toBe('Copied.')
    await ui.press({ key: 'art-result:Findings' })
    expect(copies[copies.length - 1]?.text).toBe('Findings')
    isCopied = false
    await ui.press({ key: 'art-link:PR #41' })
    expect(toasts[toasts.length - 1]).toBe('Not copied: no-clipboard')
    await ui.unmount()
  }
})

test('a step no longer in the timeline falls back to copying', async ($, on) => {
  const stored = seed(on, tl([art('document', 'a.md', { ref: 'a.md', stepId: 'gone' })]), ART_UI)
  const copies: string[] = []
  on('ui.copy', (_, e) => {
    copies.push((e as unknown as { text: string }).text)
    return { value: { isCopied: true as const } }
  })
  on('ui.toast', () => ({ value: undefined }))
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    await ui.press({ key: 'art-document:a.md' })
    expect(copies[copies.length - 1]).toBe('a.md')
    expect((stored.get('ui') as UiState).tab).toBe('artifacts')
    await ui.unmount()
  }
})

test('the footer counts changed files', async ($, on) => {
  seed(on, tl([art('link', 'PR', { ref: 'x' })], { changed: ['a.ts', 'b.ts', 'c.ts', 'd.ts'] }), ART_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const all = (await ui.findAll({ type: 'Text' })).map(f => f.text ?? '').join('\n')
    const flat = all.replace(/\s+/g, ' ')
    expect(all).toContain('page')
    expect(all).toContain('link')
    expect(flat).toContain('Code edits are not listed here; they are steps in the Timeline (4 files changed).')
    await ui.unmount()
  }
})

test('a long path is cut from the left and fits 24 columns', async ($, on) => {
  const ref = 'src/very/long/folder/structure/for/the/rate/limiter.ts'
  seed(on, tl([art('document', ref, { ref, count: 2 })]), ART_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface, 24)
    const lines = (await textOf(ui, `art-document:${ref}`)).split('\n')
    expect(lines.length).toBe(2)
    for (const line of lines) expect(line.length <= 24).toBe(true)
    expect(lines[1]).toContain('…')
    expect(lines[1]).toContain('limiter.ts')
    expect(lines[1]).toContain('· ×2')
    await ui.unmount()
  }
})

test('empty state', async ($, on) => {
  seed(on, empty, ART_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const all = (await ui.findAll({ type: 'Text' })).map(f => f.text ?? '').join('\n')
    expect(all.replace(/\s+/g, ' ')).toContain(
      'No artifacts yet. Pages Claude publishes, documents it writes and results it reports are listed here.',
    )
    expect(await ui.find({ key: 'tab-artifacts' })).toBeDefined()
    await ui.unmount()
  }
})

test('keys are the artifact id: rewriting one document keeps the keys of both that shared a step', async ($, on) => {
  const a = (extra: Partial<ArtifactRow> = {}): ArtifactRow =>
    art('document', 'a.md', { id: 'doc:a.md', ref: 'a.md', stepId: 's1', ...extra })
  const b = (extra: Partial<ArtifactRow> = {}): ArtifactRow =>
    art('document', 'b.md', { id: 'doc:b.md', ref: 'b.md', stepId: 's1', updatedAt: NOW - 90_000, ...extra })
  const steps = [step('s1', 1, 'Write a.md and b.md'), step('s7', 7, 'Write a.md')]
  const stored = seed(on, tl([a(), b()], { steps }), ART_UI)
  const keysOf = async (ui: Awaited<ReturnType<typeof mount>>): Promise<string[]> =>
    (await ui.findAll({ type: 'Button' })).map(x => String(x.key)).filter(k => k.startsWith('art-')).sort()
  for (const surface of SURFACES) {
    stored.set('timeline', tl([a(), b()], { steps }))
    const before = await mount($, surface)
    const keysBefore = await keysOf(before)
    await before.unmount()
    // The reducer rewrote a.md in step s7: the count and the stepId move, the id does not.
    stored.set('timeline', tl([a({ stepId: 's7', count: 2, updatedAt: NOW - 1000 }), b()], { steps }))
    const after = await mount($, surface)
    const keysAfter = await keysOf(after)
    await after.unmount()
    expect(keysBefore).toEqual(['art-doc:a.md', 'art-doc:b.md'])
    expect(keysAfter).toEqual(keysBefore)
  }
})

test('narrow: every line of every Text within 24', async ($, on) => {
  const long = 'src/very/long/folder/structure/for/the/rate/limiter.ts'
  const full = tl(
    [
      art('page', 'A page with a title that is far too long', { ref: 'claude.ai/artifact/abcdef0123456789', stepId: 's1' }),
      art('document', long, { ref: long, count: 12, summary: 'A summary that is also far too long to fit' }),
      art('result', 'Review findings', { summary: 'from workflow review' }),
      art('link', 'PR #41', { ref: 'github.com/x/pull/41' }),
    ],
    { steps: [step('s1', 1, 'Publish')], changed: ['a.ts', 'b.ts'] },
  )
  const stored = seed(on, full, ART_UI)
  for (const timeline of [full, empty]) {
    stored.set('timeline', timeline)
    for (const surface of SURFACES) {
      const ui = await mount($, surface, 24)
      const found = await ui.findAll({ type: 'Text' })
      expect(found.length >= 1).toBe(true)
      for (const f of found) for (const line of (f.text ?? '').split('\n')) expect(line.length <= 24).toBe(true)
      await ui.unmount()
    }
  }
})
