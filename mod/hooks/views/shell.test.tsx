import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Timeline, UiState } from '../../types'
import { empty } from '../model/reduce'

const SHAPES: Record<string, string> = { timeline: 'timeline-4', ui: 'ui-3' }

type Stored = Map<string, unknown>

function world(on: On, t: Timeline, u?: UiState): { stored: Stored; opened: Record<string, unknown>[] } {
  const stored: Stored = new Map()
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
  on('ui.open', (_, e) => {
    opened.push(e as unknown as Record<string, unknown>)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', () => ({ value: undefined }))
  return { stored, opened }
}

const run = ($: { command: { run: (a: never) => Promise<{ text?: string }> } }, args: string) =>
  $.command.run({ command: 'mc', args } as never)

const FORMS: [string, string, string][] = [
  ['1', 'overview', 'Overview'],
  ['2', 'tasks', 'Tasks'],
  ['3', 'agents', 'Agents'],
  ['4', 'timeline', 'Timeline'],
  ['5', 'artifacts', 'Artifacts'],
]

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

  expect(got.text).toBe('Unknown. Try /mc, /mc 1-5, pin, export or close.')
  expect(stored.has('ui')).toBe(false)
  expect(opened.length).toBe(0)
})

test('/mc with an unknown tab answers and writes nothing', async ($, on) => {
  const { stored, opened } = world(on, empty)

  for (const arg of ['6', '0', 'banana']) {
    const got = await run($, arg)
    expect(got.text).toBe('Unknown. Try /mc, /mc 1-5, pin, export or close.')
  }

  expect(stored.has('ui')).toBe(false)
  expect(opened.length).toBe(0)
})

test('/mc close and /mc pin still work', async ($, on) => {
  const { opened } = world(on, empty)

  const closed = await run($, 'close')
  const pinned = await run($, 'pin')

  expect(closed.text).toBe('Mission Control closed.')
  expect(pinned.text).toBe('Nothing to pin yet.')
  expect(opened.length).toBe(0)
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
