import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { ArtifactRow, Step, Timeline, UiState } from '../../types'
import { empty } from '../model/reduce'
import { clock } from './fit'
import { backTo, colOf, keepLog, LOGS, screen } from './screen.testkit'

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
  LOGS.length = 0
  on('ui.log', keepLog)
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

// LOOK TEST (edited for Neo): the result glyph is ✦ (◆ is now a hull).
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
    expect(colOf(rowWith(rows, 'Review findings'), '✦')).toBe(2)
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
  expect([color('↗'), color('▤'), color('✦'), color('⎇')]).toEqual(['suggestion', 'merged', 'success', 'suggestion'])
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

// BEHAVIOUR CHANGE (rich rule 4): the action line drops `p: page`; Enter on the row opens the page.
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

// BEHAVIOUR CHANGE (rich rule 4): was "press again closes"
test('Enter on an artifact row opens its page; b returns to the list with the artifact row focused', async ($, on) => {
  const stored = seed(on, FOUR, ART_UI)
  for (const surface of SURFACES) {
    stored.set('ui', ART_UI)
    LOGS.length = 0
    const ui = await mount($, surface)
    await ui.press({ key: 'art-page:Rate limit design' })
    expect((stored.get('ui') as UiState).page).toEqual({ kind: 'artifact', id: 'page:Rate limit design', from: 'art-page:Rate limit design' })
    await ui.redraw()
    await ui.press({ key: 'page-back' })
    expect((stored.get('ui') as UiState).page).toBeUndefined()
    expect(backTo()).toEqual(['art-page:Rate limit design'])
    await ui.unmount()
  }
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

// BEHAVIOUR CHANGE (rich rule 4): the action line reads `c: copy` (no `p: page`).
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

// BEHAVIOUR CHANGE (rich rule 4): the action line reads `c: copy link` (no `p: page`).
test('a step no longer in the timeline leaves only c: no o and no g', async ($, on) => {
  seed(on, tl([art('document', 'a.md', { ref: 'a.md', stepId: 'gone' })]), ART_UI)
  const ui = await mount($, 'terminal')
  const rows = await drawnRows(ui)
  expect(rowWith(rows, 'c: copy link').trim()).toBe('c: copy link')
  expect(rows.some(r => r.includes('o: step') || r.includes('g: chat'))).toBe(false)
  expect(rowWith(rows, 'from')).not.toContain('step')
  await ui.unmount()
})

// LOOK TEST (rewritten for Rich): a changed file's glyph is ▪ (was ·); its name keeps column 4.
test('FILES CHANGED shows the newest 3 and a more line', async ($, on) => {
  seed(on, tl([art('link', 'PR', { ref: 'x' })], { changed: ['mod/a.ts', 'mod/views/b.ts', 'c.ts', 'mod/views/d.ts'] }), ART_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const rows = await drawnRows(ui)
    const at = rows.findIndex(r => r.startsWith('┌ FILES CHANGED'))
    expect(at).toBeGreaterThan(-1)
    expect(rows.slice(at + 1, at + 4).map(r => r.slice(2, 3))).toEqual(['▪', '▪', '▪'])
    expect(rows.slice(at + 1, at + 4).map(r => r.slice(4, 36).trimEnd())).toEqual(['…/d.ts', 'c.ts', '…/b.ts'])
    expect(rows[at + 4]).toBe('  + 1 more')
    await ui.unmount()
  }
})

const EXPORT_ENV = { USERPROFILE: 'C:/Users/x', OS: 'Windows_NT' }

function exportWorld(on: On): { writes: string[] } {
  mock.env(on, EXPORT_ENV)
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
  return { writes }
}

// LOOK TEST (rewritten for Rich, text form): the Neo deck of the surfaces without Rasters. HANDOFF stays its top row; DIGEST and its legend now sit between it and KEPT.
test('text form: the deck is HANDOFF, DIGEST, the legend and KEPT in one bracket; a press on HANDOFF exports', async ($, on) => {
  seed(on, { ...tl([art('link', 'PR', { ref: 'x' })]), journal: 'sess1' }, ART_UI)
  const { writes } = exportWorld(on)
  for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
    const ui = await mount($, surface)
    const rows = await drawnRows(ui)
    const at = rows.findIndex(r => r.includes('HANDOFF'))
    expect(at).toBeGreaterThan(-1)
    const ex = rows[at] ?? ''
    expect(ex.startsWith('┏ HANDOFF')).toBe(true)
    // the first press records an export, so later surfaces show its time in place of `not yet`
    expect([colOf(ex, '↥'), colOf(ex, 'Export digest'), colOf(ex, 'journal'), ex.slice(50, 51) === ' ' ? -1 : 50]).toEqual([14, 16, 38, 50])
    expect(ex.length).toBe(62)
    expect(ex.endsWith('┓')).toBe(true)
    expect(rows[at + 1]?.startsWith('┃ DIGEST')).toBe(true)
    expect(rows[at + 3]?.startsWith('┗ KEPT')).toBe(true)
    expect(rows.some(r => r.startsWith('┌ HANDOFF'))).toBe(false)
    writes.length = 0
    await ui.press({ key: 'handoff-export' })
    expect(writes.length).toBe(1)
    expect(writes[0]).toMatch(/\/sess1\/export-.*\.md$/)
    await ui.unmount()
  }
})

// LOOK TEST (new for Rich, rich form): the terminal's deck is a lintel Raster, the rows on the grid, a sill Raster; no rails.
test('rich form: a lintel, HANDOFF, DIGEST with its legend, KEPT and a sill; a press on HANDOFF exports', async ($, on) => {
  seed(on, { ...tl([art('link', 'PR', { ref: 'x' })]), journal: 'sess1' }, ART_UI)
  const { writes } = exportWorld(on)
  const ui = await mount($, 'terminal')
  const rows = await drawnRows(ui)
  const at = rows.findIndex(r => r.includes('HANDOFF'))
  expect(at).toBeGreaterThan(0)
  expect(rows[at - 1]).toBe('')
  const ex = rows[at] ?? ''
  expect([colOf(ex, 'HANDOFF'), colOf(ex, '↥'), colOf(ex, 'Export digest'), colOf(ex, 'journal'), colOf(ex, 'not yet')]).toEqual([2, 14, 16, 38, 50])
  expect(colOf(rows[at + 1] ?? '', 'DIGEST')).toBe(2)
  expect(colOf(rows[at + 2] ?? '', '▪ tasks')).toBe(14)
  expect([colOf(rows[at + 3] ?? '', 'KEPT'), colOf(rows[at + 3] ?? '', '★')]).toEqual([2, 14])
  const rasters = (await ui.findAll({ type: 'Raster' })).map(r => String(r.key))
  expect(rasters).toEqual(expect.arrayContaining(['artifacts-deck-lintel', 'digest', 'artifacts-deck-sill']))
  writes.length = 0
  await ui.press({ key: 'handoff-export' })
  expect(writes.length).toBe(1)
  await ui.unmount()
})

// LOOK TEST (rewritten for Rich): KEPT is the deck's last row, after DIGEST and the legend, then ARTIFACTS, then FILES CHANGED.
test('the KEPT row counts the kept steps; the deck comes first, then ARTIFACTS, then FILES CHANGED', async ($, on) => {
  const kept = { ...step('s1', 1, 'Write a.md'), pin: 'the plan' }
  seed(on, tl([art('link', 'PR', { ref: 'x' })], { steps: [kept, step('s2', 2, 'Write b.md')], changed: ['a.ts'] }), ART_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const rows = await drawnRows(ui)
    const at = rows.findIndex(r => r.includes('HANDOFF'))
    const k = rows.find(r => r.includes('KEPT')) ?? ''
    const kAt = rows.indexOf(k)
    expect(kAt).toBe(at + 3)
    expect([colOf(k, '★'), colOf(k, '1 step goes in full'), colOf(k, 'the rest in brief')]).toEqual([14, 16, 38])
    expect(k.length).toBe(surface === 'terminal' ? k.trimEnd().length : 62)
    if (surface !== 'terminal') expect(k.endsWith('┛')).toBe(true)
    const next = rows.findIndex((r, i) => i > kAt && r.includes('ARTIFACTS'))
    expect(next).toBeGreaterThan(kAt + 1)
    expect(rows[kAt + 1] === '' || rows[kAt + 2] === '').toBe(true)
    expect(rows.findIndex(r => r.includes('FILES CHANGED'))).toBeGreaterThan(next)
    await ui.unmount()
  }
})

test('KEPT with no kept steps says so', async ($, on) => {
  seed(on, tl([art('link', 'PR', { ref: 'x' })]), ART_UI)
  const none = await mount($, 'terminal')
  expect(rowWith(await drawnRows(none), 'KEPT')).toContain('none kept yet')
  await none.unmount()
})

test('KEPT with several kept steps uses the plural', async ($, on) => {
  const two = tl([art('link', 'PR', { ref: 'x' })], { steps: [{ ...step('s1', 1, 'a'), pin: '' }, { ...step('s2', 2, 'b'), pin: 'x' }] })
  seed(on, two, ART_UI)
  const ui = await mount($, 'terminal')
  expect(rowWith(await drawnRows(ui), 'KEPT')).toContain('2 steps go in full')
  await ui.unmount()
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

// ---------- Neo Rich: DIGEST, the last export, edit bars, open, the artifact page ----------

test('the deck shows the last export from lastExport: its time, or "not yet"', async ($, on) => {
  const exported = NOW - 3_600_000
  const stored = seed(on, tl([art('link', 'PR', { ref: 'x' })], { lastExport: { at: exported, path: 'C:/j/export.md' } }), ART_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const ex = rowWith(await drawnRows(ui), 'HANDOFF')
    expect(colOf(ex, clock(exported))).toBe(50)
    expect(ex).not.toContain('not yet')
    await ui.unmount()
  }
  stored.set('timeline', tl([art('link', 'PR', { ref: 'x' })]))
  const none = await mount($, 'terminal')
  expect(colOf(rowWith(await drawnRows(none), 'HANDOFF'), 'not yet')).toBe(50)
  await none.unmount()
})

test('DIGEST: a 22-cell stack Raster of the four parts, with its words and parts; text form a run of ▄', async ($, on) => {
  const kept = { ...step('s1', 1, 'Write a.md'), pin: 'the plan' }
  const steps = [kept, ...[2, 3, 4, 5].map(n => step(`s${n}`, n, `Read f${n}`))]
  const tasks = [1, 2].map(n => ({ id: String(n), subject: `task ${n}`, status: 'completed' as const, owner: 'main', updatedAt: NOW }))
  seed(on, tl([art('result', 'Findings', { summary: 's' })], { steps, tasks, changed: ['a.ts'] }), ART_UI)
  const ui = await mount($, 'terminal')
  const rows = await drawnRows(ui)
  const d = rowWith(rows, 'DIGEST')
  expect(d).toMatch(/~\d+ words/)
  expect(colOf(d, '4 parts')).toBe(50)
  expect(colOf(d, '~')).toBe(38)
  const raster = await ui.find({ type: 'Raster', key: 'digest' })
  expect(raster?.props).toMatchObject({ columns: 22, rows: 1 })
  expect(rowWith(rows, '▪ tasks')).toContain('▪ tasks  ▪ steps  ▪ kept  ▪ made')
  await ui.unmount()
  const text = await mount($, 'desktop')
  expect(rowWith(await drawnRows(text), 'DIGEST')).toMatch(/DIGEST {6}▄{22}/)
  await text.unmount()
})

test('DIGEST with nothing to hold is a rest line and 0 parts', async ($, on) => {
  seed(on, tl([]), ART_UI)
  const ui = await mount($, 'desktop')
  const d = rowWith(await drawnRows(ui), 'DIGEST')
  expect(d).toContain('─'.repeat(22))
  expect(d).toContain('0 parts')
  await ui.unmount()
})

// A world with an editor that records its runs.
function runWorld(on: On): { runs: string[][]; toasts: string[]; copies: string[] } {
  const copies: string[] = []
  const runs: string[][] = []
  const toasts: string[] = []
  on('session.root', () => ({ value: 'C:/repo' }))
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.copy', (_, e) => {
    copies.push(e.text)
    return { value: { isCopied: true as const } }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  return { runs, toasts, copies }
}

const edit = (id: string, seq: number, label: string, ago: number): Step => ({ ...step(id, seq, label), tool: 'Edit', startedAt: NOW - ago })

test('FILES CHANGED: each file has an edit bar sized by its edits, its count and its last edit', async ($, on) => {
  const steps = [edit('e1', 1, 'Edit src/up.ts', 600_000), edit('e2', 2, 'Edit src/up.ts', 300_000), edit('e3', 3, 'Edit src/rl.ts', 60_000), edit('e4', 4, 'Edit src/rl.ts', 30_000), edit('e5', 5, 'Edit src/rl.ts', 12_000)]
  seed(on, tl([art('link', 'PR', { ref: 'x' })], { steps, changed: ['src/up.ts', 'src/rl.ts'] }), ART_UI)
  const ui = await mount($, 'terminal')
  const rows = await drawnRows(ui)
  const rl = rowWith(rows, '/rl.ts')
  const up = rowWith(rows, '/up.ts')
  expect([colOf(rl, '3'), colOf(rl, '12s')]).toEqual([38, 50])
  expect([colOf(up, '2'), colOf(up, '5m')]).toEqual([38, 50])
  const bars = (await ui.findAll({ type: 'Raster' })).filter(r => String(r.key).startsWith('edits-'))
  expect(bars.map(b => b.props)).toEqual([expect.objectContaining({ columns: 6, rows: 1 }), expect.objectContaining({ columns: 6, rows: 1 })])
  await ui.unmount()
  const text = await mount($, 'mobile')
  const t = await drawnRows(text)
  expect(rowWith(t, '/rl.ts')).toContain('▮▮▮▮▮▮')
  expect(rowWith(t, '/up.ts')).toContain('▮▮▮▮▯▯')
  await text.unmount()
})

test('files changed: o calls openInEditor on a press only, for the file that was selected', async ($, on) => {
  seed(on, tl([art('link', 'PR', { ref: 'x' })], { changed: ['src/up.ts', 'src/rl.ts'] }), { ...ART_UI, artifactOpen: '' })
  const w = runWorld(on)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    await ui.drawn()
    expect(w.runs).toEqual([])
    await ui.unmount()
  }
  const ui = await mount($, 'terminal', 62, true)
  expect((await drawnRows(ui)).some(r => r.includes('o: open'))).toBe(false)
  await ui.press({ key: 'file-0' })
  expect(w.runs).toEqual([])
  expect((await drawnRows(ui)).some(r => r.includes('o: open   c: copy path'))).toBe(true)
  await ui.press({ key: 'act-o-file-0' })
  expect(w.runs).toEqual([['code', '-r', '-g', 'C:/repo/src/rl.ts']])
  await ui.unmount()
})

const LONG_TITLE = 'Rate limit design: a token bucket for each API key, with the burst case and the three callers that change'
const LONG_REF = 'C:/Users/aaron/Documents/GitHub/mission-control-claude-mod/docs/superpowers/plans/2026-11-15-a-very-long-plan-name.md'
const LONG_SUMMARY = 'Why the limiter moves before auth, how the bucket is keyed, what the 429 reply carries, and the three callers that change. Then the follow-up work.'
const PAGE_ART = art('document', LONG_TITLE, { ref: LONG_REF, summary: LONG_SUMMARY, stepId: 's9', count: 2, updatedAt: NOW - 540_000 })

test('the artifact page shows everything and never ends a line in …', async ($, on) => {
  seed(on, tl([PAGE_ART, art('link', 'PR', { ref: 'x' })], { steps: [step('s9', 9, 'Write the plan')] }), { ...ART_UI, page: { kind: 'artifact', id: PAGE_ART.id } })
  for (const surface of SURFACES) {
    for (const columns of [62, 40, 32]) {
      const ui = await mount($, surface, columns)
      const rows = await drawnRows(ui)
      for (const r of rows) {
        expect([surface, columns, r, r.length <= columns]).toEqual([surface, columns, r, true])
        expect([surface, columns, r, r.trimEnd().endsWith('…')]).toEqual([surface, columns, r, false])
      }
      // wrapped in full: every word of the title, the ref and the summary is on the page
      const flat = rows.join('').replace(/\s+/g, '')
      expect(flat).toContain(LONG_TITLE.replace(/\s+/g, ''))
      expect(flat).toContain(LONG_REF.replace(/\s+/g, ''))
      expect(flat).toContain(LONG_SUMMARY.replace(/\s+/g, ''))
      await ui.unmount()
    }
  }
})

test('the artifact page: kind, made, path, step it came from, and o: open  c: copy  g: chat  b: back', async ($, on) => {
  const a = art('document', 'Plan', { ref: 'docs/plan.md', summary: 'The plan.', stepId: 's9', updatedAt: NOW - 540_000 })
  seed(on, tl([a, art('link', 'PR', { ref: 'x' })], { steps: [step('s9', 9, 'Write the plan')] }), { ...ART_UI, page: { kind: 'artifact', id: a.id } })
  const ui = await mount($, 'terminal', 62, true)
  const rows = await drawnRows(ui)
  expect(rowWith(rows, 'TITLE')).toContain('Plan')
  expect(rowWith(rows, 'KIND')).toContain('▤ doc')
  expect([colOf(rowWith(rows, 'KIND'), 'made'), colOf(rowWith(rows, 'KIND'), '9m ago')]).toEqual([38, 50])
  expect(rowWith(rows, 'PATH')).toContain('docs/plan.md')
  expect(rowWith(rows, 'MADE BY')).toContain('▸ step 9  Write')
  expect(rowWith(rows, 'o: open').trim()).toBe('o: open   c: copy   g: chat   b: back')
  await ui.unmount()
})

test('the artifact page: o opens a file in the editor and a link in the opener, on a press only; c copies the ref', async ($, on) => {
  const doc = art('document', 'Plan', { ref: 'docs/plan.md' })
  const pg = art('page', 'Design', { ref: 'claude.ai/artifact/x' })
  const stored = seed(on, tl([doc, pg]), { ...ART_UI, page: { kind: 'artifact', id: doc.id } })
  const w = runWorld(on)
  const ui = await mount($, 'terminal')
  await ui.drawn()
  expect(w.runs).toEqual([])
  await ui.press({ key: 'artifact-page-open' })
  expect(w.runs).toEqual([['code', '-r', '-g', 'C:/repo/docs/plan.md']])
  await ui.press({ key: 'artifact-page-copy' })
  expect(w.copies).toEqual(['docs/plan.md'])
  await ui.unmount()
  stored.set('ui', { ...ART_UI, page: { kind: 'artifact', id: pg.id } })
  w.runs.length = 0
  const link = await mount($, 'terminal')
  await link.press({ key: 'artifact-page-open' })
  expect(w.runs[0]).toEqual(['cmd', '/d', '/c', 'start', '', 'https://claude.ai/artifact/x'])
  await link.unmount()
})

test('an artifact page for an artifact that is gone says so', async ($, on) => {
  seed(on, tl([art('link', 'PR', { ref: 'x' })]), { ...ART_UI, page: { kind: 'artifact', id: 'nope' } })
  const ui = await mount($, 'terminal')
  expect((await drawnRows(ui)).join('\n')).toContain('This artifact is gone.')
  await ui.unmount()
})

test('the artifact page: the step that made it opens the step page through openStep, and its body load runs', async ($, on) => {
  const a = art('document', 'Plan', { ref: 'docs/plan.md', stepId: 's9' })
  const stored = seed(on, { ...tl([a], { steps: [step('s9', 9, 'Write the plan')] }), journal: 'sess1' }, { ...ART_UI, page: { kind: 'artifact', id: a.id } })
  exportWorld(on)
  const ui = await mount($, 'terminal')
  await ui.press({ key: 'artifact-madeby' })
  const u = stored.get('ui') as UiState & { stepBody?: { stepId: string; missing?: true } }
  expect(u.page).toEqual({ kind: 'step', id: 's9' })
  // BEHAVIOUR CHANGE (rich rule 4): the step page keeps the tab it was opened from, so `b` returns there.
  expect(u.tab).toBe('artifacts')
  // openStep reads the body (here none is kept) and writes the result beside the page; openPage alone used to leave it unset.
  expect(u.stepBody).toEqual({ stepId: 's9', missing: true })
  await ui.unmount()
})

test('the lintel never gets a readout that meets the pill: the deck and the page draw at 32 columns', async ($, on) => {
  const a = art('document', 'Plan', { ref: 'docs/plan.md' })
  const stored = seed(on, tl([a, art('link', 'PR', { ref: 'x' })]), ART_UI)
  for (const columns of [32, 36, 40]) {
    const deckUi = await mount($, 'terminal', columns)
    expect((await drawnRows(deckUi)).join('\n')).not.toContain('This tab failed')
    expect(await deckUi.find({ key: 'artifacts-deck-lintel' })).toBeDefined()
    await deckUi.unmount()
    stored.set('ui', { ...ART_UI, page: { kind: 'artifact', id: a.id } })
    const pageUi = await mount($, 'terminal', columns)
    expect((await drawnRows(pageUi)).join('\n')).not.toContain('This tab failed')
    expect(await pageUi.find({ key: 'artifact-page-lintel' })).toBeDefined()
    await pageUi.unmount()
    stored.set('ui', ART_UI)
  }
})
