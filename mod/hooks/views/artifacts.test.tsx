import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { ArtifactRow, Step, Timeline, UiState } from '../../types'
import { empty } from '../model/reduce'
import { colOf, screen } from './screen.testkit'

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
const NOW = 1_000_000
const SHAPES: Record<string, string> = { timeline: 'timeline-4', ui: 'ui-4' }

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

const PANE = (columns: number, isFocused = false) =>
  ({
    plugin: 'mission-control',
    component: 'Pane',
    requestId: 'mission-control',
    props: {
      title: 'Mission Control',
      isFocused,
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
  dismissed: [], query: '', runningOnly: false, notified: [], toasted: [], slim: false,
}

async function mount($: Engine, surface: (typeof SURFACES)[number], columns = 62, isFocused = false) {
  return $.ui.mount({ ...PANE(columns, isFocused), surface })
}

type Mounted = Awaited<ReturnType<typeof mount>>
const drawnRows = async (ui: Mounted): Promise<string[]> => screen(await ui.drawn())
const rowWith = (rows: string[], text: string): string => rows.find(r => r.includes(text)) ?? ''
const artButtons = async (ui: Mounted): Promise<string[]> =>
  (await ui.findAll({ type: 'Button' })).map(b => String(b.key)).filter(k => k.startsWith('art-'))

const FOUR = tl(
  [
    art('page', 'Rate limit design', { ref: 'claude.ai/artifact/x', stepId: 's9', updatedAt: NOW - 540_000 }),
    art('document', 'docs/plan.md', { ref: 'docs/plan.md', summary: 'Implementation plan', stepId: 's1', updatedAt: NOW - 720_000 }),
    art('result', 'Review findings', { summary: 'from workflow review', updatedAt: NOW - 240_000 }),
    art('link', 'PR #41', { ref: 'github.com/x/pull/41', updatedAt: NOW - 1000 }),
  ],
  { steps: [step('s1', 1, 'Write docs/plan.md'), step('s9', 9, 'Publish the page')] },
)

test('rows are newest first: glyph at 2, title at 4, the kind at 38 and the age at 50', async ($, on) => {
  seed(on, FOUR, { ...ART_UI, artifactOpen: '' })
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect(await artButtons(ui)).toEqual(['art-link:PR #41', 'art-result:Review findings', 'art-page:Rate limit design', 'art-document:docs/plan.md'])
    const rows = await drawnRows(ui)
    const page = rowWith(rows, 'Rate limit design')
    expect([colOf(page, '↗'), colOf(page, 'Rate limit design'), colOf(page, 'page'), colOf(page, '9m')]).toEqual([2, 4, 38, 50])
    const doc = rowWith(rows, 'docs/plan.md')
    expect([colOf(doc, '▤'), doc.slice(38, 41), colOf(doc, '12m')]).toEqual([2, 'doc', 50])
    expect(colOf(rowWith(rows, 'Review findings'), '◆')).toBe(2)
    expect(colOf(rowWith(rows, 'PR #41'), '⎇')).toBe(2)
    const head = rowWith(rows, '┌ ARTIFACTS')
    expect([colOf(head, 'kind'), colOf(head, 'age')]).toEqual([38, 50])
    await ui.unmount()
  }
})

test('kinds keep their colours: page and link in the accent, document merged, result success', async ($, on) => {
  seed(on, FOUR, { ...ART_UI, artifactOpen: '' })
  const ui = await mount($, 'terminal')
  const found = await ui.findAll({ type: 'Text' })
  const color = (glyph: string): string | undefined => (found.find(f => f.text === glyph)?.props as { color?: string }).color
  expect([color('↗'), color('▤'), color('◆'), color('⎇')]).toEqual(['suggestion', 'merged', 'success', 'suggestion'])
  await ui.unmount()
})

test('a document written three times shows doc ×3 as its kind', async ($, on) => {
  seed(on, tl([art('document', 'a.md', { ref: 'a.md', count: 3 })]), ART_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const r = rowWith(await drawnRows(ui), 'a.md')
    expect(colOf(r, 'doc ×3')).toBe(38)
    await ui.unmount()
  }
})

test('the newest artifact is open by default: link and from at 6 and 14, then o: step  c: copy link  g: chat', async ($, on) => {
  seed(
    on,
    tl([art('page', 'Rate limit design', { ref: 'claude.ai/artifact/x', stepId: 's9' })], { steps: [step('s9', 9, 'Publish')] }),
    ART_UI,
  )
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const rows = await drawnRows(ui)
    const link = rowWith(rows, 'claude.ai/artifact/x')
    expect([colOf(link, 'link'), colOf(link, 'claude.ai/artifact/x')]).toEqual([6, 14])
    const from = rowWith(rows, 'from')
    expect(colOf(from, 'main · step 9 · ')).toBe(14)
    expect(rowWith(rows, 'o: step').trim()).toBe('o: step   c: copy link   g: chat')
    expect(colOf(rowWith(rows, 'o: step'), 'o: step')).toBe(6)
    await ui.unmount()
  }
})

test('pressing another row opens it and closes the first; pressing the open row closes it', async ($, on) => {
  const stored = seed(on, FOUR, ART_UI)
  const openOf = async (): Promise<string[]> => {
    const ui = await mount($, 'terminal')
    const rows = await drawnRows(ui)
    await ui.unmount()
    return ['claude.ai/artifact/x', 'github.com/x/pull/41', 'Implementation plan'].filter(x => rows.some(r => r.includes(x)))
  }
  // newest (the link) is open to start with
  expect(await openOf()).toEqual(['github.com/x/pull/41'])
  const a = await mount($, 'terminal')
  await a.press({ key: 'art-page:Rate limit design' })
  await a.unmount()
  expect((stored.get('ui') as UiState).artifactOpen).toBe('page:Rate limit design')
  expect(await openOf()).toEqual(['claude.ai/artifact/x'])
  const b = await mount($, 'terminal')
  await b.press({ key: 'art-page:Rate limit design' })
  await b.unmount()
  expect((stored.get('ui') as UiState).artifactOpen).toBe('')
  expect(await openOf()).toEqual([])
})

test('o opens the step that wrote the artifact', async ($, on) => {
  const stored = seed(
    on,
    tl([art('document', 'a.md', { ref: 'a.md', stepId: 's1' })], { steps: [step('s1', 1, 'Write a.md')] }),
    ART_UI,
  )
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    await ui.press({ key: 'act-o-document:a.md' })
    const u = stored.get('ui') as UiState
    expect(u.tab).toBe('timeline')
    // The step opens in place on the Steps tab, never as the full step.
    expect(u.stepOpen).toBe('s1')
    expect(u.detail).toBeUndefined()
    await ui.unmount()
    stored.set('ui', ART_UI)
  }
})

// A press runs the plugin's own $.ui.scroll; the mounted kit has nothing beneath
// it that answers, so the refusal toast is what shows the press reached it.
test('g reaches ui.scroll on a press only', async ($, on) => {
  seed(on, tl([art('document', 'a.md', { ref: 'a.md', stepId: 's1' })], { steps: [step('s1', 1, 'Write a.md')] }), ART_UI)
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push((e as unknown as { text: string }).text)
    return { value: undefined }
  })
  const ui = await mount($, 'terminal')
  expect(toasts).toEqual([])
  await ui.press({ key: 'act-g-document:a.md' })
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain('Not shown in chat')
  await ui.unmount()
})

test('c copies the link, or the title when there is no ref, and says when it failed', async ($, on) => {
  seed(on, tl([art('link', 'PR #41', { ref: 'github.com/x/pull/41' })]), ART_UI)
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
    await ui.press({ key: 'act-c-link:PR #41' })
    expect(copies[copies.length - 1]).toEqual({ text: 'github.com/x/pull/41', surface })
    expect(toasts[toasts.length - 1]).toBe('Copied.')
    isCopied = false
    await ui.press({ key: 'act-c-link:PR #41' })
    expect(toasts[toasts.length - 1]).toBe('Not copied: no-clipboard')
    await ui.unmount()
  }
})

test('c copies the title when the artifact has no ref', async ($, on) => {
  seed(on, tl([art('result', 'Findings')]), ART_UI)
  const copies: string[] = []
  on('ui.copy', (_, e) => {
    copies.push((e as unknown as { text: string }).text)
    return { value: { isCopied: true as const } }
  })
  on('ui.toast', () => ({ value: undefined }))
  const bare = await mount($, 'terminal')
  expect(rowWith(await drawnRows(bare), 'c: copy').trim()).toBe('c: copy')
  await bare.press({ key: 'act-c-result:Findings' })
  expect(copies).toEqual(['Findings'])
  await bare.unmount()
})

test('a step no longer in the timeline leaves only c: no o and no g', async ($, on) => {
  seed(on, tl([art('document', 'a.md', { ref: 'a.md', stepId: 'gone' })]), ART_UI)
  const ui = await mount($, 'terminal')
  const rows = await drawnRows(ui)
  expect(rowWith(rows, 'c: copy link').trim()).toBe('c: copy link')
  expect(rows.some(r => r.includes('o: step') || r.includes('g: chat'))).toBe(false)
  expect(rowWith(rows, 'from')).not.toContain('step')
  await ui.unmount()
})

test('FILES CHANGED shows the newest 3 and a more line', async ($, on) => {
  seed(on, tl([art('link', 'PR', { ref: 'x' })], { changed: ['mod/a.ts', 'mod/views/b.ts', 'c.ts', 'mod/views/d.ts'] }), ART_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const rows = await drawnRows(ui)
    const at = rows.findIndex(r => r.startsWith('┌ FILES CHANGED'))
    expect(at).toBeGreaterThan(-1)
    expect(rows.slice(at + 1, at + 4).map(r => r.slice(2, 3))).toEqual(['·', '·', '·'])
    expect(rows.slice(at + 1, at + 4).map(r => r.slice(4).trimEnd())).toEqual(['…/d.ts', 'c.ts', '…/b.ts'])
    expect(rows[at + 4]).toBe('  + 1 more')
    await ui.unmount()
  }
})

test('HANDOFF: Export digest with its note, and a press exports', async ($, on) => {
  seed(on, { ...tl([art('link', 'PR', { ref: 'x' })]), journal: 'sess1' }, ART_UI)
  mock.env(on, { USERPROFILE: 'C:/Users/x', OS: 'Windows_NT' })
  const writes: string[] = []
  on('fs.read', () => {
    throw new Error('ENOENT')
  })
  on('fs.write', (_, e) => {
    writes.push(e.path.split(String.fromCharCode(92)).join('/'))
    return { value: undefined }
  })
  on('ui.copy', () => ({ value: { isCopied: true as const } }))
  on('ui.toast', () => ({ value: undefined }))
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const rows = await drawnRows(ui)
    const at = rows.findIndex(r => r.startsWith('┌ HANDOFF'))
    expect(at).toBeGreaterThan(-1)
    const head = rows[at] ?? ''
    expect(colOf(head, 'to')).toBe(38)
    const ex = rows[at + 1] ?? ''
    expect([colOf(ex, '↥'), colOf(ex, 'Export digest'), colOf(ex, 'journal')]).toEqual([2, 4, 38])
    expect(rows[at + 2]).toBe('    kept ★ steps go in with full input and result')
    writes.length = 0
    await ui.press({ key: 'handoff-export' })
    expect(writes.length).toBe(1)
    expect(writes[0]).toMatch(/\/sess1\/export-.*\.md$/)
    await ui.unmount()
  }
})

test('e exports from the footer, which shows 3 entries and only while focused', async ($, on) => {
  seed(on, { ...tl([art('link', 'PR', { ref: 'x' })]), journal: 'sess1' }, ART_UI)
  mock.env(on, { USERPROFILE: 'C:/Users/x', OS: 'Windows_NT' })
  const writes: string[] = []
  on('fs.read', () => {
    throw new Error('ENOENT')
  })
  on('fs.write', (_, e) => {
    writes.push(e.path)
    return { value: undefined }
  })
  on('ui.copy', () => ({ value: { isCopied: true as const } }))
  on('ui.toast', () => ({ value: undefined }))
  const quiet = await mount($, 'terminal', 62, false)
  expect((await drawnRows(quiet)).some(r => r.includes('e: export'))).toBe(false)
  await quiet.unmount()
  const ui = await mount($, 'terminal', 62, true)
  expect(rowWith(await drawnRows(ui), 'e: export').trim()).toBe('↵ open   e: export   esc prompt')
  await ui.press({ key: 'hint-e' })
  expect(writes.length).toBe(1)
  await ui.unmount()
})

test('a long path is cut from the left in the link line and fits 32 columns', async ($, on) => {
  const ref = 'src/very/long/folder/structure/for/the/rate/limiter.ts'
  seed(on, tl([art('document', ref, { ref, count: 2 })]), ART_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface, 32)
    const rows = await drawnRows(ui)
    const link = rowWith(rows, 'link')
    expect(link.length <= 32).toBe(true)
    expect(link).toContain('…')
    expect(link.endsWith('limiter.ts')).toBe(true)
    await ui.unmount()
  }
})

test('more than 6 artifacts show 6 rows and a more line', async ($, on) => {
  const many = [1, 2, 3, 4, 5, 6, 7, 8].map(n => art('link', `L${n}`, { ref: `r${n}`, updatedAt: NOW - n * 1000 }))
  seed(on, tl(many), { ...ART_UI, artifactOpen: '' })
  const ui = await mount($, 'terminal')
  expect(await artButtons(ui)).toHaveLength(6)
  expect((await drawnRows(ui)).some(r => r === '  + 2 more')).toBe(true)
  await ui.unmount()
})

test('empty state', async ($, on) => {
  seed(on, empty, ART_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const all = (await drawnRows(ui)).join(' ').replace(/\s+/g, ' ')
    expect(all).toContain('No artifacts yet. Pages Claude publishes, documents it writes and results it reports are listed here.')
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
  for (const surface of SURFACES) {
    stored.set('timeline', tl([a(), b()], { steps }))
    const before = await mount($, surface)
    const keysBefore = (await artButtons(before)).sort()
    await before.unmount()
    // The reducer rewrote a.md in step s7: the count and the stepId move, the id does not.
    stored.set('timeline', tl([a({ stepId: 's7', count: 2, updatedAt: NOW - 1000 }), b()], { steps }))
    const after = await mount($, surface)
    const keysAfter = (await artButtons(after)).sort()
    await after.unmount()
    expect(keysBefore).toEqual(['art-doc:a.md', 'art-doc:b.md'])
    expect(keysAfter).toEqual(keysBefore)
  }
})

test('no row longer than the pane on any surface at 62, 40 and 32, full and empty', async ($, on) => {
  const long = 'src/very/long/folder/structure/for/the/rate/limiter.ts'
  const full = tl(
    [
      art('page', 'A page with a title that is far too long', { ref: 'claude.ai/artifact/abcdef0123456789', stepId: 's1' }),
      art('document', long, { ref: long, count: 12, summary: 'A summary that is also far too long to fit' }),
      art('result', 'Review findings', { summary: 'from workflow review' }),
      art('link', 'PR #41', { ref: 'github.com/x/pull/41' }),
    ],
    { steps: [step('s1', 1, 'Publish')], changed: ['a.ts', 'b.ts', 'src/very/long/folder/structure/for/the/rate/limiter.ts', 'd.ts', 'e.ts'] },
  )
  const stored = seed(on, full, { ...ART_UI, artifactOpen: 'document:' + long })
  for (const timeline of [full, empty]) {
    stored.set('timeline', timeline)
    for (const surface of SURFACES) {
      for (const columns of [62, 40, 32]) {
        const ui = await mount($, surface, columns, true)
        for (const r of await drawnRows(ui)) expect([surface, columns, r, r.length <= columns]).toEqual([surface, columns, r, true])
        await ui.unmount()
      }
    }
  }
})

test('focused, every row of Artifacts, footer included, fits 32 and 40 columns', async ($, on) => {
  seed(on, FOUR, ART_UI)
  for (const columns of [32, 40]) {
    for (const surface of SURFACES) {
      const ui = await mount($, surface, columns, true)
      const rows = await drawnRows(ui)
      expect(rows.some(r => r.includes('o: ') || r.includes('c: '))).toBe(true)
      for (const r of rows) expect(r.length <= columns).toBe(true)
      await ui.unmount()
    }
  }
})
