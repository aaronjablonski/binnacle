import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Timeline } from '../../types'
import { empty } from '../model/reduce'

// The engine beneath the mod for /mc export: a timeline held under the
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
    writes.push(e.path.replace(/\\/g, '/'))
    return { value: undefined }
  })
  on('fs.read', () => {
    throw new Error('ENOENT')
  })
  on('ui.copy', () => ({ value: { isCopied: true as const } }))
  on('ui.toast', () => ({ value: undefined }))
  return { stored, writes }
}

test('/mc export records when and where it wrote', async ($, on) => {
  const { stored, writes } = world(on, { ...empty, journal: 'sess1' })

  await $.command.run({ command: 'mc', args: 'export' } as never)

  expect(writes.length).toBe(1)
  const t = stored.get('timeline') as Timeline
  expect(t.lastExport?.at).toBe(1_000_000)
  expect(t.lastExport?.path.replace(/\\/g, '/')).toBe(writes[0])
})

test('/mc export with no home records nothing', async ($, on) => {
  const { stored } = world(on, { ...empty, journal: 'sess1' }, {})

  await $.command.run({ command: 'mc', args: 'export' } as never)

  expect((stored.get('timeline') as Timeline).lastExport).toBe(undefined)
})
