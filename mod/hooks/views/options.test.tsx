import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Timeline, UiState } from '../../types'
import { empty } from '../model/reduce'
import { initialUi } from '../state'
import { colOf, screen } from './screen.testkit'
import { isTextTheme, lookAsked } from './style'

const SURFACES = ['terminal', 'desktop'] as const
const SHAPES: Record<string, string> = { timeline: 'timeline-4', ui: 'ui-4' }

type Sets = { key: string; value: unknown }[]

/**
 * The state as the engine holds it, a config.set beneath the plugin that
 * records each write and answers `answer` (written, or a deny), and toasts.
 */
type Answer = (value: unknown) => { value: unknown } | { deny: string }

function world(on: On, u: UiState = initialUi, answer: Answer = v => ({ value: v })) {
  const stored = new Map<string, unknown>([['timeline', empty as Timeline], ['ui', u]])
  const versions = new Map<string, number>()
  const sets: Sets = []
  const toasts: string[] = []
  mock.clock(on, { now: 1_000_000 })
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
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.toast', (_, e) => {
    toasts.push(String((e as { text?: string }).text))
    return { value: undefined }
  })
  on('config.set', (_, e) => {
    const w = e as unknown as { key: string; value: unknown }
    sets.push({ key: w.key, value: w.value })
    // A config.set the plugin raised is answered with the event's own result.
    return answer(w.value) as never
  })
  return { stored, sets, toasts }
}

const PANE = (columns: number) =>
  ({
    plugin: 'binnacle',
    component: 'Pane',
    requestId: 'binnacle',
    props: {
      title: 'Binnacle',
      isFocused: true,
      bodyColumns: columns,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 60 },
      view: {},
    },
  }) as const

const OPTIONS_UI: UiState = { ...initialUi, page: { kind: 'options', id: '' } }

for (const surface of SURFACES) {
  test(`${surface}: 0 opens Options as a page, and 0 again closes it`, async ($, on) => {
    const { stored } = world(on)
    const ui = await $.ui.mount({ ...PANE(80), surface })
    const button = await ui.find({ type: 'Button', key: 'tab-options' })
    expect(button?.props).toMatchObject({ hotkey: '0', plain: true })

    await ui.press({ key: 'tab-options' })
    expect((stored.get('ui') as UiState).page).toEqual({ kind: 'options', id: '' })
    await ui.unmount()
    // The test's own state.get subscribes nothing: a new mount draws what the press wrote.
    const again = await $.ui.mount({ ...PANE(80), surface })
    const rows = screen(await again.drawn())
    expect(rows.some(r => r.trimStart().startsWith('Never '))).toBe(true)
    expect(rows.join('\n')).not.toMatch(/NEVER|PREVIEW|OPTIONS/)

    await again.press({ key: 'tab-options' })
    expect((stored.get('ui') as UiState).page).toBe(undefined)
    await again.unmount()
  })
}

// BEHAVIOUR CHANGE (task C3b): was "on the tab row when it fits, else at the end of the row under it"; the mocks draw no button for 0, so it is armed and not seen.
test('0 is armed at every tab width and drawn nowhere: no tab row and no blank row carries it', async ($, on) => {
  world(on)
  for (const cols of [32, 40, 55, 62, 80]) {
    const ui = await $.ui.mount({ ...PANE(cols), surface: 'terminal' })
    expect((await ui.find({ type: 'Button', key: 'tab-options' }))?.props).toMatchObject({ hotkey: '0', plain: true })
    const rows = screen(await ui.drawn())
    expect(rows.some(r => r.includes('0: options'))).toBe(false)
    expect(rows[2]).toBe('')
    await ui.unmount()
  }
})

test('/binnacle options opens the pane on the Options page', async ($, on) => {
  const { stored } = world(on)
  const got = await $.command.run({ command: 'binnacle', args: 'options' } as never)
  expect((got as { text?: string }).text).toBe('Binnacle: options.')
  expect((stored.get('ui') as UiState).page).toEqual({ kind: 'options', id: '' })
})

test('the card lists every option with its value and when it applies, and a Never section', async ($, on) => {
  world(on, OPTIONS_UI)
  const ui = await $.ui.mount({ ...PANE(80), surface: 'terminal' })
  const rows = screen(await ui.drawn())
  const rowOf = (name: string) => rows.find(r => r.trimStart().startsWith(name)) ?? ''
  for (const name of ['Notify', 'Agent time limit', 'Turn time limit', 'Show cost', 'Open at start', 'Guide Claude', 'Editor']) {
    expect(colOf(rowOf(name), name)).toBe(4)
  }
  expect(rowOf('Notify').slice(38)).toMatch(/^waits\s+now$/)
  expect(rowOf('Show cost').slice(38)).toMatch(/^off\s+now$/)
  expect(rowOf('Agent time limit').slice(38, 44)).toBe('60 min')
  expect(rowOf('Open at start').slice(50)).toBe('next start')
  expect(rowOf('Accent').slice(50)).toBe('now')
  const never = rows.findIndex(r => r.trimStart().startsWith('Never '))
  expect(never > 0).toBe(true)
  const after = rows.slice(never + 1, never + 5).join('\n')
  for (const words of ['model', 'effort', 'crew', 'cache warm']) expect(after).toContain(words)
  await ui.unmount()
})

// FX3 M-5: the page drew the raw field names `watchNotify`, `ground` and `motion` (under More); they have friendly labels now, in the sections they belong to.
test('the card uses plain labels: Notify for Watch, Crew background, Crew motion; no raw field name and no More section', async ($, on) => {
  world(on, OPTIONS_UI)
  const ui = await $.ui.mount({ ...PANE(80), surface: 'terminal' })
  const rows = screen(await ui.drawn())
  const text = rows.join(String.fromCharCode(10))
  for (const name of ['Notify for Watch', 'Crew background', 'Crew motion']) expect(colOf(rows.find(r => r.trimStart().startsWith(name)) ?? '', name)).toBe(4)
  for (const raw of ['watchNotify', 'agentLimitMin', 'turnLimitMin', 'doneSound', 'showCost', 'autoOpen']) expect(text).not.toContain(raw)
  expect(rows.some(r => r.trim() === 'More' || r.trimStart().startsWith('More '))).toBe(false)
  expect(rows.some(r => /^\s{4}(ground|motion)/.test(r))).toBe(false)
  await ui.unmount()
})

test('drawing the card writes nothing; Enter on a switch writes it once, on the press', async ($, on) => {
  const { sets, toasts } = world(on, OPTIONS_UI)
  const ui = await $.ui.mount({ ...PANE(80), surface: 'terminal' })
  await ui.drawn()
  expect(sets.length).toBe(0)

  await ui.press({ key: 'opt-showCost' })
  expect(sets).toEqual([{ key: 'binnacle.showCost', value: true }])
  expect(toasts.join('|')).toContain('Show cost: on')
  const rows = screen(await ui.drawn())
  expect((rows.find(r => r.trimStart().startsWith('Show cost')) ?? '').slice(38, 40)).toBe('on')
  await ui.unmount()
})

test('a deny leaves the option as it was and says why in a toast', async ($, on) => {
  const { sets, toasts } = world(on, OPTIONS_UI, () => ({ deny: 'managed by policy' }))
  const ui = await $.ui.mount({ ...PANE(80), surface: 'terminal' })
  await ui.press({ key: 'opt-guide' })
  expect(sets.length).toBe(1)
  expect(toasts).toEqual(['Guide Claude not changed: managed by policy'])
  const rows = screen(await ui.drawn())
  expect((rows.find(r => r.trimStart().startsWith('Guide Claude')) ?? '').slice(38, 40)).toBe('on')
  await ui.unmount()
})

test('a choice opens to its values with hotkeys; a value is written on its press', async ($, on) => {
  const { stored, sets } = world(on, OPTIONS_UI)
  const ui = await $.ui.mount({ ...PANE(80), surface: 'terminal' })
  await ui.press({ key: 'opt-notify' })
  expect(sets.length).toBe(0)
  expect((stored.get('ui') as UiState).page).toEqual({ kind: 'options', id: 'notify' })
  await ui.unmount()
  const opened = await $.ui.mount({ ...PANE(80), surface: 'terminal' })
  for (const [v, k] of [['off', 'o'], ['waits', 'w'], ['done', 'd'], ['all', 'a']] as const) {
    expect((await opened.find({ type: 'Button', key: `opt-pick-notify-${v}` }))?.props).toMatchObject({ hotkey: k })
  }
  await opened.press({ key: 'opt-pick-notify-all' })
  expect(sets).toEqual([{ key: 'binnacle.notify', value: 'all' }])
  await opened.unmount()
})

test('a number shows − and +, and writes the stepped value', async ($, on) => {
  const { sets } = world(on, { ...initialUi, page: { kind: 'options', id: 'agentLimitMin' } })
  const ui = await $.ui.mount({ ...PANE(80), surface: 'terminal' })
  const rows = screen(await ui.drawn())
  expect(rows.some(r => r.includes('l: −5') && r.includes('m: +5') && r.includes('x: off'))).toBe(true)
  await ui.press({ key: 'opt-more-agentLimitMin' })
  await ui.press({ key: 'opt-less-agentLimitMin' })
  expect(sets.map(s => s.value)).toEqual([65, 60])
  await ui.unmount()
})

// R3-B M10: meaning changed. `b` is now armed by the footer's hidden Button (`arm-opt-back`, drawn as `b back` in the pane's last row) while the pane holds the keys; it used to press the page's own `opt-back` Button. Unfocused, the plain `opt-back` stays for a click (second test).
test('b closes the card', async ($, on) => {
  const { stored } = world(on, OPTIONS_UI)
  const ui = await $.ui.mount({ ...PANE(80), surface: 'terminal' })
  await ui.press({ key: 'arm-opt-back' })
  expect((stored.get('ui') as UiState).page).toBe(undefined)
  await ui.unmount()
})

test('unfocused, the card keeps a plain back to click', async ($, on) => {
  const { stored } = world(on, OPTIONS_UI)
  const unfocused = PANE(80)
  const ui = await $.ui.mount({ ...unfocused, props: { ...unfocused.props, isFocused: false }, surface: 'terminal' })
  await ui.press({ key: 'opt-back' })
  expect((stored.get('ui') as UiState).page).toBe(undefined)
  await ui.unmount()
})

test('the preview is three critters, Rasters on the terminal and text on the desktop, with the accent named (R38: the cockpit look, no PREVIEW label)', async ($, on) => {
  world(on, OPTIONS_UI)
  const term = await $.ui.mount({ ...PANE(80), surface: 'terminal' })
  for (const i of [0, 1, 2]) expect(await term.find({ type: 'Raster', key: `opt-critter-${i}-inst` })).not.toBe(undefined)
  await term.unmount()
  const desk = await $.ui.mount({ ...PANE(80), surface: 'desktop' })
  expect(await desk.find({ type: 'Raster' })).toBe(undefined)
  const rows = screen(await desk.drawn())
  expect(rows.some(r => r.includes('iris'))).toBe(true)
  expect(rows.some(r => r.includes('the accent'))).toBe(true)
  expect(rows.some(r => r.includes('PREVIEW'))).toBe(false)
  await desk.unmount()
})

// ---------- the look option (I7: the way out of the rich form) ----------

test("look: 'text' draws the pane on the terminal with no Raster: Now, a tab and a page", { options: { look: 'text' } }, async ($, on) => {
  const { stored } = world(on, initialUi)
  for (const u of [initialUi, { ...initialUi, tab: 'tasks' } as UiState, OPTIONS_UI]) {
    stored.set('ui', u)
    const ui = await $.ui.mount({ ...PANE(62), surface: 'terminal' })
    expect(await ui.find({ type: 'Raster' })).toBe(undefined)
    expect(screen(await ui.drawn()).join('\n')).not.toMatch(/failed/)
    await ui.unmount()
  }
})

// BEHAVIOUR CHANGE (task C3b, R21): was "a choice of rich and text", default rich; the choices gain auto, which is the default.
test('the Look row is a choice of auto, rich and text, auto by default; text is written on its press and the pane draws text at once', async ($, on) => {
  const { stored, sets } = world(on, OPTIONS_UI)
  const ui = await $.ui.mount({ ...PANE(80), surface: 'terminal' })
  expect(await ui.find({ type: 'Raster' })).not.toBe(undefined)
  const row = screen(await ui.drawn()).find(r => /^ {4}Look( |$)/.test(r))
  expect(row).toContain('auto')
  await ui.press({ key: 'opt-look' })
  expect((stored.get('ui') as UiState).page).toEqual({ kind: 'options', id: 'look' })
  await ui.unmount()
  const opened = await $.ui.mount({ ...PANE(80), surface: 'terminal' })
  for (const pick of ['auto', 'rich', 'text']) expect(await opened.find({ type: 'Button', key: `opt-pick-look-${pick}` })).not.toBe(undefined)
  await opened.press({ key: 'opt-pick-look-text' })
  expect(sets).toEqual([{ key: 'binnacle.look', value: 'text' }])
  await opened.unmount()
  // Applied now: the next draw, without a reload, has no Raster.
  stored.set('ui', initialUi)
  const after = await $.ui.mount({ ...PANE(80), surface: 'terminal' })
  expect(await after.find({ type: 'Raster' })).toBe(undefined)
  await after.unmount()
})

// ---------- R21: look auto ----------

/** A `/config` list with the one row the mod reads: the theme. */
const withTheme = (on: On, theme: string): void => {
  on('config.list', () => ({ value: [{ key: 'theme', label: 'Theme', kind: 'choice', value: theme, provider: { kind: 'engine' } }] }) as never)
}

test('lookAsked: rich and text are explicit and win; auto and an unset option follow the theme (text on ANSI and daltonized ones)', () => {
  expect(isTextTheme('dark-ansi')).toBe(true)
  expect(isTextTheme('light-daltonized')).toBe(true)
  expect(isTextTheme('dark')).toBe(false)
  expect(lookAsked('text', 'dark')).toBe('text')
  expect(lookAsked('rich', 'dark-ansi')).toBe('rich')
  expect(lookAsked('rich', 'light-daltonized')).toBe('rich')
  expect(lookAsked('auto', 'dark')).toBe(undefined)
  expect(lookAsked('auto', undefined)).toBe(undefined)
  expect(lookAsked('auto', 'dark-ansi')).toBe('text')
  expect(lookAsked('auto', 'light-daltonized')).toBe('text')
  expect(lookAsked(undefined, 'dark-ansi')).toBe('text')
  expect(lookAsked(undefined, 'dark')).toBe(undefined)
})

test('look auto draws pictures on the terminal under a plain theme', { options: { look: 'auto' } }, async ($, on) => {
  world(on)
  withTheme(on, 'dark')
  const ui = await $.ui.mount({ ...PANE(80), surface: 'terminal' })
  expect(await ui.find({ type: 'Raster' })).not.toBe(undefined)
  await ui.unmount()
})

for (const theme of ['dark-ansi', 'light-ansi', 'dark-daltonized']) {
  test(`look auto draws text on the ${theme} theme`, { options: { look: 'auto' } }, async ($, on) => {
    world(on)
    withTheme(on, theme)
    const ui = await $.ui.mount({ ...PANE(80), surface: 'terminal' })
    expect(await ui.find({ type: 'Raster' })).toBe(undefined)
    await ui.unmount()
  })
}

test('look rich draws pictures on an ANSI theme: the explicit choice wins', { options: { look: 'rich' } }, async ($, on) => {
  world(on)
  withTheme(on, 'dark-ansi')
  const ui = await $.ui.mount({ ...PANE(80), surface: 'terminal' })
  expect(await ui.find({ type: 'Raster' })).not.toBe(undefined)
  await ui.unmount()
})

test('look auto draws text where the surface has no Raster', { options: { look: 'auto' } }, async ($, on) => {
  world(on)
  withTheme(on, 'dark')
  const ui = await $.ui.mount({ ...PANE(80), surface: 'vscode' as never })
  expect(await ui.find({ type: 'Raster' })).toBe(undefined)
  await ui.unmount()
})

// R28 amended (review I-2, Fable I8): `0 options` is plain footer text on Now only, as the mock draws it; the other tabs draw none. The one `0` hotkey is the hidden `tab-options` Button in the shell, on every tab.
for (const tab of ['overview', 'tasks', 'agents', 'timeline', 'artifacts'] as const) {
  const says = tab === 'overview' ? 'says 0 options as plain text, once' : 'has no 0 options'
  test(`the footer on ${tab} ${says}; the hidden Button arms 0 and a press opens the Options page`, async ($, on) => {
    const { stored } = world(on, { ...initialUi, tab })
    // A session with a step, a task and an agent, so every tab has rows and so a footer.
    stored.set('timeline', {
      ...empty,
      steps: [{ id: 's1', seq: 1, agent: 'main', tool: 'Edit', label: 'Edit a.ts', status: 'done', startedAt: 900_000, endedAt: 901_000 }],
      tasks: [{ id: '1', subject: 'one', status: 'in_progress', owner: 'main', updatedAt: 900_000 }],
      agents: { ...empty.agents, a1: { id: 'a1', parent: 'main', type: 'Explore', description: 'look', status: 'running', startedAt: 900_000, doing: '', stepCount: 1 } },
    })
    for (const cols of [62, 80]) {
      const ui = await $.ui.mount({ ...PANE(cols), surface: 'mobile' })
      const rows = screen(await ui.drawn())
      expect(rows.filter(r => r.includes('0 options')).length).toBe(tab === 'overview' ? 1 : 0)
      // Never a Button: the footer is text, and nothing keyed footer-options exists.
      expect(await ui.find({ type: 'Button', key: 'footer-options' })).toBe(undefined)
      if (tab === 'overview') {
        const hints = await ui.findAll({ type: 'Text', text: /^0$/ })
        expect(hints.some(h => h.props.color === 'suggestion')).toBe(true)
      }
      // The hidden 0 is the one hotkey, in a Box of no size.
      expect((await ui.find({ type: 'Button', key: 'tab-options' }))?.props).toMatchObject({ hotkey: '0' })
      await ui.unmount()
    }
    const ui = await $.ui.mount({ ...PANE(62), surface: 'mobile' })
    await ui.press({ key: 'tab-options' })
    expect((stored.get('ui') as UiState).page).toEqual({ kind: 'options', id: '' })
    await ui.unmount()
  })
}

test('the Options page draws no `0 options` hint; an unfocused pane has no footer text and keeps the hidden 0', async ($, on) => {
  const { stored } = world(on, OPTIONS_UI)
  const page = await $.ui.mount({ ...PANE(62), surface: 'mobile' })
  expect(screen(await page.drawn()).some(r => r.includes('0 options'))).toBe(false)
  await page.unmount()
  stored.set('ui', { ...initialUi, tab: 'tasks' })
  const quiet = await $.ui.mount({ ...PANE(62), props: { ...PANE(62).props, isFocused: false }, surface: 'mobile' })
  expect(screen(await quiet.drawn()).some(r => r.includes('0 options'))).toBe(false)
  expect((await quiet.find({ type: 'Button', key: 'tab-options' }))?.props).toMatchObject({ hotkey: '0' })
  await quiet.unmount()
})
