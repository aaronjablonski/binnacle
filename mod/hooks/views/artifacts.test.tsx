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

const PANE = (columns: number, isFocused = false, bodyRows = 40) =>
  ({
    plugin: 'mission-control',
    component: 'Pane',
    requestId: 'mission-control',
    props: {
      title: 'Mission Control',
      isFocused,
      bodyColumns: columns,
      placement: 'dock',
      scroll: { offset: 0, bodyRows },
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

async function mount($: Engine, surface: (typeof SURFACES)[number], columns = 62, isFocused = false, bodyRows = 40) {
  return $.ui.mount({ ...PANE(columns, isFocused, bodyRows), surface })
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


// ---------- the cockpit Artifacts tab (task C5) ----------
// Each test below replaces a Neo or Rich look test of the same subject; the old one is gone, its behaviour kept.

// LOOK TEST (rewritten for the cockpit): replaces "rows are newest first: glyph at 2, title at 4, the kind at 38 and the age at 50".
test('rows are newest first: glyph at 2, title at 4, the kind ending at 49 and the age at 59', async ($, on) => {
  seed(on, FOUR, { ...ART_UI, artifactOpen: '' })
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect(await artButtons(ui)).toEqual(['art-link:PR #41', 'art-result:Review findings', 'art-page:Rate limit design', 'art-document:docs/plan.md'])
    const rows = await drawnRows(ui)
    const page = rowWith(rows, 'Rate limit design')
    expect([colOf(page, '↗'), colOf(page, 'Rate limit design'), colOf(page, 'page') + 4, page.trimEnd().length, page.trimEnd().endsWith('9 min')]).toEqual([2, 4, 50, 60, true])
    const doc = rowWith(rows, 'docs/plan.md')
    expect([colOf(doc, '▤'), doc.slice(0, 50).trimEnd().endsWith('doc'), doc.trimEnd().endsWith('12 min')]).toEqual([2, true, true])
    expect(colOf(rowWith(rows, 'Review findings'), '✦')).toBe(2)
    expect(colOf(rowWith(rows, 'PR #41'), '⎇')).toBe(2)
    // the section head: Artifacts, a hairline, the count and the dim heads over the two columns
    const head = rowWith(rows, 'Artifacts ─')
    expect([colOf(head, 'Artifacts'), colOf(head, 'kind') + 4, head.trimEnd().length, head.trimEnd().endsWith('age'), head.includes('4  ·  kind')]).toEqual([2, 50, 60, true, true])
    await ui.unmount()
  }
})

// LOOK TEST (rewritten for the cockpit): replaces "kinds keep their colours: page and link in the accent, document merged, result success" (no merged and no success in the cockpit palette).
test('kinds keep their colours: page and link in the accent, document and result dim', async ($, on) => {
  seed(on, FOUR, { ...ART_UI, artifactOpen: '' })
  const ui = await mount($, 'terminal')
  const found = await ui.findAll({ type: 'Text' })
  const style = (glyph: string): { color?: string; dimColor?: boolean } => found.find(f => f.text === glyph)?.props as { color?: string; dimColor?: boolean }
  expect([style('↗').color, style('⎇').color]).toEqual(['suggestion', 'suggestion'])
  expect([style('▤').dimColor, style('✦').dimColor]).toEqual([true, true])
  expect([style('▤').color, style('✦').color]).toEqual([undefined, undefined])
  await ui.unmount()
})

// LOOK TEST (rewritten for the cockpit): replaces "a document written three times shows doc ×3 as its kind"; the kind column is plain and the count is the opened artifact's `version`.
test('a document written three times says version 3 under Made by', async ($, on) => {
  seed(on, tl([art('document', 'a.md', { ref: 'a.md', count: 3 })]), ART_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const rows = await drawnRows(ui)
    const r = rowWith(rows, 'a.md ')
    expect(r).toContain('doc')
    expect(r).not.toContain('×')
    expect(colOf(rowWith(rows, 'Made by'), 'main, version 3')).toBe(14)
    await ui.unmount()
  }
})

// BEHAVIOUR CHANGE (rich rule 4): the action line drops `p: page`; Enter on the row opens the page.
// LOOK TEST (rewritten for the cockpit): the keys are at 4 and the values at 14, "Made by" in place of "from".
test('the newest artifact is open by default: Link and Made by at 4 and 14, then o: step  c: copy link  g: chat', async ($, on) => {
  seed(
    on,
    tl([art('page', 'Rate limit design', { ref: 'claude.ai/artifact/x', stepId: 's9' })], { steps: [step('s9', 9, 'Publish')] }),
    ART_UI,
  )
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const rows = await drawnRows(ui)
    const link = rowWith(rows, 'claude.ai/artifact/x')
    expect([colOf(link, 'Link'), colOf(link, 'claude.ai/artifact/x')]).toEqual([4, 14])
    const made = rowWith(rows, 'Made by')
    expect([colOf(made, 'Made by'), colOf(made, 'main, step 9')]).toEqual([4, 14])
    expect(rowWith(rows, 'o: step').trim()).toBe('o: step   c: copy link   g: chat')
    expect(colOf(rowWith(rows, 'o: step'), 'o: step')).toBe(4)
    await ui.unmount()
  }
})

/** The blank rows between the last row of content and the footer row (the last non-blank row). */
function slackAboveFooter(rows: string[]): number {
  const foot = rows.reduce((last, r, i) => (r.trim() !== '' ? i : last), -1)
  let c = foot - 1
  while (c >= 0 && rows[c]!.trim() === '') c--
  return foot - c - 1
}

// MEANING CHANGED (R37, FX3): Files changed keeps the newest 3 and `+ n more` only where the pane has no free rows (24); at 46 and beyond it grows into every free row (the more line never sits over blank rows).
test('Files changed shows the newest 3 and a more line where the pane has no free rows, and fills every free row from 46 up (R37)', async ($, on) => {
  const changed = ['mod/a.ts', 'mod/views/b.ts', 'c.ts', 'mod/views/d.ts', 'e.ts', 'f.ts', 'g.ts', 'h.ts', 'i.ts', 'j.ts', 'k.ts', 'l.ts']
  seed(on, tl([art('link', 'PR', { ref: 'x' })], { changed }), ART_UI)
  for (const surface of SURFACES) {
    for (const bodyRows of [24]) {
      const ui = await mount($, surface, 62, false, bodyRows)
      const rows = await drawnRows(ui)
      await ui.unmount()
      const at = rows.findIndex(r => r.startsWith('  Files changed'))
      expect(at).toBeGreaterThan(-1)
      const list = rows.slice(at + 1)
      expect(list.filter(r => r.slice(2, 3) === '·').map(r => r.slice(4, 30).trimEnd())).toEqual(['l.ts', 'k.ts', 'j.ts'])
      expect(list.find(r => r.startsWith('    + '))).toBe('    + 9 more')
    }
    // 46 rows: the free rows are dealt at once (the mock's 3 and `+ n more` over blank rows is gone); more rows than 3, and a more line only with nothing free under it.
    const mock = await mount($, surface, 62, true, 46)
    const mockRows = await drawnRows(mock)
    await mock.unmount()
    const fromMock = mockRows.findIndex(r => r.startsWith('  Files changed'))
    expect(mockRows.slice(fromMock + 1).filter(r => r.slice(2, 3) === '·').length).toBeGreaterThan(3)
    if (mockRows.some(r => r.startsWith('    + '))) expect(slackAboveFooter(mockRows)).toBe(1)
    // 60 rows: all twelve files fit, and the more line goes.
    const tall = await mount($, surface, 62, false, 60)
    const tallRows = await drawnRows(tall)
    await tall.unmount()
    const from = tallRows.findIndex(r => r.startsWith('  Files changed'))
    expect(tallRows.slice(from + 1).filter(r => r.slice(2, 3) === '·')).toHaveLength(12)
    expect(tallRows.slice(from + 1).some(r => r.startsWith('    + '))).toBe(false)
  }
})

// LOOK TEST (rewritten for the cockpit): replaces the Neo deck, "the deck is HANDOFF, DIGEST, the legend and KEPT in one bracket" and the rich form. Handoff is the header: a lintel, the title and when it was last exported, the one filled button (R33) with its sentence, "The digest will contain" (R30), its bar and legend, a sill.
test('Handoff header: the title, the filled export button with its words, The digest will contain, its bar and legend; a press exports', async ($, on) => {
  const kept = { ...step('s1', 1, 'Write a.md'), pin: 'the plan' }
  const steps = [kept, ...[2, 3, 4, 5].map(n => step(`s${n}`, n, `Read f${n}`))]
  const tasks = [1, 2].map(n => ({ id: String(n), subject: `task ${n}`, status: 'completed' as const, owner: 'main', updatedAt: NOW }))
  seed(on, { ...tl([art('result', 'Findings', { summary: 's' })], { steps, tasks, changed: ['a.ts'] }), journal: 'sess1' }, ART_UI)
  const { writes } = exportWorld(on)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const rows = await drawnRows(ui)
    const at = rows.findIndex(r => r.includes('Handoff'))
    expect(at).toBeGreaterThan(-1)
    const title = rows[at] ?? ''
    expect([colOf(title, 'Handoff'), title.trimEnd().length]).toEqual([2, 60])
    expect(title.includes('exported')).toBe(true)
    expect(rows[at + 1]).toBe('')
    const button = rows[at + 2] ?? ''
    expect([colOf(button, '[ e: Export digest ]'), colOf(button, 'saved to this session and copied')]).toEqual([2, 24])
    expect(rows.join('\n')).not.toContain('journal')
    // M5: the label and the bar share a row, the bar from column 27 with a gap between its parts; the legend is under the label (R39: the key is in the button's label).
    expect(colOf(rows[at + 4] ?? '', 'The digest will contain')).toBe(2)
    const bar = (rows[at + 4] ?? '').slice(27).trimEnd()
    expect(bar).toMatch(/^━+( ━+)+$/)
    expect(bar.length).toBeLessThanOrEqual(33)
    expect(rows[at + 5]?.trim()).toBe('■ summary  ■ 2 tasks  ■ 1 kept  ■ 1 file')
    expect(colOf(rows[at + 5] ?? '', '■')).toBe(2)
    expect(rows.join('\n')).not.toContain('It will hold')
    // the button is the screen's one filled button: variant "primary", and it stays a Button
    const found = await ui.find({ type: 'Button', key: 'handoff-export' })
    expect((found?.props as { variant?: string } | undefined)?.variant).toBe('primary')
    writes.length = 0
    await ui.press({ key: 'handoff-export' })
    expect(writes.length).toBe(1)
    expect(writes[0]).toMatch(/\/sess1\/export-.*\.md$/)
    await ui.unmount()
  }
})

test('on the terminal the Handoff frame is a lintel and a sill instrument with no pill', async ($, on) => {
  seed(on, tl([art('link', 'PR', { ref: 'x' })]), ART_UI)
  const ui = await mount($, 'terminal')
  const rasters = (await ui.findAll({ type: 'Raster' })).map(r => String(r.key))
  expect(rasters).toEqual(expect.arrayContaining(['handoff-lintel', 'handoff-sill']))
  const rows = await drawnRows(ui)
  expect(rows.join('\n')).not.toMatch(/WAITING|WORKING|IDLE|ALL DONE|HANDOFF/)
  await ui.unmount()
  const text = await mount($, 'vscode')
  const t = await drawnRows(text)
  expect(t.some(r => r.startsWith('┏━━─'))).toBe(true)
  expect(t.some(r => r.endsWith('━━┛'))).toBe(true)
  await text.unmount()
})

// LOOK TEST (rewritten for the cockpit): replaces "the KEPT row counts the kept steps": Kept is a section after Files changed that lists the kept steps.
test('Kept lists the kept steps after Files changed: ★ at 2, the note at 4, the tool ending at 49 and the age at 59, and says they are exported in full', async ($, on) => {
  const kept = { ...step('s1', 1, 'Write a.md'), pin: 'the plan', startedAt: NOW - 360_000 }
  seed(on, tl([art('link', 'PR', { ref: 'x' })], { steps: [kept, step('s2', 2, 'Write b.md')], changed: ['a.ts'] }), ART_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const rows = await drawnRows(ui)
    const head = rowWith(rows, 'Kept ─')
    const at = rows.indexOf(head)
    expect(at).toBeGreaterThan(rows.findIndex(r => r.includes('Files changed')))
    expect([colOf(head, 'Kept'), head.includes('1  ·  from'), head.trimEnd().endsWith('age')]).toEqual([2, true, true])
    const k = rows[at + 1] ?? ''
    expect([colOf(k, '★'), colOf(k, 'the plan'), colOf(k, 'Write') + 5, k.trimEnd().endsWith('6 min')]).toEqual([2, 4, 50, true])
    expect(colOf(rows[at + 2] ?? '', 'Kept steps are never trimmed and export in full.')).toBe(4)
    await ui.unmount()
  }
})

test('Kept with no kept steps is absent, and so is the word kept in the digest legend', async ($, on) => {
  seed(on, tl([art('link', 'PR', { ref: 'x' })]), ART_UI)
  const none = await mount($, 'terminal')
  const rows = await drawnRows(none)
  expect(rows.some(r => r.startsWith('  Kept'))).toBe(false)
  expect(rows.join('\n')).not.toContain(' kept')
  await none.unmount()
})

test('Kept with several kept steps counts them and shows the newest 3', async ($, on) => {
  const many = [1, 2, 3, 4, 5].map(n => ({ ...step(`s${n}`, n, `Write f${n}.md`), pin: n % 2 === 0 ? 'note ' + n : '', startedAt: NOW - n * 60_000 }))
  seed(on, tl([art('link', 'PR', { ref: 'x' })], { steps: many }), ART_UI)
  // MEANING CHANGED (R37, FX3): a roomy pane (this suite's default 40 rows) lists all five; only a pane with no free rows keeps the newest 3 and `+ 2 more`.
  const roomy = await mount($, 'terminal')
  const roomyRows = await drawnRows(roomy)
  expect(roomyRows.filter(r => r.startsWith('  ★')).length).toBe(5)
  expect(roomyRows.some(r => r.startsWith('    + '))).toBe(false)
  await roomy.unmount()
  const ui = await mount($, 'terminal', 62, false, 24)
  const rows = await drawnRows(ui)
  expect(rowWith(rows, 'Kept ─')).toContain('5  ·  from')
  expect(rows.filter(r => r.startsWith('  ★')).length).toBe(3)
  expect(rows.some(r => r === '    + 2 more')).toBe(true)
  expect(rowWith(rows, '★ f1.md')).not.toBe('')
  await ui.unmount()
})

// LOOK TEST (rewritten for the cockpit): replaces "e exports from the footer, which shows 3 entries and only while focused": `e` is armed by the Export button in the header, so the footer says it as text (R28) and the press is on the button.
test('the footer reads ↵ open artifact, e export, esc prompt, only while focused; e is the Export button', async ($, on) => {
  seed(on, { ...tl([art('link', 'PR', { ref: 'x' })]), journal: 'sess1' }, ART_UI)
  const { writes } = exportWorld(on)
  const quiet = await mount($, 'terminal', 62, false)
  expect((await drawnRows(quiet)).some(r => r.includes('↵ open artifact'))).toBe(false)
  await quiet.unmount()
  const ui = await mount($, 'terminal', 62, true)
  const rows = await drawnRows(ui)
  expect(rowWith(rows, '↵ open artifact')).toContain('↵ open artifact   e export   esc prompt')
  expect(colOf(rowWith(rows, '↵ open artifact'), '↵')).toBe(2)
  expect(rows.indexOf(rowWith(rows, '↵ open artifact'))).toBe(rows.length - 1)
  const exportButton = await ui.find({ type: 'Button', key: 'handoff-export' })
  expect((exportButton?.props as { hotkey?: string }).hotkey).toBe('e')
  await ui.press({ key: 'handoff-export' })
  expect(writes.length).toBe(1)
  await ui.unmount()
})

test('a long path is cut from the left in the Link line and fits 32 columns', async ($, on) => {
  const ref = 'src/very/long/folder/structure/for/the/rate/limiter.ts'
  seed(on, tl([art('document', ref, { ref, count: 2 })]), ART_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface, 32)
    const rows = await drawnRows(ui)
    const link = rowWith(rows, 'Link')
    expect(link.length <= 32).toBe(true)
    expect(link).toContain('…')
    expect(link.endsWith('limiter.ts')).toBe(true)
    await ui.unmount()
  }
})

// MEANING CHANGED (R37, FX3): Artifacts keeps 6 and `+ n more` only where the pane has no free rows (10); at 46 and beyond it grows into every free row, and the more line never sits over blank rows.
test('Artifacts shows 6 rows and a more line where the pane has no free rows, and fills every free row from 46 up (R37)', async ($, on) => {
  const many = Array.from({ length: 60 }, (_, i) => art('link', `L${i + 1}`, { ref: `r${i + 1}`, updatedAt: NOW - (i + 1) * 1000 }))
  seed(on, tl(many), { ...ART_UI, artifactOpen: '' })
  for (const bodyRows of [10]) {
    const ui = await mount($, 'terminal', 62, false, bodyRows)
    expect((await artButtons(ui)).length).toBe(6)
    expect((await drawnRows(ui)).some(r => r === '    + 54 more')).toBe(true)
    await ui.unmount()
  }
  // 46 and 60 rows: every free row goes to the list (more rows than 6, a shorter more line); the more line only with nothing free under it; 120 rows show every artifact.
  let last = 6
  for (const h of [46, 60]) {
    const mid = await mount($, 'terminal', 62, true, h)
    const shown = (await artButtons(mid)).length
    const midRows = await drawnRows(mid)
    expect(shown).toBeGreaterThan(last)
    expect(shown).toBeLessThan(60)
    last = shown
    expect(midRows.some(r => r === `    + ${60 - shown} more`)).toBe(true)
    expect([h, slackAboveFooter(midRows)]).toEqual([h, 1])
    await mid.unmount()
  }
  const tall = await mount($, 'terminal', 62, false, 120)
  expect((await artButtons(tall)).length).toBe(60)
  expect((await drawnRows(tall)).some(r => r.startsWith('    + '))).toBe(false)
  await tall.unmount()
})

test('the header shows the last export from lastExport: "last exported" and its time, or "not exported yet"', async ($, on) => {
  const exported = NOW - 3_600_000
  const stored = seed(on, tl([art('link', 'PR', { ref: 'x' })], { lastExport: { at: exported, path: 'C:/j/export.md' } }), ART_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const ex = rowWith(await drawnRows(ui), 'Handoff')
    expect(ex.trimEnd().endsWith(`last exported ${clock(exported)}`)).toBe(true)
    expect(ex.trimEnd().length).toBe(60)
    expect(ex).not.toContain('not exported yet')
    await ui.unmount()
  }
  stored.set('timeline', tl([art('link', 'PR', { ref: 'x' })]))
  const none = await mount($, 'terminal')
  expect(rowWith(await drawnRows(none), 'Handoff').trimEnd().endsWith('not exported yet')).toBe(true)
  await none.unmount()
})

// LOOK TEST (rewritten for the cockpit): replaces "DIGEST: a 22-cell stack Raster ... text form a run of ▄": the bar is Text `━` runs (R22) and needs no Raster; no words estimate and no part count.
test('the digest bar is ━ in the four parts with a gap between them, beside its label from column 27, and the legend names them (M5)', async ($, on) => {
  const kept = { ...step('s1', 1, 'Write a.md'), pin: 'the plan' }
  const steps = [kept, ...[2, 3, 4, 5].map(n => step(`s${n}`, n, `Read f${n}`))]
  const tasks = [1, 2].map(n => ({ id: String(n), subject: `task ${n}`, status: 'completed' as const, owner: 'main', updatedAt: NOW }))
  seed(on, tl([art('result', 'Findings', { summary: 's' })], { steps, tasks, changed: ['a.ts'] }), ART_UI)
  const ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Raster', key: 'digest' })).toBeUndefined()
  const rows = await drawnRows(ui)
  const bar = rows.find(r => /^ {2}The digest will contain {2}━+( ━+)+$/.test(r))
  expect(bar).toBeDefined()
  expect(bar!.slice(27).length).toBeLessThanOrEqual(33)
  expect(rows.join('\n')).not.toMatch(/words|parts/)
  await ui.unmount()
})

test('a digest with nothing in it is a rest bar (33 cells beside the label) and has no legend', async ($, on) => {
  seed(on, tl([]), ART_UI)
  const ui = await mount($, 'desktop')
  const rows = await drawnRows(ui)
  const at = rows.findIndex(r => r.includes('The digest will contain'))
  expect((rows[at] ?? '').slice(27).trim()).toMatch(/^━{33}$/)
  expect(rows[at + 1]?.includes('■')).toBe(false)
  await ui.unmount()
})

// LOOK TEST (rewritten for the cockpit): replaces "FILES CHANGED: each file has an edit bar sized by its edits": the marks are ▪ in Text from column 36, the count ends at 49 and the time at 59.
test('Files changed: each file has edit marks (one ▪ an edit), its count ending at 49 and its last edit at 59', async ($, on) => {
  const steps = [edit('e1', 1, 'Edit src/up.ts', 600_000), edit('e2', 2, 'Edit src/up.ts', 300_000), edit('e3', 3, 'Edit src/rl.ts', 60_000), edit('e4', 4, 'Edit src/rl.ts', 30_000), edit('e5', 5, 'Edit src/rl.ts', 12_000)]
  seed(on, tl([art('link', 'PR', { ref: 'x' })], { steps, changed: ['src/up.ts', 'src/rl.ts'] }), ART_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const rows = await drawnRows(ui)
    const rl = rowWith(rows, 'src/rl.ts')
    const up = rowWith(rows, 'src/up.ts')
    expect([colOf(rl, '·'), colOf(rl, 'src/rl.ts'), colOf(rl, '▪▪▪'), rl.slice(0, 50).trimEnd().endsWith('3'), rl.trimEnd().endsWith('12s'), rl.trimEnd().length]).toEqual([2, 4, 36, true, true, 60])
    expect([colOf(up, '▪▪'), up.includes('▪▪▪'), up.slice(0, 50).trimEnd().endsWith('2'), up.trimEnd().endsWith('5 min')]).toEqual([36, false, true, true])
    expect(rowWith(rows, 'Files changed ─').includes('2  ·  edits')).toBe(true)
    await ui.unmount()
  }
})

test('the artifact page: sentence-case labels for kind, made, path, step it came from, and o: open  c: copy  g: chat  b: back', async ($, on) => {
  const a = art('document', 'Plan', { ref: 'docs/plan.md', summary: 'The plan.', stepId: 's9', updatedAt: NOW - 540_000 })
  seed(on, tl([a, art('link', 'PR', { ref: 'x' })], { steps: [step('s9', 9, 'Write the plan')] }), { ...ART_UI, page: { kind: 'artifact', id: a.id } })
  const ui = await mount($, 'terminal', 62, true)
  const rows = await drawnRows(ui)
  expect(rowWith(rows, 'Title')).toContain('Plan')
  expect(rowWith(rows, 'Kind')).toContain('▤ doc')
  expect([colOf(rowWith(rows, 'Kind'), 'made'), colOf(rowWith(rows, 'Kind'), '9 min ago')]).toEqual([38, 50])
  expect(rowWith(rows, 'Path')).toContain('docs/plan.md')
  expect(rowWith(rows, 'Made by')).toContain('▸ step 9  Write')
  expect(rowWith(rows, 'o: open').trim()).toBe('o: open   c: copy   g: chat   b: back')
  // the cockpit page: the state in plain words, no pill, no caps labels
  expect(rowWith(rows, 'artifact 2 of 2')).toMatch(/^ {2}Doc {2,}artifact 2 of 2$/)
  expect(rows.join('\n')).not.toMatch(/TITLE|KIND|PATH|MADE BY|HANDOFF|DOC /)
  await ui.unmount()
})

test('the lintel never gets a readout that meets the pill: the Handoff header and the page draw at 32 columns', async ($, on) => {
  const a = art('document', 'Plan', { ref: 'docs/plan.md' })
  const stored = seed(on, tl([a, art('link', 'PR', { ref: 'x' })]), ART_UI)
  for (const columns of [32, 36, 40]) {
    const deckUi = await mount($, 'terminal', columns)
    expect((await drawnRows(deckUi)).join('\n')).not.toContain('This tab failed')
    expect(await deckUi.find({ key: 'handoff-lintel' })).toBeDefined()
    await deckUi.unmount()
    stored.set('ui', { ...ART_UI, page: { kind: 'artifact', id: a.id } })
    const pageUi = await mount($, 'terminal', columns)
    expect((await drawnRows(pageUi)).join('\n')).not.toContain('This tab failed')
    expect(await pageUi.find({ key: 'artifact-page-lintel' })).toBeDefined()
    await pageUi.unmount()
    stored.set('ui', ART_UI)
  }
})

// M14: the hotkeys o, c and g are on one opened item at a time, so none is ever given to two Buttons.
test('hotkeys never collide: an opened artifact and a selected file never show their keys together', async ($, on) => {
  seed(on, tl([art('document', 'a.md', { ref: 'a.md', stepId: 's1' })], { steps: [step('s1', 1, 'Write a.md')], changed: ['src/up.ts'] }), ART_UI)
  const ui = await mount($, 'terminal', 62, true)
  const hotkeys = async (): Promise<string[]> =>
    (await ui.findAll({ type: 'Button' })).map(b => (b.props as { hotkey?: string }).hotkey).filter((k): k is string => k !== undefined)
  const dupes = (keys: string[]): string[] => keys.filter((k, i) => keys.indexOf(k) !== i)
  // The newest artifact opens by itself: its o, c and g are the only ones.
  await ui.drawn()
  expect(await hotkeys()).toEqual(expect.arrayContaining(['o', 'c', 'g']))
  expect(dupes(await hotkeys())).toEqual([])
  expect(await ui.find({ type: 'Button', key: 'act-o-file-0' })).toBe(undefined)
  // Selecting a file closes the artifact: now the file's o and c are the only ones, and no g.
  await ui.press({ key: 'file-0' })
  await ui.redraw()
  expect(await ui.find({ type: 'Button', key: 'act-o-document:a.md' })).toBe(undefined)
  expect(await ui.find({ type: 'Button', key: 'act-o-file-0' })).toBeDefined()
  expect(dupes(await hotkeys())).toEqual([])
  expect(await hotkeys()).not.toContain('g')
  // Opening the artifact again takes the keys back.
  await ui.press({ key: 'art-document:a.md' })
  await ui.unmount()
})
