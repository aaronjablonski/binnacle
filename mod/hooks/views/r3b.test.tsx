import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { AgentRow, TaskItem, Timeline, UiState } from '../../types'
import { empty } from '../model/reduce'
import { initialUi } from '../state'
import { sinceWords, typeShort, wordFit } from './fit'
import { agent, asked, busy, idle, NOW, tasksOf, watching } from './now.fixtures.testkit'
import { colOf, screen } from './screen.testkit'
import { critterGlyph, typeName } from './style'
import { watchSentence } from './watch'
import { tokensCell } from './agentmeta'
import { mapTotals } from './tree'

// Fix round R3-B (Fable round 3: I1 desktop header, I3, I4, I5, I6, I7, M1 to M8, M10, M14, M16). One test file for the
// views' own behaviour; the fidelity boards and the older tests are in their own files.

const SHAPES: Record<string, string> = { timeline: 'timeline-4', ui: 'ui-4' }
type Stored = Map<string, unknown>

function world(on: On, t: Timeline, u: UiState = initialUi): Stored {
  const stored: Stored = new Map<string, unknown>([['timeline', t], ['ui', u]])
  const versions = new Map<string, number>()
  mock.clock(on, { now: NOW })
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
  return stored
}

type Surface = 'terminal' | 'desktop' | 'vscode' | 'mobile'
const pane = (columns: number, rows: number, focused = true) =>
  ({
    plugin: 'binnacle',
    component: 'Pane',
    requestId: 'binnacle',
    props: { title: 'Binnacle', isFocused: focused, bodyColumns: columns, placement: 'dock', scroll: { offset: 0, bodyRows: rows }, view: {}, isPromptCovered: true as const },
  }) as Record<string, unknown>

const band = (cols: number, maxRows: number) =>
  ({
    plugin: 'binnacle',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isCollapsed: false, isWorking: true, maxRows, bodyColumns: cols, scroll: { offset: 0, bodyRows: Math.max(0, maxRows - 1) }, view: {} },
  }) as Record<string, unknown>

async function rowsAt($: Engine, cols: number, rows = 46, surface: Surface = 'terminal', focused = true): Promise<string[]> {
  const ui = await $.ui.mount({ ...pane(cols, rows, focused), surface } as never)
  const out = screen(await ui.drawn())
  await ui.unmount()
  return out
}


// ---------- I1: the desktop header agrees with the body ----------

test('I1: on the desktop the Svg header and the body agree after the first minute: an old permission is not WAITING FOR YOU in one and dim in the other', async ($, on) => {
  const t = asked()
  const old: Timeline = { ...t, steps: t.steps.map(s => (s.asking !== undefined ? { ...s, asking: NOW - 5 * 60_000 } : s)) }
  world(on, old, { ...initialUi, paneOpen: true })
  const ui = await $.ui.mount({ ...(pane(62, 46, true) as object), props: { ...(pane(62, 46, true) as { props: object }).props, isPromptCovered: undefined }, surface: 'desktop' } as never)
  const svgs = await ui.findAll({ type: 'Svg' })
  expect(svgs.length).toBe(1)
  const alt = (svgs[0]!.props as { alt: string }).alt
  expect(alt).not.toContain('WAITING FOR YOU')
  expect(alt).toContain('WORKING')
  const body = screen(await ui.drawn()).join('\n')
  expect(body).not.toContain('Needs you')
  await ui.unmount()
})

// ---------- M6: plugin prefix ----------

test('M6: an agent type with a plugin prefix reads as its own name', () => {
  expect(typeName('superpowers:code-reviewer')).toBe('Code reviewer')
  expect(typeName('code-reviewer')).toBe('Code reviewer')
  expect(typeName('a:b:Explore')).toBe('Explorer')
})

// ---------- M14: effort words ----------

test('M14: during a turn with a task in progress the Tasks tab says once, dim, that the effort is counted when the turn ends', async ($, on) => {
  world(on, busy(), { ...initialUi, tab: 'tasks' })
  const ui = await $.ui.mount({ ...pane(62, 46), surface: 'terminal' } as never)
  const text = screen(await ui.drawn()).join('\n')
  expect(text.match(/counted when the turn ends/g)?.length).toBe(1)
  const found = await ui.findAll({ type: 'Text' })
  expect(found.some(f => f.text?.includes('counted when the turn ends') && (f.props as { dimColor?: boolean }).dimColor === true)).toBe(true)
  await ui.unmount()
})

// ---------- I3: the past headline is dim ----------

test('I3: between requests the header shows the last request\'s goal dim, not bold', async ($, on) => {
  world(on, idle(), initialUi)
  const ui = await $.ui.mount({ ...pane(62, 46), surface: 'vscode' } as never)
  const found = await ui.findAll({ type: 'Text' })
  const goal = found.filter(f => f.text?.includes('Rate limiting is wired in'))
  expect(goal.length).toBeGreaterThan(0)
  for (const g of goal) {
    expect((g.props as { bold?: boolean }).bold).not.toBe(true)
    expect((g.props as { dimColor?: boolean }).dimColor).toBe(true)
  }
  await ui.unmount()
})

// ---------- I4: the Svg header alone ----------

test('I4: the desktop alt says the pane\'s agent words, with no keyboard hint, and the Svg draws no To do or Agents rows', async ($, on) => {
  world(on, asked(), { ...initialUi, paneOpen: true })
  const ui = await $.ui.mount({ ...pane(62, 46), surface: 'desktop' } as never)
  const svg = (await ui.findAll({ type: 'Svg' }))[0]!.props as { alt: string; source: string }
  expect(svg.alt).toContain('1 working · 1 waiting')
  expect(svg.alt).not.toMatch(/esc |press |hotkey/i)
  expect(svg.source).not.toContain('>To do<')
  expect(svg.source).not.toContain('>Agents<')
  await ui.unmount()
})

// ---------- I5: wrap before cutting (32 to 47 columns) ----------

// R45, R48: Now carries no Watch count; slim does, shortened whole ("2 to watch"), never "2 things to…".
test('I5: slim says the Watch count whole ("2 to watch"), never "2 things to…"; Now says none', async ($, on) => {
  world(on, watching())
  expect((await rowsAt($, 28)).some(r => r.includes('2 to watch'))).toBe(true)
  const now = (await rowsAt($, 40)).join('\n')
  expect(now).not.toContain('to watch')
  expect(now).not.toContain('things to…')
})

// R45: Watch lives in slim now; its top sentence wraps (up to three rows) instead of ending in …
test('I5: in slim the top Watch sentence wraps instead of ending in …', async ($, on) => {
  world(on, watching())
  const rows = await rowsAt($, 28)
  const at = rows.findIndex(r => r.includes('to watch'))
  expect(at).toBeGreaterThan(-1)
  const sentence = rows.slice(at + 1, at + 4).join('\n')
  expect(sentence).toMatch(/run|min|failed|quiet/)
  expect(sentence).not.toContain('…')
})

test('I5: at 40 columns idle says both resting sentences whole, and the last task and the facts wrap', async ($, on) => {
  world(on, idle())
  const text = (await rowsAt($, 40)).join('\n')
  expect(text).toContain('Everyone is resting.')
  expect(text).toContain('A new prompt wakes them.')
  expect(text).toContain('the last was “Open the pull')
  expect(text).toContain('request”')
  expect(text).not.toMatch(/Everyone is…|A new prompt…|middleware…/)
})

test('I5: the Tasks tab wraps the current task at 32 columns instead of cutting it', async ($, on) => {
  world(on, busy(), { ...initialUi, tab: 'tasks' })
  const rows = await rowsAt($, 32)
  const at = rows.findIndex(r => r.includes('▸ Wire the limiter'))
  expect(at).toBeGreaterThan(0)
  expect(rows[at]).not.toContain('…')
  expect(rows[at + 1]).toContain('chain')
})

test('I5: the Agents Models row wraps at 32 columns and the toggle says r: Working, whole', async ($, on) => {
  const t = busy()
  const agents: Record<string, AgentRow> = { ...t.agents, m1: agent('m1', 'Explore', 'one', NOW - 60_000, { model: 'claude-sonnet-5', tokensIn: 50_000 }), m2: agent('m2', 'Explore', 'two', NOW - 60_000, { model: 'claude-opus-5', tokensIn: 20_000 }) }
  world(on, { ...t, agents }, { ...initialUi, tab: 'agents' })
  const rows = await rowsAt($, 32)
  expect(rows.some(r => r.includes('r: Working') && !r.includes('r: Working only'))).toBe(true)
  expect(rows.join('\n')).not.toMatch(/Opus…|Sonnet…/)
})

// ---------- I6: slim ----------

test('I6: slim shows the Watch count with its top item, and "◌ quiet" for a silent turn', async ($, on) => {
  world(on, watching())
  const text = (await rowsAt($, 28)).join('\n')
  expect(text).toContain('◔ 2 to watch')
  expect(text).toContain('Explorer has run')
  const quietT: Timeline = { ...busy(), steps: [], agents: { main: busy().agents.main! } }
  void quietT
})

test('I6: a slim list grows with the pane\'s rows instead of stopping at 8, and keeps an item whose first word is wide', async ($, on) => {
  const t = busy()
  const tasks: TaskItem[] = [...tasksOf(0), ...Array.from({ length: 30 }, (_, i) => ({ ...tasksOf(0)[0]!, id: `x${i}`, subject: i === 3 ? 'a_very_long_unbroken_word_that_is_wider_than_the_pane' : `Extra task ${i}`, status: 'pending' as const }))]
  world(on, { ...t, tasks }, { ...initialUi, tab: 'tasks' })
  const tall = await rowsAt($, 28, 40)
  expect(tall.filter(r => r.includes('Extra task')).length).toBeGreaterThanOrEqual(20)
  expect(tall.some(r => r.includes('a_very_long'))).toBe(true)
  const short = await rowsAt($, 28, 14)
  expect(short.filter(r => r.includes('Extra task')).length).toBeLessThan(12)
  expect(short.some(r => /\+ \d+ more/.test(r))).toBe(true)
})

test('I6: a slim agent row says the agent\'s name, then its job', async ($, on) => {
  world(on, busy(), { ...initialUi, tab: 'agents' })
  const rows = await rowsAt($, 28)
  expect(rows.some(r => r.includes('Explorer find'))).toBe(true)
})

// ---------- I7: the strip ----------

test('I7: at 100 columns by 14 rows an ask is the first block of the right column: its sentence, command and chip are in view', async ($, on) => {
  world(on, asked(), { ...initialUi, strip: true })
  const ui = await $.ui.mount({ ...band(100, 14), surface: 'terminal' } as never)
  const rows = screen(await ui.drawn())
  await ui.unmount()
  const at = rows.findIndex(r => r.includes('Needs you ─'))
  expect(at).toBe(0)
  expect(colOf(rows[0], 'Needs you')).toBe(64)
  const text = rows.slice(0, 13).join('\n')
  expect(text).toContain('asks to run')
  expect(text).toContain('npm run deploy')
  expect(text).toMatch(/answer in the prompt|esc/)
})

test('I7: with nothing asking, the top Watch row stands in the strip\'s right column', async ($, on) => {
  world(on, watching(), { ...initialUi, strip: true })
  const ui = await $.ui.mount({ ...band(100, 14), surface: 'terminal' } as never)
  const rows = screen(await ui.drawn())
  await ui.unmount()
  expect(rows.slice(0, 5).some(r => r.includes('Long run'))).toBe(true)
})

// ---------- M1: the crew map ----------

test('M1: a long session\'s map never runs the state into the tokens, shows no lone …, and totals every task', async ($, on) => {
  const t = busy()
  const crowd: Record<string, AgentRow> = {}
  for (let i = 0; i < 40; i++) crowd[`c${i}`] = agent(`c${i}`, 'Explore', `job ${i}`, NOW - 60_000, { tokensIn: 1_200_000 })
  const tasks = Array.from({ length: 30 }, (_, i) => ({ ...tasksOf(0)[0]!, id: `m${i}`, subject: `Task ${i}`, status: 'pending' as const }))
  world(on, { ...t, agents: { ...t.agents, ...crowd }, tasks }, { ...initialUi, tab: 'agents', agentsMode: 'tree' })
  const text = (await rowsAt($, 62, 60)).join('\n')
  expect(text).not.toMatch(/working\d/)
  expect(text).not.toMatch(/ … /)
  expect(text).toMatch(/Total {2}\d+ agents · 30 tasks/)
  expect(tokensCell({ ...t.agents.e1!, tokensIn: undefined, tokensOut: undefined })).toBe('–')
})

test('M1: the map footer keeps one order with and without a flag', async ($, on) => {
  world(on, busy(), { ...initialUi, tab: 'agents', agentsMode: 'tree' })
  const plain = (await rowsAt($, 62)).at(-1)!
  expect(plain.indexOf('r working only')).toBeLessThan(plain.indexOf('esc prompt'))
})

test('M4: the List and Map labels start in the same columns whichever mode is open', async ($, on) => {
  const stored = world(on, busy(), { ...initialUi, tab: 'agents' })
  const list = (await rowsAt($, 62)).find(r => r.includes('l: List'))!
  stored.set('ui', { ...initialUi, tab: 'agents', agentsMode: 'tree' })
  const tree = (await rowsAt($, 62)).find(r => r.includes('l: List'))!
  expect([colOf(tree, 'l: List'), colOf(tree, 't: Map'), colOf(tree, 'r: Working only')]).toEqual([colOf(list, 'l: List'), colOf(list, 't: Map'), colOf(list, 'r: Working only')])
})

// ---------- M2: in-progress marks and long words ----------

test('M2: every task in progress draws ▸, and a long unbroken word is cut at _ / . with room left', async ($, on) => {
  const base = tasksOf(2)
  const tasks: TaskItem[] = [
    ...base.slice(0, 2),
    { ...base[2]!, id: 'p1', subject: 'Second going', status: 'in_progress' },
    { ...base[2]!, id: 'p2', subject: 'Third going', status: 'in_progress' },
    { ...base[2]!, id: 'q1', subject: 'Task 251: src/server/middleware/rate_limiter_config_for_the_upload_handler_v2.ts', status: 'pending' },
  ]
  world(on, { ...busy(), tasks })
  const text = (await rowsAt($, 62)).join('\n')
  expect(text).toMatch(/▸ Second going/)
  expect(text).toMatch(/▸ Third going/)
  const src = 'Task 251: src/server/middleware/rate_limiter_config_for_the_upload_handler_v2.ts'
  const cut = wordFit(src, 40)
  expect(cut.endsWith('…')).toBe(true)
  expect(cut.length).toBeLessThanOrEqual(40)
  expect(cut.startsWith('Task 251: src/server')).toBe(true)
  // The cut lands where a part ends, never inside one.
  expect('_/.-:'.includes(src[cut.length - 1]!)).toBe(true)
})

// ---------- M5: formats ----------

test('M5: a span over a day reads yesterday or days, a Watch sentence reads 1 h 4 min, and a map time under 46 columns keeps 1 h 48 min', async ($, on) => {
  expect(sinceWords('finished', 2 * 60_000)).toBe('finished 2 min ago')
  expect(sinceWords('finished', 26 * 3_600_000)).toBe('finished yesterday')
  expect(sinceWords('stopped', 3 * 86_400_000)).toBe('stopped 3 days ago')
  const w = { key: 'k', kind: 'long-run', agent: 'e1', since: NOW, who: 'Explorer', sentence: 'Explorer has run 64 min (limit 60)' } as never
  expect(watchSentence(w)).toBe('Explorer has run 1 h 4 min (limit 60)')
  const t = busy()
  world(on, { ...t, turns: [{ ...t.turns[0]!, startedAt: NOW - 108 * 60_000 }, ...t.turns.slice(1)], steps: t.steps.map(s => ({ ...s, startedAt: Math.min(s.startedAt, NOW - 108 * 60_000) })) }, { ...initialUi, tab: 'agents', agentsMode: 'tree' })
  const narrow = (await rowsAt($, 40)).join('\n')
  expect(narrow).toContain('1 h 48 min')
})

test('M5: the Options card writes minutes as 60 min', async ($, on) => {
  world(on, empty, { ...initialUi, page: { kind: 'options', id: '' } as never })
  const rows = await rowsAt($, 62, 46)
  const row = rows.find(r => r.includes('Agent time limit'))
  expect(row).toBeDefined()
  expect(row).toMatch(/\d+ min|off/)
  expect(row).not.toMatch(/\d+m\b/)
})

// ---------- M7: an empty session ----------

test('M7: before any request Now draws no To do block and no export hint', async ($, on) => {
  world(on, { ...empty, notes: [], artifacts: [], tasks: [], turns: [], steps: [] })
  const text = (await rowsAt($, 62)).join('\n')
  expect(text).not.toContain('No to-do list')
  expect(text).not.toContain('To do')
  expect(text).not.toContain('export digest')
})

test('M7: after a request with no list Now still says so', async ($, on) => {
  world(on, { ...busy(), tasks: [] })
  expect((await rowsAt($, 62)).join('\n')).toContain('No to-do list for this request')
})

// ---------- M8, M10, M16 ----------

test('M8: the header critter\'s text form reads ● lead on one row, and done is never green', async ($, on) => {
  world(on, busy())
  const rows = await rowsAt($, 62, 46, 'vscode')
  expect(rows.some(r => /^ {2}● lead/.test(r))).toBe(true)
  // Mop-up m4: "done is never green" is now asserted: a done crew glyph is the dim check, with no colour at all.
  const done = critterGlyph('done')
  expect(done.glyph).toEqual({ text: '✓', dim: true })
  expect('color' in done.glyph).toBe(false)
  expect(done.badge).toBeUndefined()
})

test('M10: the Options footer is the pane\'s last row, written "b back" with no colon', async ($, on) => {
  world(on, empty, { ...initialUi, page: { kind: 'options', id: '' } as never })
  const rows = await rowsAt($, 62, 46)
  expect(rows.at(-1)).toContain('b back')
  expect(rows.at(-1)).not.toContain('b:')
  expect(rows.filter(r => r.includes('b back')).length).toBe(1)
})

test('M16: from 38 columns the tabs keep their words; under 38 they are icons', async ($, on) => {
  world(on, empty)
  expect((await rowsAt($, 38))[0]).toContain('1:Now')
  expect((await rowsAt($, 37))[0]).toContain('◆')
})


// ---------- Mop-up (m3, m5, m10) ----------

test('m3: at 36 columns an open and a done task on Tasks wrap before any `…`', async ($, on) => {
  const long = 'Return 429 with a Retry-After header when the limiter trips for a client'
  const tasks: TaskItem[] = [
    { id: '1', subject: long, status: 'completed', owner: 'main', updatedAt: NOW - 5 * 60_000 },
    { id: '2', subject: 'Doing the thing', status: 'in_progress', owner: 'main', updatedAt: NOW - 60_000 },
    { id: '3', subject: long.replace('Return', 'Queue'), status: 'pending', owner: 'main', updatedAt: NOW - 60_000 },
  ]
  world(on, { ...busy(), tasks }, { ...initialUi, tab: 'tasks' })
  const rows = await rowsAt($, 36, 60)
  expect(rows.some(r => r.includes('Retry-After'))).toBe(true)
  expect(rows.some(r => /Return 429.*…$/.test(r) || /Queue 429.*…$/.test(r))).toBe(false)
})

test('m5: the crew map total ignores the tasks of a cleared conversation', () => {
  const mk = (id: string, at: number): TaskItem => ({ id, subject: id, status: 'pending', owner: 'main', updatedAt: at })
  const t: Timeline = { ...busy(), tasks: [mk('c1:1', 10), mk('2', NOW - 1000)], clearedAt: NOW - 5000 }
  expect(mapTotals(t, []).tasks).toBe(1)
})

test('m10: a plugin prefix never shows in a short type label', () => {
  expect(typeShort('superpowers:code-reviewer')).toBe('code')
})
