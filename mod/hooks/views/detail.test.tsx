import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Step, StepBody, Timeline, UiState } from '../../types'
import { empty } from '../model/reduce'

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
const NOW = 1_000_000
const SHAPES: Record<string, string> = { timeline: 'timeline-3', ui: 'ui-3' }

type Stored = Map<string, unknown>

function world(on: On, t: Timeline, u: UiState): Stored {
  const stored: Stored = new Map()
  stored.set('timeline', t)
  stored.set('ui', u)
  const versions = new Map<string, number>()
  mock.clock(on, { now: NOW })
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
  return stored
}

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

const step = (id: string, label: string, extra: Partial<Step> = {}): Step => ({
  id,
  seq: 1,
  agent: 'main',
  tool: 'Edit',
  label,
  status: 'done',
  startedAt: NOW - 5000,
  endedAt: NOW - 4000,
  ...extra,
})

const bodyOf = (extra: Partial<StepBody> = {}): StepBody => ({
  input: { file_path: 'src/a.ts' },
  text: 'all good',
  cut: 0,
  isError: false,
  ...extra,
})

const DETAIL = (body?: StepBody): UiState => ({
  tab: 'timeline',
  filter: { kind: 'all' },
  agentsMode: 'list',
  folded: [],
  openTurns: [],
  dismissed: [],
  query: '',
  runningOnly: false,
  notified: [],
  toasted: [],
  detail: body ? { stepId: 's1', body } : { stepId: 's1', missing: true },
})

async function mount($: Engine, surface: (typeof SURFACES)[number], columns = 62) {
  return $.ui.mount({ ...PANE(columns), surface })
}

const tl = (s: Step): Timeline => ({ ...empty, steps: [s] })
// `Code` takes no key: it is found inside its section's Box.
const codeIn = async (ui: Awaited<ReturnType<typeof mount>>, section: string): Promise<Record<string, unknown> | undefined> => {
  const box = await ui.find({ key: section })
  const code = (box?.children ?? []).find(c => typeof c === 'object' && c !== null && (c as { type?: string }).type === 'Code')
  return (code as { props?: Record<string, unknown> } | undefined)?.props
}
const sourceOf = async (ui: Awaited<ReturnType<typeof mount>>, section: string): Promise<string> =>
  String((await codeIn(ui, section))?.source ?? '')
const allText = async (ui: Awaited<ReturnType<typeof mount>>): Promise<string> =>
  (await ui.findAll({ type: 'Text' })).map(f => f.text).join('\n')

test('shows input and result', async ($, on) => {
  world(on, tl(step('s1', 'Read a.ts', { tool: 'Read' })), DETAIL(bodyOf()))
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const all = await allText(ui)
    expect(all).toContain('INPUT')
    expect(all).toContain('RESULT')
    expect(all).toContain('Read a.ts')
    expect(await sourceOf(ui, 'input')).toContain('"file_path": "src/a.ts"')
    expect(await sourceOf(ui, 'result')).toBe('all good')
    await ui.unmount()
  }
})

test('an Edit shows a diff Code', async ($, on) => {
  const body = bodyOf({ input: { file_path: 'a.ts', old_string: 'one\ntwo', new_string: 'uno\ndos\ntres' } })
  world(on, tl(step('s1', 'Edit a.ts')), DETAIL(body))
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const change = await codeIn(ui, 'change')
    expect(change?.format).toBe('diff')
    expect(change?.source).toBe('@@ -1,2 +1,3 @@\n-one\n-two\n+uno\n+dos\n+tres')
    await ui.unmount()
  }
})

test('control characters are dropped and CRLF becomes LF in the result', async ($, on) => {
  world(on, tl(step('s1', 'Bash x', { tool: 'Bash' })), DETAIL(bodyOf({ text: 'a\r\nb\u001b[31mred\u001b[0m\u0000' })))
  const ui = await mount($, 'terminal')
  expect(await sourceOf(ui, 'result')).toBe('a\nbred')
  await ui.unmount()
})

test('a cut body says how much is not kept', async ($, on) => {
  world(on, tl(step('s1', 'Bash x', { tool: 'Bash' })), DETAIL(bodyOf({ cut: 1234 })))
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect(await allText(ui)).toContain('… 1234 more characters not kept')
    await ui.unmount()
  }
})

test('a missing body says so', async ($, on) => {
  world(on, tl(step('s1', 'Bash x', { tool: 'Bash' })), DETAIL())
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect(await allText(ui)).toContain('Result not kept on disk.')
    expect(await ui.find({ key: 'result' })).toBeUndefined()
    await ui.unmount()
  }
})

test('Pin toggles to Unpin and writes the pin', async ($, on) => {
  const stored = world(on, tl(step('s1', 'Edit a.ts')), DETAIL(bodyOf()))
  for (const surface of SURFACES) {
    stored.set('timeline', tl(step('s1', 'Edit a.ts')))
    const ui = await mount($, surface)
    expect((await ui.find({ key: 'detail-pin' }))?.text).toContain('Pin')
    await ui.press({ key: 'detail-pin' })
    expect((stored.get('timeline') as Timeline).steps[0]?.pin).toBe('')
    await ui.unmount()
    const again = await mount($, surface)
    expect((await again.find({ key: 'detail-pin' }))?.text).toContain('Unpin')
    await again.press({ key: 'detail-pin' })
    expect((stored.get('timeline') as Timeline).steps[0]?.pin).toBeUndefined()
    await again.unmount()
  }
})

test('a pinned step shows its note under the header', async ($, on) => {
  world(on, tl(step('s1', 'Edit a.ts', { pin: 'the limiter itself' })), DETAIL(bodyOf()))
  const ui = await mount($, 'terminal')
  expect(await allText(ui)).toContain('★ the limiter itself')
  await ui.unmount()
})

test('Back clears detail', async ($, on) => {
  const stored = world(on, tl(step('s1', 'Edit a.ts')), DETAIL(bodyOf()))
  for (const surface of SURFACES) {
    stored.set('ui', DETAIL(bodyOf()))
    const ui = await mount($, surface)
    expect((await ui.find({ key: 'detail-back' }))?.text).toContain('Back')
    await ui.press({ key: 'detail-back' })
    expect((stored.get('ui') as UiState).detail).toBeUndefined()
    await ui.unmount()
    const again = await mount($, surface)
    expect(await again.find({ key: 'filter-all' })).toBeDefined()
    expect(await again.find({ key: 'detail-back' })).toBeUndefined()
    await again.unmount()
  }
})

test('Copy calls ui.copy with the result text and toasts Copied.', async ($, on) => {
  world(on, tl(step('s1', 'Edit a.ts')), DETAIL(bodyOf({ text: 'line1\r\nline2' })))
  const copies: { text: string; surface: string }[] = []
  const toasts: string[] = []
  on('ui.copy', (_, e) => {
    const c = e as unknown as { text: string; surface: string }
    copies.push({ text: c.text, surface: c.surface })
    return { value: { isCopied: true as const } }
  })
  on('ui.toast', (_, e) => {
    toasts.push((e as unknown as { text: string }).text)
    return { value: undefined }
  })
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    await ui.press({ key: 'detail-copy' })
    expect(copies[copies.length - 1]).toEqual({ text: 'line1\r\nline2', surface })
    expect(toasts[toasts.length - 1]).toBe('Copied.')
    await ui.unmount()
  }
})

test('a copy that did not take toasts the reason', async ($, on) => {
  world(on, tl(step('s1', 'Edit a.ts')), DETAIL(bodyOf()))
  const toasts: string[] = []
  on('ui.copy', () => ({ value: { isCopied: false as const, reason: 'no-clipboard' as const } }))
  on('ui.toast', (_, e) => {
    toasts.push((e as unknown as { text: string }).text)
    return { value: undefined }
  })
  const ui = await mount($, 'terminal')
  await ui.press({ key: 'detail-copy' })
  expect(toasts[toasts.length - 1]).toContain('no-clipboard')
  await ui.unmount()
})

test('the buttons are labelled for surfaces with no hotkeys', async ($, on) => {
  world(on, tl(step('s1', 'Edit a.ts')), DETAIL(bodyOf()))
  const ui = await mount($, 'vscode')
  expect((await ui.find({ key: 'detail-back' }))?.text).toContain('(b)')
  expect((await ui.find({ key: 'detail-pin' }))?.text).toContain('(p)')
  expect((await ui.find({ key: 'detail-copy' }))?.text).toContain('(c)')
  await ui.unmount()
})

test('a step no longer kept says so and still offers Back', async ($, on) => {
  world(on, empty, DETAIL(bodyOf()))
  const ui = await mount($, 'terminal')
  expect(await allText(ui)).toContain('This step is no longer kept.')
  expect(await ui.find({ key: 'detail-back' })).toBeDefined()
  await ui.unmount()
})

test('narrow: no Text longer than 24 in the detail', async ($, on) => {
  const body = bodyOf({ input: { file_path: 'src/server/middleware/rateLimit.ts', old_string: 'a', new_string: 'b' }, cut: 99 })
  world(
    on,
    tl(step('s1', 'Edit src/server/middleware/rateLimit.ts', { pin: 'the limiter itself, a long note', agent: 'a1' })),
    DETAIL(body),
  )
  for (const surface of SURFACES) {
    const ui = await mount($, surface, 24)
    const found = [...(await ui.findAll({ type: 'Text' })), ...(await ui.findAll({ type: 'Button' }))]
    expect(found.length > 5).toBe(true)
    for (const f of found) {
      for (const line of (f.text ?? '').split('\n')) expect(line.length <= 24).toBe(true)
    }
    await ui.unmount()
  }
})

type Mounted = Awaited<ReturnType<typeof mount>>
type Found = Awaited<ReturnType<Mounted['findAll']>>[number]
const propsOf = (f: Found | undefined): { color?: string; dimColor?: boolean; bold?: boolean } =>
  (f?.props ?? {}) as { color?: string; dimColor?: boolean; bold?: boolean }

test('the header is a STEP section header, the glyph in its status colour and the label bold', async ($, on) => {
  world(on, tl(step('s1', 'Bash npm test', { tool: 'Bash', status: 'error' })), DETAIL(bodyOf({ isError: true })))
  for (const surface of SURFACES) {
    for (const columns of [62, 24]) {
      const ui = await mount($, surface, columns)
      const found = await ui.findAll({ type: 'Text' })
      expect(propsOf(found.find(f => f.text === 'STEP')).color).toBe('suggestion')
      expect(found.some(f => (f.text ?? '').startsWith('STEP ') && (f.text ?? '').length === columns)).toBe(true)
      expect(propsOf(found.find(f => f.text === '✖')).color).toBe('error')
      expect(propsOf(found.find(f => (f.text ?? '').startsWith(' Bash npm'))).bold).toBe(true)
      expect(found.some(f => (f.text ?? '').startsWith('RESULT ') && (f.text ?? '').includes('error'))).toBe(true)
      for (const f of found) {
        for (const line of (f.text ?? '').split('\n')) expect(line.length <= columns).toBe(true)
      }
      await ui.unmount()
    }
  }
})
