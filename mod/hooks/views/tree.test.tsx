import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { AgentRow, Timeline, UiState } from '../../types'
import { empty } from '../model/reduce'
import { NOW, agent, flaggedSession, mapSession, step } from './agents.fixtures.testkit'
import { hueHex } from './crewnode'
import { backTo, colOf, keepLog, LOGS, screen } from './screen.testkit'

// The crew map rules (crew spec "Crew map rules", re-laid per R26): each rule
// has its test. The fidelity of the whole board is agents.fidelity.test.tsx.

/** The text look on every surface: the critters draw as their text forms. */
const TEXT = { options: { look: 'text' } } as const
const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
const SHAPES: Record<string, string> = { timeline: 'timeline-4', ui: 'ui-4' }

type Stored = Map<string, unknown>

function world(on: On, t: Timeline, u: UiState): Stored {
  const stored: Stored = new Map<string, unknown>([['timeline', t], ['ui', u]])
  const versions = new Map<string, number>()
  mock.clock(on, { now: NOW })
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

const MAP_UI: UiState = {
  tab: 'agents', filter: { kind: 'all' }, agentsMode: 'tree', folded: [], openTurns: [],
  dismissed: [], query: '', runningOnly: false, notified: [], toasted: [], slim: false,
}

const PANE = (columns: number, focused: boolean, bodyRows: number) =>
  ({
    plugin: 'binnacle',
    component: 'Pane',
    requestId: 'binnacle',
    props: { title: 'Binnacle', isFocused: focused, bodyColumns: columns, placement: 'dock', scroll: { offset: 0, bodyRows }, view: {} },
  }) as const

async function mount($: Engine, surface: (typeof SURFACES)[number] = 'terminal', columns = 62, focused = false, bodyRows = 60) {
  return $.ui.mount({ ...PANE(columns, focused, bodyRows), surface })
}
type Mounted = Awaited<ReturnType<typeof mount>>
type Found = Awaited<ReturnType<Mounted['findAll']>>[number]
const propsOf = (f: Found | undefined): { color?: string; dimColor?: boolean; bold?: boolean } =>
  (f?.props ?? {}) as { color?: string; dimColor?: boolean; bold?: boolean }
const rows = async (ui: Mounted): Promise<string[]> => screen(await ui.drawn())
const rowWith = (all: string[], text: string): string => all.find(r => r.includes(text)) ?? ''
const idxWith = (all: string[], text: string): number => all.findIndex(r => r.includes(text))
const rasters = async (ui: Mounted): Promise<{ key: string; columns: number; rows: number }[]> =>
  (await ui.findAll({ type: 'Raster' })).map(r => {
    const p = (r.props ?? {}) as { key?: string; columns?: number; rows?: number }
    return { key: String(p.key), columns: p.columns ?? 0, rows: p.rows ?? 0 }
  })
const characters = async (ui: Mounted) => (await rasters(ui)).filter(r => r.key.startsWith('who-')).map(r => [r.key, r.columns, r.rows])

// ---------- rule 1: only working agents get a character ----------

test('rule 1: only the lead and the working agent are characters (6 x 3 with the badge column); no done agent is', async ($, on) => {
  world(on, mapSession(), MAP_UI)
  const ui = await mount($)
  expect(await characters(ui)).toEqual([
    ['who-node-main', 6, 3],
    ['who-node-live', 6, 3],
  ])
  await ui.unmount()
})

test('rule 1: a waiting agent is a character too, a failed one a micro (5 x 2); everyone else folds', async ($, on) => {
  world(on, flaggedSession(), MAP_UI)
  const ui = await mount($)
  const got = await characters(ui)
  expect(got).toContainEqual(['who-node-ask', 6, 3])
  expect(got).toContainEqual(['who-node-boom', 5, 2])
  expect(got.map(g => g[0]).sort()).toEqual(['who-node-ask', 'who-node-boom', 'who-node-live', 'who-node-main'])
  await ui.unmount()
})

test('a surface without Raster draws the critters as their text forms and no Raster at all', async ($, on) => {
  world(on, flaggedSession(), MAP_UI)
  for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
    const ui = await mount($, surface)
    expect(await rasters(ui)).toEqual([])
    const all = await rows(ui)
    expect(all.some(r => /^ {2}● {6}Claude/.test(r))).toBe(true)
    await ui.unmount()
  }
})

// ---------- rule 2: done agents fold ----------

test('rule 2: a done task is one row; its agents are pips in their role hues and `+ n done`, never a character or a row', TEXT, async ($, on) => {
  world(on, mapSession(), MAP_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const all = await rows(ui)
    const t11 = rowWith(all, '11 Add limiter')
    expect(t11).toContain('▪▪▪▪▪▪ + 6 done')
    // none of the six agents has a row of its own
    expect(all.join('\n')).not.toContain('scout job t11')
    expect(all.filter(r => r.includes('+ 6 done')).length).toBe(1)
    const found = await ui.findAll({ type: 'Text' })
    // two scouts, three builders, one checker: teal, iris, orchid
    const pips = found.filter(f => /^▪+$/.test(f.text ?? '') && (f.text ?? '').length > 1 && f.props?.color !== undefined)
    const at = (hue: 'scout' | 'build' | 'check', n: number) => pips.some(p => p.text === '▪'.repeat(n) && propsOf(p).color === hueHex(hue === 'build' ? 'build' : hue))
    expect(at('scout', 2) && at('build', 3)).toBe(true)
    expect(found.some(f => f.text === '▪' && propsOf(f).color === hueHex('check'))).toBe(true)
    await ui.unmount()
  }
})

test('rule 2: the working task keeps its done agents as a chip under its working one: ╰╌ + 3 done, pips, "done", their sums', TEXT, async ($, on) => {
  world(on, mapSession(), MAP_UI)
  const ui = await mount($)
  const all = await rows(ui)
  const chip = rowWith(all, '+ 3 done')
  expect(chip).toMatch(/^ {4}│ {2}╰╌ \+ 3 done {14}▪▪▪ done {7}78k {4}13 min$/)
  // the chip sits last under the live agent's three rows, on the tether
  const live = idxWith(all, 'wire limiter')
  expect(all[live]).toMatch(/^ {4}│ {2}├╌ /)
  expect(all[live + 3]).toBe(chip)
  await ui.unmount()
})

test('rule 2: the done agents carry their sums on the group row, the done counts in a column', TEXT, async ($, on) => {
  world(on, mapSession(), MAP_UI)
  const ui = await mount($)
  const all = await rows(ui)
  expect(rowWith(all, '9 Redis adapter')).toMatch(/▪▪▪▪ \+ 4 done {3}74k {4}12 min$/)
  expect(rowWith(all, '5 Read the middleware')).toMatch(/▪▪ \+ 2 done {3}22k {5}3 min$/)
  expect(rowWith(all, 'no task')).toMatch(/◇ no task {15}▪▪▪▪ \+ 4 done {3}38k {5}6 min$/)
  await ui.unmount()
})

// ---------- rule 3: three bands ----------

test('rule 3: the bands read Doing now, Up next, Done, top-down, in plain words; a queued task is drawn only under Up next', TEXT, async ($, on) => {
  world(on, mapSession(), MAP_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const all = await rows(ui)
    const [now, next, done] = ['Doing now', 'Up next', 'Done'].map(w => idxWith(all, `│  ${w}`))
    expect([now, next, done].every(i => (i ?? -1) >= 0)).toBe(true)
    expect(now! < next! && next! < done!).toBe(true)
    const queued = idxWith(all, '13 Document the limits')
    expect(queued > next! && queued < done!).toBe(true)
    expect(idxWith(all, 'no task') > next! && idxWith(all, 'no task') < done!).toBe(true)
    // the working task is under Doing now; the done tasks under Done, newest first
    expect(idxWith(all, '12 Wire limiter') > now! && idxWith(all, '12 Wire limiter') < next!).toBe(true)
    const order = ['11 Add', '10 Token', '9 Redis', '8 Upload', '7 Error', '6 Fixtures', '5 Read'].map(x => idxWith(all, x))
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(order[0]).toBeGreaterThan(done!)
    // no caps labels, no live
    expect(all.join('\n')).not.toMatch(/\b(NOW|DONE|NEXT|TOTAL|STATE|TOKENS|TIME|CREW MAP)\b|\blive\b/)
    await ui.unmount()
  }
})

test('rule 3: a task with a working agent is under Doing now, with "1 working"; the trunk ends on the last row', TEXT, async ($, on) => {
  world(on, mapSession(), MAP_UI)
  const ui = await mount($)
  const all = await rows(ui)
  expect(rowWith(all, '12 Wire limiter')).toContain('1 working')
  expect(all[idxWith(all, '5 Read the middleware')]).toMatch(/^ {4}╰─ ▪ /)
  expect(all.filter(r => r.startsWith('    ╰─'))).toHaveLength(1)
  await ui.unmount()
})

// ---------- rule 4 and 5: indents and the table ----------

test('rule 4: trunk at 4, task marks at 7 and names at 9, tethers at 7, agents at 10 and their names at 17', TEXT, async ($, on) => {
  world(on, mapSession(), MAP_UI)
  const ui = await mount($)
  const all = await rows(ui)
  const task = rowWith(all, '12 Wire limiter')
  expect([colOf(task, '├'), colOf(task, '▸'), colOf(task, '12 Wire')]).toEqual([4, 7, 9])
  const live = rowWith(all, 'wire limiter')
  expect([colOf(live, '│'), colOf(live, '├╌'), colOf(live, '●'), colOf(live, 'wire limiter')]).toEqual([4, 7, 10, 17])
  expect(colOf(rowWith(all, 'Claude'), 'Claude')).toBe(9)
  await ui.unmount()
})

test('rule 5 (R26): the right side is a table: state from 36, tokens ending at 49, time ending at 59, on every row', TEXT, async ($, on) => {
  world(on, mapSession(), MAP_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const all = await rows(ui)
    const head = rowWith(all, 'Crew map')
    expect([colOf(head, 'State'), colOf(head, 'Tokens') + 'Tokens'.length - 1, colOf(head, 'Time') + 'Time'.length - 1]).toEqual([36, 49, 59])
    for (const [text, state, tokens, time] of [
      ['Claude', 'working', '184k', '1h 48m'],
      ['12 Wire limiter', '1 working', '96k', '14 min'],
      ['wire limiter', 'working', '18k', '48s'],
      ['+ 3 done', 'done', '78k', '13 min'],
      ['13 Document', 'queued', '', ''],
      ['11 Add', '+ 6 done', '141k', '22 min'],
      ['Total', '34 done', '832k', '1h 48m'],
    ] as const) {
      const r = rowWith(all, text)
      expect([text, r.lastIndexOf(state)]).toEqual([text, 36])
      if (tokens !== '') expect([text, colOf(r, tokens) + tokens.length - 1]).toEqual([text, 49])
      if (time !== '') expect([text, r.length - 1]).toEqual([text, 59])
    }
    await ui.unmount()
  }
})

test('rule 5: the total row closes the map: Total, the agents and tasks counted, the done count, the sums', TEXT, async ($, on) => {
  world(on, mapSession(), MAP_UI)
  const ui = await mount($)
  const all = await rows(ui)
  const total = all.filter(r => r.startsWith('  Total'))
  expect(total).toHaveLength(1)
  // R3-B M1: meaning changed. The total counts every task of the fixture (9, tasks 5 to 13); it counted the 8 an agent worked on.
  expect(total[0]).toContain('35 agents · 9 tasks')
  expect(all.indexOf(total[0]!)).toBeGreaterThan(idxWith(all, '5 Read the middleware'))
  await ui.unmount()
})

test('rule: 35 agents fit 33 rows at 62 columns, footer and tabs included', TEXT, async ($, on) => {
  world(on, mapSession(), MAP_UI)
  const ui = await mount($, 'terminal', 62, true, 33)
  const all = await rows(ui)
  expect(all.length).toBeLessThanOrEqual(33)
  expect(all[all.length - 1]).toContain('↵ open')
  await ui.unmount()
})

test('narrow tiers: nothing is wider than the pane at 62, 56, 50, 40 and 32; the state goes under 56 and the tokens under 46; names are cut at a word', TEXT, async ($, on) => {
  world(on, flaggedSession(), MAP_UI)
  for (const columns of [62, 56, 50, 40, 32]) {
    const ui = await mount($, 'terminal', columns, true)
    const all = await rows(ui)
    for (const r of all) expect(r.length).toBeLessThanOrEqual(columns)
    const task = rowWith(all, '12 Wire')
    expect(task.trimEnd().length).toBe(columns - 3 + 1)
    if (columns < 56) expect(task).not.toContain('1 working')
    else expect(colOf(task, '1 working')).toBe(columns - 3 - 23)
    if (columns < 46) expect(task).not.toContain('96k')
    // a name cut with … ends at a whole word of the task's subject
    const name = task.slice(9).split(/ {2,}/)[0] ?? ''
    if (name.endsWith('…')) {
      const kept = name.slice(0, -1).replace(/^12 /, '')
      expect('Wire limiter into the chain'.startsWith(kept)).toBe(true)
      expect('Wire limiter into the chain'[kept.length]).toBe(' ')
    }
    await ui.unmount()
  }
})

// ---------- rule 6: flags climb ----------

test('rule 6: a waiting or failed agent is never folded; its task moves to Doing now; ? and ! are in column 0 on the map only', TEXT, async ($, on) => {
  world(on, flaggedSession(), MAP_UI)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const all = await rows(ui)
    const now = idxWith(all, '│  Doing now')
    const next = idxWith(all, '│  Up next')
    // the failed agent's task (11) climbed from Done to Doing now, and the waiting one's (13) from Up next
    expect(idxWith(all, '11 Add limiter')).toBeLessThan(next)
    expect(idxWith(all, '11 Add limiter')).toBeGreaterThan(now)
    expect(idxWith(all, '13 Document')).toBeLessThan(next)
    const ask = rowWith(all, 'deploy to staging')
    const boom = rowWith(all, 'read the config')
    expect([ask.startsWith('? '), boom.startsWith('! ')]).toEqual([true, true])
    // only those two rows carry a gutter flag
    expect(all.filter(r => /^[!?z] /.test(r))).toHaveLength(2)
    // the rest of task 11 still folds under its failed agent
    expect(all.join('\n')).toContain('+ 6 done')
    await ui.unmount()
  }
})

test('rule 6: the list has no gutter flags (R26): the badge sits on the critter', TEXT, async ($, on) => {
  world(on, flaggedSession(), { ...MAP_UI, agentsMode: 'list' })
  const ui = await mount($)
  const all = await rows(ui)
  expect(all.filter(r => /^[!?z] /.test(r))).toEqual([])
  expect(all.some(r => /^ {2}● {4}\? Builder/.test(r))).toBe(true)
  expect(all.some(r => /^ {2}× {3}! {2}Explorer/.test(r))).toBe(true)
  await ui.unmount()
})

test('rule 6: the flags are drawn in warning and error', TEXT, async ($, on) => {
  world(on, flaggedSession(), MAP_UI)
  const ui = await mount($)
  const found = await ui.findAll({ type: 'Text' })
  expect(found.filter(f => f.text === '?').map(f => propsOf(f).color)).toContain('warning')
  expect(found.filter(f => f.text === '!').map(f => propsOf(f).color)).toContain('error')
  await ui.unmount()
})

// I-2 (meaning changed): the map reads Now's needs, which take no dismissal (owner ruling 4: no `x` on a permission), so the ? stays, as on Now.
test('a dismissed ask still shows its ? on the map, as on Now', TEXT, async ($, on) => {
  world(on, flaggedSession(), { ...MAP_UI, dismissed: ['asking:s-ask'] })
  const ui = await mount($)
  expect((await rows(ui)).filter(r => r.startsWith('? ')).length).toBe(1)
  await ui.unmount()
})

// ---------- failed: a micro critter with a red ! and its reason ----------

test('a failed agent on the map is a micro critter with a red !, its name in bold, "failed" and its reason', TEXT, async ($, on) => {
  world(on, flaggedSession(), MAP_UI)
  const ui = await mount($)
  const all = await rows(ui)
  const at = idxWith(all, 'read the config')
  expect(all[at]).toMatch(/^! {3}│ {2}├╌ × {3}! {2}read the config…? +failed/)
  expect(colOf(all[at + 1]!, 'Stopped: the schema file is missing')).toBe(17)
  // R43 (F M8): no role word under the glyph, the name stands beside it.
  expect(all[at + 1]).not.toContain('scout')
  const found = await ui.findAll({ type: 'Text' })
  expect(found.filter(f => f.text === '!').map(f => propsOf(f).color)).toContain('error')
  expect(found.filter(f => (f.text ?? '').startsWith('read the')).map(f => propsOf(f).bold)).toContain(true)
  await ui.unmount()
})

// ---------- R23: the role word is the real type ----------

test('R23: an agent\'s second line is its real type in friendly case and its model, never the hat', TEXT, async ($, on) => {
  const t: Timeline = {
    ...empty,
    now: { focus: 'Working', at: NOW },
    agents: {
      main: { ...empty.agents.main! },
      g1: agent('g1', 'general-purpose', 'write the tests', NOW - 60_000, { model: 'claude-sonnet-5' }),
      c1: agent('c1', 'code-reviewer', 'review the limiter', NOW - 50_000, { model: 'claude-opus-5-5' }),
      m1: agent('m1', 'mystery-agent', 'do a thing', NOW - 40_000),
    },
    steps: [step('s1', 1, 'g1', 'Edit', 'Edit a.ts', 'running', NOW - 5000)],
  }
  world(on, t, MAP_UI)
  const ui = await mount($)
  const all = await rows(ui)
  expect(rowWith(all, 'General · sonnet')).toBeTruthy()
  expect(rowWith(all, 'Code reviewer · opus')).toBeTruthy()
  expect(rowWith(all, 'Mystery agent')).toBeTruthy()
  expect(all.join('\n')).not.toMatch(/ build · | check · | scout · /)
  await ui.unmount()
})

// ---------- rule 7: d unfolds ----------

test('rule 7: d unfolds every done group: one row each with a pip, its real type and its job, still no characters', TEXT, async ($, on) => {
  const stored = world(on, mapSession(), { ...MAP_UI, folded: ['open:all'] })
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const all = await rows(ui)
    const rowsOf11 = all.filter(r => /^ {4}[│ ] {2}[├╰]╌ ▪ /.test(r))
    // 6 + 5 + 4 + 4 + 3 + 3 + 2 done agents under tasks, 3 under the working one
    expect(rowsOf11.length).toBe(27 + 3 + 4)
    expect(all.join('\n')).not.toContain('+ 6 done                 ')
    await ui.unmount()
  }
  expect(stored.get('ui')).toBeDefined()
})

test('rule 7: unfolded rows draw no characters: the lead and the working agent are the only ones', async ($, on) => {
  world(on, mapSession(), { ...MAP_UI, folded: ['open:all'] })
  const ui = await mount($)
  expect(await characters(ui)).toEqual([['who-node-main', 6, 3], ['who-node-live', 6, 3]])
  await ui.unmount()
})

test('rule 7: pressing d writes open:all (and folds them again); the hint reads unfold done, then fold done', async ($, on) => {
  const stored = world(on, mapSession(), MAP_UI)
  const ui = await mount($, 'terminal', 62, true)
  expect(rowWith(await rows(ui), '↵ open')).toContain('d unfold done')
  await ui.press({ key: 'arm-hint-unfold' })
  expect((stored.get('ui') as UiState).folded).toEqual(['open:all'])
  await ui.redraw()
  expect(rowWith(await rows(ui), '↵ open')).toContain('d fold done')
  await ui.press({ key: 'arm-hint-unfold' })
  expect((stored.get('ui') as UiState).folded).toEqual([])
  await ui.unmount()
})

test('rule 7: a press on a done task or a chip unfolds that one group; the rest stay folded', TEXT, async ($, on) => {
  const stored = world(on, mapSession(), MAP_UI)
  let ui = await mount($)
  await ui.press({ key: 'group-task:11' })
  expect((stored.get('ui') as UiState).folded).toEqual(['open:task:11'])
  await ui.unmount()
  ui = await mount($)
  const all = await rows(ui)
  expect(rowWith(all, '11 Add limiter')).toContain('▾')
  expect(all.filter(r => /^ {4}[│ ] {2}[├╰]╌ ▪ /.test(r))).toHaveLength(6)
  expect(rowWith(all, '10 Token bucket')).toContain('▪▪▪▪▪ + 5 done')
  await ui.press({ key: 'group-task:11' })
  expect((stored.get('ui') as UiState).folded).toEqual([])
  await ui.press({ key: 'chip:task:12' })
  expect((stored.get('ui') as UiState).folded).toEqual(['open:task:12'])
  await ui.unmount()
})

test('a stored fold key of an older version is ignored: only open: keys unfold', TEXT, async ($, on) => {
  world(on, mapSession(), { ...MAP_UI, folded: ['task:11', 'main', 'r1'] })
  const ui = await mount($)
  expect(rowWith(await rows(ui), '11 Add limiter')).toContain('+ 6 done')
  await ui.unmount()
})

// ---------- r: working only ----------

test('r (Working only) keeps only the groups with a working or flagged agent and no folded chips', TEXT, async ($, on) => {
  world(on, flaggedSession(), { ...MAP_UI, runningOnly: true })
  const ui = await mount($)
  const all = await rows(ui)
  expect(all.join('\n')).toContain('12 Wire limiter')
  expect(all.join('\n')).toContain('deploy to staging')
  expect(all.join('\n')).not.toContain('Redis adapter')
  expect(all.join('\n')).not.toContain('│  Done')
  expect(all.join('\n')).not.toContain('+ 3 done')
  await ui.unmount()
})

test('the Working only toggle writes ui.runningOnly from the map', async ($, on) => {
  const stored = world(on, mapSession(), MAP_UI)
  const ui = await mount($)
  await ui.press({ key: 'mode-running' })
  expect((stored.get('ui') as UiState).runningOnly).toBe(true)
  await ui.press({ key: 'mode-tree' })
  expect((stored.get('ui') as UiState).agentsMode).toBe('tree')
  await ui.unmount()
})

// ---------- presses and keys ----------

test('Enter on an agent node opens its page and b returns to the map with the node focused; main opens its own page', async ($, on) => {
  const stored = world(on, mapSession(), MAP_UI)
  const ui = await mount($)
  await ui.press({ key: 'node-live' })
  expect((stored.get('ui') as UiState).page).toEqual({ kind: 'agent', id: 'live', from: 'node-live' })
  await ui.redraw()
  await ui.press({ key: 'page-back' })
  expect(backTo()).toEqual(['node-live'])
  await ui.redraw()
  await ui.press({ key: 'node-main' })
  expect((stored.get('ui') as UiState).page).toEqual({ kind: 'agent', id: 'main', from: 'node-main' })
  await ui.unmount()
})

test('n and p visit the flagged agents, wrapping; no flagged agent, no n or p', async ($, on) => {
  const stored = world(on, flaggedSession(), MAP_UI)
  const ui = await mount($, 'terminal', 62, true)
  expect(rowWith(await rows(ui), '↵ open')).toContain('n next flag')
  await ui.press({ key: 'arm-hint-next' })
  const first = (stored.get('ui') as UiState).agentOpen
  await ui.press({ key: 'arm-hint-next' })
  const second = (stored.get('ui') as UiState).agentOpen
  await ui.press({ key: 'arm-hint-next' })
  expect([first, second].sort()).toEqual(['ask', 'boom'])
  expect((stored.get('ui') as UiState).agentOpen).toBe(first)
  await ui.press({ key: 'arm-hint-prev' })
  expect((stored.get('ui') as UiState).agentOpen).toBe(second)
  await ui.unmount()
})

test('the footer reads ↵ open, d unfold done, r working only, esc prompt (one notation, no colons), and keeps its row, blank, while unfocused', TEXT, async ($, on) => {
  world(on, mapSession(), MAP_UI)
  let ui = await mount($, 'terminal', 62, false)
  const blurred = await rows(ui)
  expect(blurred.join('\n')).not.toContain('↵ open')
  await ui.unmount()
  ui = await mount($, 'terminal', 62, true)
  const focused = await rows(ui)
  expect(rowWith(focused, '↵ open')).toBe('  ↵ open   d unfold done   r working only   esc prompt')
  expect(focused.length).toBe(blurred.length)
  await ui.unmount()
})

// ---------- empty and idle ----------

test('only main: the empty-state note, and nothing running when r is on', TEXT, async ($, on) => {
  const stored = world(on, { ...empty, agents: { main: { ...empty.agents.main! } } }, MAP_UI)
  let ui = await mount($)
  let all = await rows(ui)
  expect(all.map(r => r.trim()).join(' ')).toContain('No agents yet.')
  expect(all.join('\n')).not.toContain('Total')
  await ui.unmount()
  stored.set('timeline', mapSession())
  stored.set('ui', { ...MAP_UI, runningOnly: true })
  const done: Timeline = { ...mapSession(), agents: Object.fromEntries(Object.entries(mapSession().agents).filter(([id]) => id !== 'live')), steps: [] }
  stored.set('timeline', done)
  ui = await mount($)
  all = await rows(ui)
  expect(all.join('\n')).toContain('Nothing is running.')
  await ui.unmount()
})

test('a done agent with a running child under it stays drawn through its child', TEXT, async ($, on) => {
  const base = mapSession()
  const t: Timeline = { ...base, agents: { ...base.agents, kid: agent('kid', 'builder', 'child job', NOW - 30_000, { parent: 'live', taskId: '12' }) } }
  world(on, t, MAP_UI)
  const ui = await mount($)
  const all = await rows(ui)
  // nested agents are flattened under their task (one indent per level)
  expect(colOf(rowWith(all, 'child job'), 'child job')).toBe(17)
  await ui.unmount()
})

test('every agent in the map has a distinct key', async ($, on) => {
  const t = mapSession()
  const same: AgentRow[] = [agent('s1', 'Explore', 'same', NOW - 20_000, {}), agent('s2', 'Explore', 'same', NOW - 20_000, {})]
  world(on, { ...t, agents: { ...t.agents, s1: same[0]!, s2: same[1]! } }, MAP_UI)
  const ui = await mount($)
  expect(await ui.find({ key: 'node-s1' })).toBeDefined()
  expect(await ui.find({ key: 'node-s2' })).toBeDefined()
  await ui.unmount()
})
