import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Timeline } from '../../types'
import { empty } from '../model/reduce'
import { digestParts, KEPT_WORDS } from './handoff'
import { diskPath } from '../fsdisk.testkit'

// The engine beneath the mod for /binnacle export: a timeline held under the
// current shape, a home folder, and a disk and clipboard that accept.
function world(on: On, t: Timeline, env: Record<string, string> = { USERPROFILE: 'C:/Users/x', OS: 'Windows_NT' }): { stored: Map<string, unknown>; writes: string[] } {
  const stored = new Map<string, unknown>([['timeline', t]])
  const versions = new Map<string, number>()
  const writes: string[] = []
  mock.clock(on, { now: 1_000_000 })
  mock.env(on, env)
  on('ui.log', () => ({ value: undefined }))
  on('state.get', (_, e) => {
    const key = (e as { key: string }).key
    const v = stored.get(key)
    const shape = key === 'timeline' ? 'timeline-4' : 'ui-4'
    return { value: { value: v === undefined ? undefined : { shape, value: v }, version: versions.get(key) ?? 0 } }
  })
  on('state.set', (_, e) => {
    const w = e as unknown as { key: string; value: { value: unknown } }
    const version = (versions.get(w.key) ?? 0) + 1
    versions.set(w.key, version)
    stored.set(w.key, w.value.value)
    return { value: { isSet: true as const, version } }
  })
  on('fs.write', (_, e) => {
    writes.push(diskPath(e.path))
    return { value: undefined }
  })
  on('fs.read', () => {
    throw new Error('ENOENT')
  })
  on('ui.copy', () => ({ value: { isCopied: true as const } }))
  on('ui.toast', () => ({ value: undefined }))
  return { stored, writes }
}

test('/binnacle export records when and where it wrote', async ($, on) => {
  const { stored, writes } = world(on, { ...empty, journal: 'sess1' })

  await $.command.run({ command: 'binnacle', args: 'export' } as never)

  expect(writes.length).toBe(1)
  const t = stored.get('timeline') as Timeline
  expect(t.lastExport?.at).toBe(1_000_000)
  expect(diskPath(t.lastExport?.path ?? '')).toBe(writes[0])
})

test('/binnacle export with no home records nothing', async ($, on) => {
  const { stored } = world(on, { ...empty, journal: 'sess1' }, {})

  await $.command.run({ command: 'binnacle', args: 'export' } as never)

  expect((stored.get('timeline') as Timeline).lastExport).toBe(undefined)
})

test('digestParts counts what the export will hold: tasks, steps not kept, kept steps, and what was made', () => {
  const step = (id: string, pin?: string) => ({ id, seq: 1, agent: 'main', tool: 'Read', label: 'Read a', status: 'done' as const, startedAt: 1, ...(pin !== undefined ? { pin } : {}) })
  const t: Timeline = {
    ...empty,
    tasks: [{ id: '1', subject: 'one', status: 'completed', owner: 'main', updatedAt: 1 }],
    steps: [step('a'), step('b'), step('c', 'x')],
    artifacts: [{ id: 'r', kind: 'result', title: 'R', agent: 'main', count: 1, updatedAt: 1 }],
    changed: ['a.ts', 'b.ts'],
  }
  const p = digestParts(t, 1_000_000)
  expect([p.tasks, p.steps, p.kept, p.made, p.count]).toEqual([1, 2, 1, 3, 4])
  expect(p.words).toBeGreaterThan(KEPT_WORDS)
  expect(digestParts(empty, 1_000_000)).toMatchObject({ tasks: 0, steps: 0, kept: 0, made: 0, count: 0 })
})
