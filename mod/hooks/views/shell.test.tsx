import { expect, mock, test } from 'claude-code/testing'
import type { On, Register } from 'claude-code'

import type { Timeline, UiState } from '../../types'
import { empty } from '../model/reduce'
import { initialUi } from '../state'
import { colOf, screen } from './screen.testkit'

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
const SHAPES: Record<string, string> = { timeline: 'timeline-4', ui: 'ui-4' }

type Stored = Map<string, unknown>

function world(on: On, t: Timeline, u?: UiState, shapes: Record<string, string> = SHAPES, placed = true): { stored: Stored; opened: Record<string, unknown>[] } {
  const stored: Stored = new Map()
  // A key the mod has written is held under the current shape, as the engine does.
  const written = new Set<string>()
  stored.set('timeline', t)
  if (u) stored.set('ui', u)
  const versions = new Map<string, number>()
  const opened: Record<string, unknown>[] = []
  mock.clock(on, { now: 1_000_000 })
  on('ui.log', () => ({ value: undefined }))
  on('state.get', (_, e) => {
    const key = (e as { key: string }).key
    const v = stored.get(key)
    return {
      value: {
        value: v === undefined ? undefined : { shape: written.has(key) ? SHAPES[key] : shapes[key], value: v },
        version: versions.get(key) ?? 0,
      },
    }
  })
  on('state.set', (_, e) => {
    const w = e as unknown as { key: string; value: { value: unknown } }
    const version = (versions.get(w.key) ?? 0) + 1
    versions.set(w.key, version)
    written.add(w.key)
    stored.set(w.key, w.value.value)
    return { value: { isSet: true as const, version } }
  })
  on('ui.open', (_, e) => {
    opened.push(e as unknown as Record<string, unknown>)
    return { value: placed ? { isPlaced: true as const } : { isPlaced: false as const, reason: 'narrow' } }
  })
  on('ui.close', () => ({ value: undefined }))
  return { stored, opened }
}

const run = ($: { command: { run: (a: never) => Promise<{ text?: string }> } }, args: string) =>
  $.command.run({ command: 'mc', args } as never)

const FORMS: [string, string, string][] = [
  ['1', 'overview', 'Now'],
  ['2', 'tasks', 'Tasks'],
  ['3', 'agents', 'Agents'],
  ['4', 'timeline', 'Steps'],
  ['5', 'artifacts', 'Artifacts'],
]

const UNKNOWN = 'Unknown. Try /mc, /mc 1-5, keep <note>, export, close or slim.'

for (const [arg, tab, label] of FORMS) {
  test(`/mc ${arg} switches to ${tab}, clears detail and opens the pane`, async ($, on) => {
    const { stored, opened } = world(on, empty, { tab: 'timeline', detail: { stepId: 's1' } } as UiState)

    const got = await run($, arg)

    expect(got.text).toBe(`Mission Control: ${label}.`)
    const ui = stored.get('ui') as UiState
    expect(ui.tab).toBe(tab)
    expect(ui.detail).toBe(undefined)
    expect(opened.length).toBe(1)
    expect(opened[0]).toMatchObject({ id: 'mission-control', focus: true })
  })
}

test('/mc with an old tab name answers Unknown and writes nothing', async ($, on) => {
  const { stored, opened } = world(on, empty)

  const got = await run($, 'agents')

  expect(got.text).toBe(UNKNOWN)
  expect(stored.has('ui')).toBe(false)
  expect(opened.length).toBe(0)
})

test('/mc with an unknown tab answers and writes nothing', async ($, on) => {
  const { stored, opened } = world(on, empty)

  for (const arg of ['6', '0', 'banana']) {
    const got = await run($, arg)
    expect(got.text).toBe(UNKNOWN)
  }

  expect(stored.has('ui')).toBe(false)
  expect(opened.length).toBe(0)
})

test('/mc close and /mc keep work', async ($, on) => {
  const { opened } = world(on, empty)

  const closed = await run($, 'close')
  const kept = await run($, 'keep')

  expect(closed.text).toBe('Mission Control closed.')
  expect(kept.text).toBe('Nothing to keep yet.')
  expect(opened.length).toBe(0)
})

test('/mc keep <note> keeps the newest main step with the note', async ($, on) => {
  const t: Timeline = {
    ...empty,
    steps: [
      { id: 'a', seq: 1, agent: 'main', tool: 'Edit', label: 'Edit a.ts', status: 'done', startedAt: 1 },
      { id: 'b', seq: 2, agent: 'main', tool: 'Bash', label: 'Bash ls', status: 'done', startedAt: 2 },
      { id: 'c', seq: 3, agent: 'a1', tool: 'Read', label: 'Read x', status: 'done', startedAt: 3 },
    ],
  }
  const { stored } = world(on, t)

  await run($, 'keep the label helper')

  const steps = (stored.get('timeline') as Timeline).steps
  expect(steps.find(x => x.id === 'b')?.pin).toBe('the label helper')
  expect(steps.find(x => x.id === 'a')?.pin).toBe(undefined)
  expect(steps.find(x => x.id === 'c')?.pin).toBe(undefined)
})

test('/mc pin is gone: it answers Unknown and keeps nothing', async ($, on) => {
  const t: Timeline = {
    ...empty,
    steps: [{ id: 'a', seq: 1, agent: 'main', tool: 'Edit', label: 'Edit a.ts', status: 'done', startedAt: 1 }],
  }
  const { stored, opened } = world(on, t)

  const got = await run($, 'pin a note')

  expect(got.text).toBe(UNKNOWN)
  expect((stored.get('timeline') as Timeline).steps[0]?.pin).toBe(undefined)
  expect(opened.length).toBe(0)
})

test('/mc slim asks for 28 columns, and again for 62; /mc keeps the slim width while slim', async ($, on) => {
  const { stored, opened } = world(on, empty)

  const first = await run($, 'slim')
  expect((stored.get('ui') as UiState).slim).toBe(true)
  expect(opened[0]).toMatchObject({ id: 'mission-control', columns: 28, focus: true })
  expect(first.text).toBe('Mission Control: slim, 28 columns.')

  await run($, '')
  expect(opened[1]).toMatchObject({ id: 'mission-control', columns: 28 })
  await run($, '3')
  expect(opened[2]).toMatchObject({ id: 'mission-control', columns: 28 })

  const second = await run($, 'slim')
  expect((stored.get('ui') as UiState).slim).toBe(false)
  expect(opened[3]).toMatchObject({ id: 'mission-control', columns: 62, focus: true })
  expect(second.text).toBe('Mission Control: full width, 62 columns.')

  await run($, '')
  expect(opened[4]).toMatchObject({ columns: 62 })
})

test('a ui value stored as ui-3 reads as the initial value', async ($, on) => {
  const old = { ...initialUi, tab: 'artifacts', runningOnly: true } as unknown as UiState
  const { stored } = world(on, empty, old, { timeline: 'timeline-4', ui: 'ui-3' })

  await run($, 'slim')

  expect(stored.get('ui')).toEqual({ ...initialUi, slim: true, paneOpen: true })
})

const paneOpenOf = (stored: Stored): unknown => (stored.get('ui') as UiState | undefined)?.paneOpen

test('paneOpen is written by /mc, /mc 1-5 and /mc slim when the pane is placed, and cleared by /mc close', async ($, on) => {
  const { stored } = world(on, empty)
  expect(paneOpenOf(stored)).toBe(undefined)

  await run($, '')
  expect(paneOpenOf(stored)).toBe(true)
  await run($, 'close')
  expect(paneOpenOf(stored)).toBe(false)
  await run($, '3')
  expect(paneOpenOf(stored)).toBe(true)
  await run($, 'close')
  await run($, 'slim')
  expect(paneOpenOf(stored)).toBe(true)
})

test('an open that waits for a wider terminal leaves paneOpen false', async ($, on) => {
  const { stored } = world(on, empty, undefined, SHAPES, false)

  await run($, '')

  expect(paneOpenOf(stored)).toBe(false)
})

// Another plugin closes a pane: the engine raises ui.close through this mod's hooks too.
// Written out in full: an inline plugin is a module of its own.
const closer: Register = on => {
  on('command.run', { command: 'closer' }, async ($, e) => {
    await $.ui.close({ id: e.args })
    return { text: 'closed' }
  })
}
const closeVia = ($: { command: { run: (a: never) => Promise<{ text?: string }> } }, id: string) =>
  $.command.run({ command: 'closer', args: id } as never)

test('a close of the pane from anywhere (the person, a press) clears paneOpen: a matched ui.close hook observes it', { plugins: [{ name: 'closer', register: closer }] }, async ($, on) => {
  const { stored } = world(on, empty)
  await run($, '')
  expect(paneOpenOf(stored)).toBe(true)

  await closeVia($, 'mission-control')

  expect(paneOpenOf(stored)).toBe(false)
})

test('a ui.close of another pane leaves paneOpen alone', { plugins: [{ name: 'closer', register: closer }] }, async ($, on) => {
  const { stored } = world(on, empty)
  await run($, '')

  await closeVia($, 'other-pane')

  expect(paneOpenOf(stored)).toBe(true)
})

test('a unknown /mc word writes nothing, paneOpen included', async ($, on) => {
  const { stored } = world(on, empty)
  await run($, 'bogus')
  expect(stored.get('ui')).toBe(undefined)
})

test('a ui-4 value without paneOpen reads false: no shape bump, nothing declined', async ($, on) => {
  const old = { ...initialUi, tab: 'artifacts' } as Partial<UiState>
  delete old.paneOpen
  const { stored } = world(on, empty, old as UiState)

  await run($, 'close')

  expect(stored.get('ui')).toEqual({ ...initialUi, tab: 'artifacts', paneOpen: false })
})

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

const TAB_TIERS: [number, number, string[]][] = [
  [62, 12, ['Now', 'Tasks', 'Agents', 'Steps', 'Artifacts']],
  [80, 12, ['Now', 'Tasks', 'Agents', 'Steps', 'Artifacts']],
  [55, 7, ['Now', 'Tsk', 'Agt', 'Stp', 'Art']],
  [40, 7, ['Now', 'Tsk', 'Agt', 'Stp', 'Art']],
  [38, 7, ['Now', 'Tsk', 'Agt', 'Stp', 'Art']],
  [34, 5, ['◆', '▣', '◎', '≡', '↗']],
  [32, 5, ['◆', '▣', '◎', '≡', '↗']],
]

for (const [cols, cell, labels] of TAB_TIERS) {
  test(`at ${cols} columns the tabs are one line of ${cell}-column cells from column 2, then the track and a blank row`, async ($, on) => {
    world(on, empty, { ...initialUi, tab: 'agents' })
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE(cols), surface })
      const rows = screen(await ui.drawn())
      const [tabs, track, gap] = rows
      labels.forEach((label, i) => {
        expect(colOf(tabs, `${i + 1}: ${label}`)).toBe(2 + i * cell)
      })
      expect((tabs ?? '').length <= cols).toBe(true)
      // The track: subtle rest, the open tab (3: Agents) underlined in the accent.
      const open = `3: ${labels[2]}`
      const from = 2 + 2 * cell
      expect(colOf(track, '─')).toBe(2)
      expect((track ?? '').slice(from, from + open.length)).toBe('━'.repeat(open.length))
      expect((track ?? '').length).toBe(Math.min(cols, 2 + 5 * cell))
      expect(gap).toBe('')
      const row = await ui.find({ type: 'Box', key: 'tabs' })
      expect(row?.props.flexWrap).toBe(undefined)
      expect((await ui.findAll({ type: 'Text', text: '│' })).length).toBe(0)
      const agents = await ui.find({ type: 'Button', key: 'tab-agents' })
      expect(agents?.props).toMatchObject({ hotkey: '3', plain: true })
      expect((await ui.find({ type: 'Text', text: new RegExp(`^${labels[2]}$`) }))?.props).toMatchObject({ color: 'suggestion', bold: true })
      expect((await ui.find({ type: 'Button', key: 'tab-tasks' }))?.props).toMatchObject({ dimColor: true })
      await ui.unmount()
    }
  })
}

for (const cols of [31, 28, 24, 20]) {
  test(`at ${cols} columns there is no tab bar: the slim view draws, within the width`, async ($, on) => {
    world(on, { ...empty, now: { focus: 'Grouping timeline steps by agent and humanising labels', at: 1 } })
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE(cols), surface })
      for (const tab of ['overview', 'tasks', 'agents', 'timeline', 'artifacts']) {
        expect(await ui.find({ key: `tab-${tab}` })).toBe(undefined)
      }
      expect(await ui.find({ type: 'Box', key: 'tabs' })).toBe(undefined)
      const rows = screen(await ui.drawn())
      // the Neo slim head: a left bracket holding the state pill, then the focus line
      expect(rows[0]?.startsWith('┏  IDLE')).toBe(true)
      expect(rows[1]?.startsWith('┃ Grouping')).toBe(true)
      for (const r of rows) expect(r.length <= cols).toBe(true)
      await ui.unmount()
    }
  })
}

test('pressing a tab writes ui.tab and leaves the step it had open', async ($, on) => {
  const { stored } = world(on, empty, { ...initialUi, tab: 'timeline', detail: { stepId: 's1' } })
  for (const surface of SURFACES) {
    stored.set('ui', { ...initialUi, tab: 'timeline', detail: { stepId: 's1' } })
    const ui = await $.ui.mount({ ...PANE(62), surface })
    await ui.press({ key: 'tab-artifacts' })
    const u = stored.get('ui') as UiState
    expect(u.tab).toBe('artifacts')
    expect(u.detail).toBe(undefined)
    await ui.unmount()
  }
})

test('/mc export writes the digest to the journal, copies it and answers the path', async ($, on) => {
  const t: Timeline = {
    ...empty,
    journal: 'sess1',
    notes: [{ text: 'a note', agent: 'main', at: 1 }],
    steps: [
      { id: 'p', seq: 1, agent: 'main', tool: 'Bash', label: 'Bash ls', status: 'done', startedAt: 1, pin: '' },
      { id: 'u', seq: 2, agent: 'main', tool: 'Bash', label: 'Bash pwd', status: 'done', startedAt: 2 },
    ],
  }
  world(on, t)
  mock.env(on, { USERPROFILE: 'C:/Users/x', OS: 'Windows_NT' })
  const reads: string[] = []
  const writes: { path: string; text: string }[] = []
  const copies: string[] = []
  const toasts: string[] = []
  const bodies: Record<string, string> = {
    'C:/Users/x/.claude/mission-control/sess1/steps/p.json': JSON.stringify({ input: {}, text: 'PINNED', cut: 0, isError: false }),
    'C:/Users/x/.claude/mission-control/sess1/steps/u.json': JSON.stringify({ input: {}, text: 'UNPINNED', cut: 0, isError: false }),
  }
  on('fs.read', (_, e) => {
    const path = slash(e.path)
    reads.push(path)
    const found = bodies[path]
    if (found === undefined) throw new Error('ENOENT')
    return { value: found }
  })
  on('fs.write', (_, e) => {
    writes.push({ path: slash(e.path), text: e.text })
    return { value: undefined }
  })
  on('ui.copy', (_, e) => {
    copies.push((e as unknown as { text: string }).text)
    return { value: { isCopied: true as const } }
  })
  on('ui.toast', (_, e) => {
    toasts.push((e as unknown as { text: string }).text)
    return { value: undefined }
  })

  const got = await run($, 'export')

  expect(writes.length).toBe(1)
  expect(writes[0]?.path).toMatch(/^C:\/Users\/x\/\.claude\/mission-control\/sess1\/export-\d{4}-\d{2}-\d{2}-\d{4}\.md$/)
  expect(writes[0]?.text).toContain('PINNED')
  expect(writes[0]?.text).not.toContain('UNPINNED')
  expect(reads.some(p => p.endsWith('/u.json'))).toBe(false)
  expect(copies).toEqual([writes[0]?.text])
  expect(got.text).toContain(writes[0]?.path)
  expect(toasts).toEqual([`Exported: ${writes[0]?.path}`])
})

test('/mc export says when the copy failed', async ($, on) => {
  world(on, empty)
  mock.env(on, { USERPROFILE: 'C:/Users/x', OS: 'Windows_NT' })
  on('session.id', () => ({ value: 'sess2' }))
  const toasts: string[] = []
  on('fs.write', () => ({ value: undefined }))
  on('ui.copy', () => ({ value: { isCopied: false as const, reason: 'no-clipboard' as const } }))
  on('ui.toast', (_, e) => {
    toasts.push((e as unknown as { text: string }).text)
    return { value: undefined }
  })
  await run($, 'export')
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toMatch(/^Exported: .*\(copy failed: no-clipboard\)$/)
})

test('/mc export with no home answers and writes nothing', async ($, on) => {
  world(on, empty)
  mock.env(on, {})
  const writes: string[] = []
  on('fs.write', (_, e) => {
    writes.push(e.path)
    return { value: undefined }
  })
  const got = await run($, 'export')
  expect(writes.length).toBe(0)
  expect(got.text).toContain('Could not export')
})

function slash(path: string): string {
  return path.split(String.fromCharCode(92)).join('/')
}
