import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Step, Timeline, UiState } from '../../types'
import { initialUi } from '../state'
import { agent, asked, busy, finished, idle, longList, NOW, step, watching } from './now.fixtures.testkit'
import { warmWords } from './fit'
import { dealRows } from './overview'
import { backTo, keepLog, LOGS, screen } from './screen.testkit'

// Now in the cockpit (spec "Screens", its Tests line, and the rulings the
// screen carries). The mock boards themselves are now.fidelity.test.tsx's.

const SHAPES: Record<string, string> = { timeline: 'timeline-4', ui: 'ui-4' }
const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
type Stored = Map<string, unknown>

function world(on: On, t: Timeline, u: UiState = initialUi, env: Record<string, string> = {}): Stored {
  const stored: Stored = new Map<string, unknown>([['timeline', t], ['ui', u]])
  const versions = new Map<string, number>()
  mock.clock(on, { now: NOW })
  mock.env(on, env)
  LOGS.length = 0
  on('ui.log', keepLog)
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

const PANE = (columns: number, rows: number, o: { focused?: boolean; covered?: boolean } = {}) =>
  ({
    plugin: 'binnacle',
    component: 'Pane',
    requestId: 'binnacle',
    props: {
      title: 'Binnacle', isFocused: o.focused ?? true, bodyColumns: columns, placement: 'dock',
      scroll: { offset: 0, bodyRows: rows }, view: {}, ...(o.covered === true ? { isPromptCovered: true as const } : {}),
    },
  }) as const

const mount = ($: Engine, cols = 62, rows = 46, o: { focused?: boolean; covered?: boolean; surface?: (typeof SURFACES)[number] } = {}) =>
  $.ui.mount({ ...PANE(cols, rows, o), surface: o.surface ?? 'terminal' })
type Mounted = Awaited<ReturnType<typeof mount>>
const rowsOf = async (ui: Mounted): Promise<string[]> => screen(await ui.drawn())
const uiOf = (s: Stored): UiState => s.get('ui') as UiState

type Node = { type?: unknown; key?: string; props?: Record<string, unknown>; children?: unknown }
const keyOf = (n: Node): string => (typeof n.key === 'string' ? n.key : typeof n.props?.key === 'string' ? (n.props.key as string) : '')
/** Every element of a drawn subtree. */
function walk(n: unknown, out: Node[] = []): Node[] {
  if (n === null || n === undefined || typeof n !== 'object') return out
  if (Array.isArray(n)) {
    n.forEach(k => walk(k, out))
    return out
  }
  const el = n as Node
  out.push(el)
  walk(el.children ?? el.props?.children, out)
  return out
}

// ---------- the spec's Tests line ----------

test('Now holds no log: no step command, no step count and no error count, on every surface', async ($, on) => {
  const t = busy()
  const lint: Step = step('x1', 50, 'main', 'Bash', 'Bash npm run lint -- --fix', 'error', NOW - 60_000, { endedAt: NOW - 50_000, turnId: 't1' })
  world(on, { ...t, steps: [...t.steps, lint] })
  for (const surface of SURFACES) {
    const ui = await mount($, 62, 46, { surface })
    const text = (await rowsOf(ui)).join('\n')
    expect(text).not.toContain('npm run lint')
    expect(text).not.toContain('Grep "upload("')
    expect(text).not.toMatch(/\b\d+ (steps?|errors?)\b/i)
    expect(text).not.toMatch(/STEPS|LATEST|✖/)
    await ui.unmount()
  }
})

test('R48: no calm line on Now; an ask, or an auto-mode ask still being checked, takes the row right under the header (R2)', async ($, on) => {
  const stored = world(on, busy())
  const firstAfterHead = async (covered: boolean): Promise<{ row: number; rows: string[] }> => {
    const ui = await mount($, 62, 46, { covered })
    const rows = await rowsOf(ui)
    await ui.unmount()
    return { row: rows.findIndex(r => r.startsWith('  To do') || r.startsWith('  Needs you') || r.includes('Checking a permission')), rows }
  }
  const calm = await firstAfterHead(false)
  expect(calm.rows.join('\n')).not.toContain('Nothing needs you')
  expect(calm.rows[calm.row]!.startsWith('  To do')).toBe(true)
  stored.set('timeline', asked())
  const ask = await firstAfterHead(true)
  expect(ask.row).toBe(calm.row)
  expect(ask.rows[ask.row]!.startsWith('  Needs you')).toBe(true)
  // Auto mode, the prompt not covered, the ask 5 s old: a dim "Checking a permission" in the same row.
  const a = asked()
  stored.set('timeline', { ...a, autoAsk: true, steps: a.steps.map(x => (x.asking !== undefined ? { ...x, asking: NOW - 5_000 } : x)) })
  const checking = await firstAfterHead(false)
  expect(checking.row).toBe(calm.row)
  expect(checking.rows[checking.row]!.trim()).toBe('Checking a permission')
})

test('R45: Now draws nothing for Watch: no rows, no hint, no keys, and the header is unchanged', async ($, on) => {
  world(on, watching())
  for (const surface of SURFACES) {
    const ui = await mount($, 62, 46, { surface })
    const all = walk(await ui.drawn())
    expect(all.filter(n => /^(row-)?(watch-|sec-watch)/.test(keyOf(n))).length).toBe(0)
    const keys = (await ui.findAll({ type: 'Button' })).map(b => (b.props as { hotkey?: string }).hotkey).filter(Boolean)
    expect(keys).not.toContain('x')
    expect(keys).not.toContain('w')
    const rows = await rowsOf(ui)
    expect(rows.join('\n')).not.toMatch(/to watch|Long run|Repeat ·|Loop ·/)
    if (surface !== 'desktop') expect(rows.join('\n')).toContain('WORKING')
    await ui.unmount()
  }
})

test('the height rule deals spare rows to To do, then Notes, then Artifacts, then agent cards (R47)', () => {
  const todo = { floor: 3, want: 7 }
  const agents = { floor: 1, want: 3 }
  const notes = { floor: 1, want: 4 }
  expect(dealRows(0, todo, agents, notes)).toEqual({ todo: 3, cards: 1, notes: 1, arts: 0 })
  expect(dealRows(4, todo, agents, notes)).toEqual({ todo: 7, cards: 1, notes: 1, arts: 0 })
  expect(dealRows(6, todo, agents, notes)).toEqual({ todo: 7, cards: 1, notes: 3, arts: 0 })
  expect(dealRows(7, todo, agents, notes)).toEqual({ todo: 7, cards: 1, notes: 4, arts: 0 })
  expect(dealRows(10, todo, agents, notes)).toEqual({ todo: 7, cards: 2, notes: 4, arts: 0 })
  expect(dealRows(10, todo, agents, notes, { floor: 1, want: 3 })).toEqual({ todo: 7, cards: 1, notes: 4, arts: 3 })
  expect(dealRows(40, todo, agents, notes)).toEqual({ todo: 7, cards: 3, notes: 4, arts: 0 })
})

test('the height rule on a drawn pane (R47, R50): a tall pane shows 14 task rows, every note and 3 cards, Agents at the foot; a short one 3, 1 and 1', async ($, on) => {
  const t = longList()
  const live = Object.fromEntries(['l1', 'l2', 'l3', 'l4', 'l5'].map((id, i) => [id, agent(id, 'Explore', `job ${i + 1}`, NOW - (i + 1) * 60_000)]))
  const notes = Array.from({ length: 6 }, (_, i) => ({ text: `note ${i + 1}`, agent: 'main', at: NOW - (10 - i) * 60_000 }))
  world(on, { ...t, agents: { main: t.agents.main!, ...finished(), ...live }, notes })
  const count = async (rows: number): Promise<{ tasks: number; cards: number; notes: number; height: number; agentsAt: number; drawn: string[] }> => {
    const ui = await mount($, 62, rows, { focused: false })
    const drawn = await rowsOf(ui)
    const keys = walk(await ui.drawn()).map(keyOf)
    await ui.unmount()
    const list = drawn.filter(r => /^(▍ ▸|  ○|  ✓ Follow|    \+ \d+ more to do)/.test(r)).length
    return { tasks: list, cards: keys.filter(k => /^agent-l\d$/.test(k)).length, notes: drawn.filter(r => /^  [★·] /.test(r)).length, height: drawn.length, agentsAt: drawn.findIndex(r => r.startsWith('  Agents')), drawn }
  }
  const tall = await count(80)
  expect(tall.tasks).toBe(14)
  // Every note and busy()'s kept step (★): 7 rows, under the cap of 8.
  expect(tall.notes).toBe(7)
  expect(tall.cards).toBe(3)
  // Agents sits at the foot: after its last row only the last card's empty third row and the pane's last row.
  const last = tall.drawn.map(r => r.trim()).lastIndexOf(tall.drawn.map(r => r.trim()).filter(r => r !== '').at(-1)!)
  expect(tall.agentsAt).toBeGreaterThan(tall.drawn.findIndex(r => r.startsWith('  Notes and decisions')))
  expect(tall.height - 1 - last).toBeLessThanOrEqual(2)
  const short = await count(30)
  expect(short.tasks).toBe(3)
  expect(short.cards).toBe(1)
  expect(short.notes).toBe(1)
})

test('Needs you: amber head and count, the asker\'s critter waiting, the sentence, the tool and command, the words in place of a button (R3); the row takes the focus', async ($, on) => {
  world(on, asked())
  const ui = await mount($, 62, 46, { covered: true })
  const rows = await rowsOf(ui)
  const head = rows.findIndex(r => r.startsWith('  Needs you'))
  expect(rows[head]!.endsWith('1 permission')).toBe(true)
  for (const i of [1, 2, 3]) expect(rows[head + i]!.startsWith('▍ ')).toBe(true)
  expect(rows[head + 1]!.slice(9)).toMatch(/^General asks to run a command +asked 40s ago$/)
  expect(rows[head + 2]!.slice(9)).toBe('Bash  npm run deploy -- --env staging')
  expect(rows[head + 3]!.slice(9)).toBe(' esc  back to the prompt   then allow or deny')
  const found = await ui.findAll({ type: 'Text' })
  const colour = (t: string): string | undefined => (found.find(f => f.text === t)?.props as { color?: string } | undefined)?.color
  expect(colour('Needs you')).toBe('warning')
  expect(colour('Bash')).toBe('warning')
  // R39: the words are one amber filled chip of plain Text (the inverse colour on the amber ground).
  const chip = found.find(f => f.text === ' esc  back to the prompt ')
  expect(chip?.props).toMatchObject({ color: 'inverseText', backgroundColor: 'warning' })
  expect((await ui.find({ key: 'open-asking:s-b1' }))?.props).toMatchObject({ autoFocus: true })
  // No `x` on a permission (owner ruling 4) and no Button that pretends to hand the keys back (R3).
  const buttons = await ui.findAll({ type: 'Button' })
  expect(buttons.some(b => (b.props as { hotkey?: string }).hotkey === 'x')).toBe(false)
  expect(rows.join('\n')).not.toContain('go to prompt')
  // The asker's card waits: amber time and words.
  expect(colour('Waiting for your answer')).toBe('warning')
  await ui.unmount()
})

test('R3: without the keys, the words point at the prompt: "answer in the prompt ↓"', async ($, on) => {
  world(on, asked())
  const ui = await mount($, 62, 46, { covered: true, focused: false })
  const rows = await rowsOf(ui)
  expect(rows.some(r => r.slice(9).startsWith(' answer in the prompt ↓   allow or deny'))).toBe(true)
  expect(rows.join('\n')).not.toContain('back to the prompt')
  await ui.unmount()
})

test('R4: two running steps with the same tool and input: "An agent asks…", the asker not in bold', async ($, on) => {
  const t = asked()
  const twin: Step = { ...t.steps[2]!, id: 's-twin', seq: 102, agent: 'e1', asking: undefined, sig: 'same' }
  world(on, { ...t, steps: [t.steps[0]!, { ...t.steps[2]!, sig: 'same' }, twin] })
  const ui = await mount($, 62, 46, { covered: true })
  const rows = await rowsOf(ui)
  expect(rows.some(r => r.includes('An agent asks to run a command'))).toBe(true)
  const who = (await ui.findAll({ type: 'Text' })).find(f => f.text === 'An agent')
  expect((who?.props as { bold?: boolean } | undefined)?.bold).toBe(undefined)
  await ui.unmount()
})

test('R5: the lead asking pauses the current task: "Paused on", the marker and "paused" in amber', { options: { header: 'full' } }, async ($, on) => {
  const t = asked()
  const lead: Step = step('s-lead', 103, 'main', 'Bash', 'Bash git push', 'running', NOW - 30_000, { asking: NOW - 20_000, turnId: 't1' })
  world(on, { ...t, steps: [t.steps[0]!, t.steps[1]!, lead], agents: { ...t.agents, b1: { ...t.agents.b1!, status: 'done', endedAt: NOW - 60_000 } } })
  const ui = await mount($, 62, 46, { covered: true })
  const rows = await rowsOf(ui)
  expect(rows[6]).toContain('Paused on')
  const cur = rows.find(r => r.startsWith('▍ ▸'))!
  expect(cur.endsWith('paused')).toBe(true)
  await ui.unmount()
})

test('n steps to the next ask when two wait; the footer offers it then', async ($, on) => {
  const t = asked()
  const lead: Step = step('s-lead', 103, 'main', 'Bash', 'Bash git push', 'running', NOW - 30_000, { asking: NOW - 20_000, turnId: 't1' })
  world(on, { ...t, steps: [...t.steps, lead] })
  const ui = await mount($, 62, 46, { covered: true })
  let rows = await rowsOf(ui)
  expect(rows.find(r => r.startsWith('  Needs you'))!.endsWith('2 permissions')).toBe(true)
  expect(rows.some(r => r.includes('General asks to run a command'))).toBe(true)
  expect(rows[rows.length - 1]).toContain('n next ask')
  await ui.press({ key: 'arm-hint-next' })
  rows = await rowsOf(ui)
  expect(rows[rows.findIndex(r => r.startsWith('  Needs you')) + 1]).toContain('Claude asks to run a command')
  await ui.press({ key: 'arm-hint-next' })
  await ui.unmount()
})

// FX3 I-3: the hidden `e` arm of Now at rest. The footer says `e export digest` as text (M5: Artifacts' own words); the press is on the armed Button and reaches the same exportDigest the `/binnacle export` command runs.
test('Now at rest e: the armed hint exports the handoff, the same write /binnacle export makes', async ($, on) => {
  const stored = world(on, { ...idle(), journal: 'sess1' }, initialUi, { USERPROFILE: 'C:/Users/x', OS: 'Windows_NT' })
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
  const ui = await mount($, 62, 46)
  const rows = await rowsOf(ui)
  expect(rows[rows.length - 1]).toContain('e export digest')
  expect(await ui.find({ key: 'arm-hint-export' })).toBeDefined()
  await ui.press({ key: 'arm-hint-export' })
  await ui.unmount()
  expect(writes).toHaveLength(1)
  expect(writes[0]).toMatch(/export-.*\.md$/)
  expect((stored.get('timeline') as Timeline).lastExport?.path.split(String.fromCharCode(92)).join('/')).toBe(writes[0])
  // the command runs the same handler: with the clock held, the same path
  await $.command.run({ command: 'binnacle', args: 'export' } as never)
  expect(writes).toHaveLength(2)
  expect(writes[1]).toBe(writes[0])
})

test('pressing the need opens its step in place', async ($, on) => {
  const stored = world(on, asked())
  on('fs.read', () => {
    throw new Error('ENOENT')
  })
  const ui = await mount($, 62, 46, { covered: true })
  await ui.press({ key: 'open-asking:s-b1' })
  expect(uiOf(stored).tab).toBe('timeline')
  expect(uiOf(stored).stepOpen).toBe('s-b1')
  await ui.unmount()
})

// ---------- Watch ----------

test('R45: a Watch row is dismissed from slim, and Now stays silent before and after', async ($, on) => {
  const stored = world(on, watching())
  const now = await mount($)
  expect((await rowsOf(now)).join('\n')).not.toContain('to watch')
  await now.unmount()
  const slim = await mount($, 28, 46)
  expect((await rowsOf(slim)).join('\n')).toContain('to watch')
  await slim.press({ key: 'slim-watch' })
  await slim.unmount()
  expect(uiOf(stored).dismissed.length).toBe(0)
})

test('Watch: the long runner\'s time on its card is bold, never amber (R6)', async ($, on) => {
  world(on, watching())
  const ui = await mount($)
  const t = (await ui.findAll({ type: 'Text' })).find(f => f.text === '1 h 4 min')
  expect(t?.props).toMatchObject({ bold: true })
  expect((t?.props as { color?: string }).color).toBe(undefined)
  await ui.unmount()
})

// ---------- the header (R7, R8, R12) ----------

// I-3 (meaning changed): quiet is R6's, no step running; the running steps here ended `ms` ago and the agents run on with nothing in flight.
test('R7: after 2 min with no activity the header reads "· quiet n min", dim; bold past 5 min', { options: { header: 'full' } }, async ($, on) => {
  const t = busy()
  const still = (ms: number): Timeline => ({
    ...t,
    steps: t.steps.map(s => (s.status === 'running' ? { ...s, status: 'done' as const, startedAt: Math.min(s.startedAt, NOW - ms - 1000), endedAt: NOW - ms } : { ...s, startedAt: Math.min(s.startedAt, NOW - ms - 1000), ...(s.endedAt !== undefined ? { endedAt: Math.min(s.endedAt, NOW - ms) } : {}) })),
    agents: Object.fromEntries(Object.entries(t.agents).map(([k, a]) => [k, { ...a, startedAt: Math.min(a.startedAt, NOW - ms), ...(a.lastStepAt !== undefined ? { lastStepAt: Math.min(a.lastStepAt, NOW - ms) } : {}), ...(a.endedAt !== undefined ? { endedAt: Math.min(a.endedAt, NOW - ms) } : {}) }])),
    turns: t.turns.map(x => ({ ...x, startedAt: Math.min(x.startedAt, NOW - ms) })),
  })
  const stored = world(on, still(3 * 60_000))
  let ui = await mount($)
  let quiet = (await ui.findAll({ type: 'Text' })).find(f => (f.text ?? '').startsWith('quiet '))
  expect(quiet?.text).toBe('quiet 3 min')
  expect(quiet?.props).toMatchObject({ dimColor: true })
  await ui.unmount()
  stored.set('timeline', still(6 * 60_000))
  ui = await mount($)
  quiet = (await ui.findAll({ type: 'Text' })).find(f => (f.text ?? '').startsWith('quiet '))
  expect(quiet?.text).toBe('quiet 6 min')
  expect(quiet?.props).toMatchObject({ bold: true })
  await ui.unmount()
})

// BEHAVIOUR CHANGE (task C3b, item 4): was "cache stays warm m:ss" (2:51, jumping 10 s at a time); the countdown is whole minutes now.
test('R29 and R40: the cache countdown shows at idle only, in whole minutes: "cache warm 2 min"', { options: { header: 'full' } }, async ($, on) => {
  const stored = world(on, idle())
  let ui = await mount($)
  const line = (await rowsOf(ui))[10]!
  expect(line).toContain('cache warm 2 min')
  expect(line).not.toMatch(/\d:\d\d/)
  await ui.unmount()
  stored.set('timeline', busy())
  ui = await mount($)
  expect((await rowsOf(ui)).join('\n')).not.toContain('cache')
  await ui.unmount()
})

test('the warm words are N min while at least a minute is left, and "under 1 min" near the end (R40)', { options: { header: 'full' } }, async ($, on) => {
  // 12 s after the last reply of a 5 min cache: 4 min 48 s left.
  const stored = world(on, { ...idle(), cache: { at: NOW - 12_000 } })
  let ui = await mount($)
  expect((await rowsOf(ui))[10]).toContain('cache warm 4 min')
  await ui.unmount()
  // 250 s after it: 50 s left.
  stored.set('timeline', { ...idle(), cache: { at: NOW - 250_000 } })
  ui = await mount($)
  const near = (await rowsOf(ui))[10]!
  expect(near).toContain('cache warm under 1 min')
  expect(near).not.toMatch(/\d:\d\d/)
  await ui.unmount()
})

test('warmWords: whole minutes rounded down, "under 1 min" in the last minute, never m:ss', () => {
  expect(warmWords(288_000)).toBe('4 min')
  expect(warmWords(171_000)).toBe('2 min')
  expect(warmWords(60_000)).toBe('1 min')
  expect(warmWords(59_999)).toBe('under 1 min')
  expect(warmWords(1000)).toBe('under 1 min')
  expect(warmWords(0)).toBe('under 1 min')
  expect(warmWords(-5000)).toBe('under 1 min')
  expect(warmWords(3_600_000)).toBe('60 min')
  for (const ms of [0, 1000, 59_000, 61_000, 171_000, 299_000, 3_599_000]) expect(warmWords(ms)).not.toMatch(/\d:\d\d/)
})

// ---------- presses ----------

test('a card opens its agent\'s page and b comes back to it; the To do and Agents titles open their tabs; a task row its page', async ($, on) => {
  const stored = world(on, busy())
  for (const surface of SURFACES) {
    stored.set('ui', initialUi)
    const ui = await mount($, 62, 46, { surface })
    LOGS.length = 0
    await ui.press({ key: 'agent-e1' })
    expect(uiOf(stored).page).toEqual({ kind: 'agent', id: 'e1', from: 'agent-e1' })
    await ui.redraw()
    await ui.press({ key: 'page-back' })
    expect(uiOf(stored).page).toBeUndefined()
    expect(backTo()).toEqual(['agent-e1'])
    await ui.redraw()
    await ui.press({ key: 'task-main-10' })
    expect(uiOf(stored).page).toEqual({ kind: 'task', id: 'main:10', from: 'task-main-10' })
    await ui.unmount()
    for (const [key, tab] of [['sec-todo', 'tasks'], ['sec-agents', 'agents'], ['agents-finished', 'agents']] as const) {
      stored.set('ui', initialUi)
      const again = await mount($, 62, 46, { surface })
      await again.press({ key })
      expect([key, uiOf(stored).tab]).toEqual([key, tab])
      await again.unmount()
    }
  }
})

test('a kept decision opens its step page; the budget line opens the budget view and b comes back', async ($, on) => {
  const stored = world(on, busy())
  on('fs.read', () => {
    throw new Error('ENOENT')
  })
  const ui = await mount($)
  await ui.press({ key: 'kept-k1' })
  expect(uiOf(stored).page).toEqual({ kind: 'step', id: 'k1', from: 'kept-k1' })
  await ui.unmount()
  stored.set('ui', initialUi)
  const b = await mount($)
  await b.press({ key: 'now-budget' })
  await b.redraw()
  expect(await b.find({ type: 'Button', key: 'arm-hint-back' })).toBeTruthy()
  await b.press({ key: 'arm-hint-back' })
  await b.redraw()
  expect((await rowsOf(b)).some(r => r.startsWith('  To do'))).toBe(true)
  await b.unmount()
})

// R3-B I4: meaning changed. It used to press the Svg's own "To do" Button row; that row repeated the tab bar and is gone, so the test now holds that the header Svg stands alone and the tab bar is the way to Tasks.
test('the desktop app keeps the Svg deck in the header place with no button row under it; the tab bar opens Tasks', async ($, on) => {
  const stored = world(on, busy())
  const ui = await mount($, 62, 46, { surface: 'desktop' })
  expect((await ui.findAll({ type: 'Svg' })).length).toBe(1)
  const keys = (await ui.findAll({ type: 'Button' })).map(b => String(b.key))
  expect(keys.filter(k => k.startsWith('deck-'))).toEqual([])
  await ui.press({ key: 'tab-tasks' })
  expect(uiOf(stored).tab).toBe('tasks')
  await ui.unmount()
})

// ---------- fit ----------

test('every row fits bodyColumns at 62, 50, 40 and 32, and nothing but the marker enters the side gutters', async ($, on) => {
  const stored = world(on, busy())
  for (const t of [busy(), asked(), watching(), idle(), longList()]) {
    stored.set('timeline', t)
    for (const cols of [62, 50, 40, 32]) {
      for (const surface of ['vscode', 'terminal'] as const) {
        const ui = await mount($, cols, 46, { covered: true, surface })
        const rows = await rowsOf(ui)
        await ui.unmount()
        rows.forEach((r, i) => {
          expect([cols, i, r.length <= cols]).toEqual([cols, i, true])
          // Rows 0 to 2 are the tab bar; the frame's lintel and sill are the full width by design.
          if (i < 3 || /^[┏─]/.test(r)) return
          expect([cols, i, r.slice(0, 2).replace('▍', '').trim()]).toEqual([cols, i, ''])
          expect([cols, i, r.slice(cols - 2).trim()]).toEqual([cols, i, ''])
        })
      }
    }
  }
})
