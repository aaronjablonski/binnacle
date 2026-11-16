import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { EngineInterface, On, RenderElement, RenderInput } from 'claude-code'

import { empty } from '../model/reduce'
import { initialUi } from '../state'
import { agentCard, allClear, header, primaryButton, section } from './parts'
import type { HeaderSpec } from './parts'
import { colOf, screen } from './screen.testkit'
import type { ViewCtx } from './shell'
import { CK, critterArgs, lookOf } from './style'
import type { Look } from './style'

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
const NOW = 1_000_000

// A test pane drawn by the test's own ui.render hook, so each cockpit part is laid out alone.
function draws(on: On, build: (ctx: ViewCtx, $: EngineInterface) => RenderElement | null, look?: 'auto' | Look): void {
  mock.clock(on, { now: NOW })
  on('ui.log', () => ({ value: undefined }))
  on('state.get', () => ({ value: { value: undefined, version: 0 } }))
  on('ui.render', { component: 'Pane', requestId: 'cockpit-test' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    const cols = e.component === 'Pane' ? e.props.bodyColumns : 62
    const ctx: ViewCtx = {
      e: e as RenderInput, t: empty, u: initialUi, cols, now: NOW, isFocused: true, site: 'cockpit-test',
      ...(look === 'auto' ? { look: lookOf($.ui.resolve(e)) } : look !== undefined ? { look } : {}),
    }
    return <Box flexDirection="column">{build(ctx, $)}</Box>
  })
}

const PANE = (columns: number) =>
  ({
    plugin: 'mission-control',
    component: 'Pane',
    requestId: 'cockpit-test',
    props: { title: 'Mission Control', isFocused: true, bodyColumns: columns, placement: 'dock', scroll: { offset: 0, bodyRows: 46 }, view: {} },
  }) as const

async function rows($: Engine, columns = 62, surface: (typeof SURFACES)[number] = 'desktop'): Promise<string[]> {
  const ui = await $.ui.mount({ ...PANE(columns), surface })
  const out = screen(await ui.drawn())
  await ui.unmount()
  return out
}

/** Nothing but the marker may enter columns 0 to 1 and the last two: every row but the frame's. */
function gutterClean(rs: string[], cols: number, frameRows: number[] = []): void {
  rs.forEach((r, i) => {
    expect(r.length).toBeLessThanOrEqual(cols)
    if (frameRows.includes(i)) return
    expect(r.slice(0, 2).trim()).toBe('')
    expect(r.slice(cols - 2).trim()).toBe('')
  })
}

const GAUGES = [{ pct: 62, label: 'context' }, { pct: 34, label: 'this week' }]
const BUSY: HeaderSpec = {
  key: 'now',
  pill: 'WORKING',
  meta: '41 min this turn',
  critter: critterArgs('lead', 'working'),
  kicker: 'Working on',
  title: 'Wiring the limiter into the middleware chain',
  budget: [{ text: '620k' }, { text: ' of 1M used · cache warm 4:48', dim: true }],
  gauges: GAUGES,
}

// ---------- section ----------

test('section: title at 2, a hairline, the sum ending at 59; no caps and no ┌', async ($, on) => {
  draws(on, (ctx, $) => (
    <>
      {section(ctx, $, 'To do', [{ text: '9', bold: true }, { text: ' of 14 done', dim: true }])}
      {section(ctx, $, 'Notes and decisions', '3')}
      {section(ctx, $, 'Watch', 'no action needed', { tone: 'dim' })}
      {section(ctx, $, 'This turn')}
    </>
  ))
  const rs = await rows($)
  expect(rs[0]).toBe(`  To do ${'─'.repeat(39)} 9 of 14 done`)
  expect(rs[1]).toBe(`  Notes and decisions ${'─'.repeat(36)} 3`)
  expect(rs[2]!.endsWith(' no action needed')).toBe(true)
  expect(rs[2]!.length).toBe(60)
  expect(rs[3]).toBe(`  This turn ${'─'.repeat(48)}`)
  for (const r of rs) {
    expect(r).not.toContain('┌')
    expect(r.length).toBe(60)
    expect(colOf(r, '─') > 2).toBe(true)
  }
  gutterClean(rs, 62)
})

test('section: tones are theme keys (Needs you amber, Failed red, Watch dim); a press makes the head one Button', async ($, on) => {
  draws(on, (ctx, $) => (
    <>
      {section(ctx, $, 'Needs you', [{ text: '1', color: CK.ask, bold: true }, { text: ' permission', color: CK.ask }], { tone: 'ask' })}
      {section(ctx, $, 'Failed', [{ text: '1', color: CK.fail }], { tone: 'fail' })}
      {section(ctx, $, 'Agents', '2 working', { onPress: () => {}, key: 'sec-agents' })}
    </>
  ))
  const ui = await $.ui.mount({ ...PANE(62), surface: 'terminal' })
  const leaf = async (text: string) => (await ui.findAll({ type: 'Text', text })).find(t => t.text === text)
  expect((await leaf('Needs you'))?.props).toMatchObject({ color: 'warning', bold: true })
  expect((await leaf('Failed'))?.props).toMatchObject({ color: 'error', bold: true })
  expect((await leaf('Watch'))?.props).toBeUndefined()
  expect((await ui.find({ type: 'Button', key: 'sec-agents' }))?.text).toContain('2 working')
  expect((await ui.findAll({ type: 'Button' })).length).toBe(1)
  await ui.unmount()
})

test('section: at 26 columns it starts at 1 and ends at 24', async ($, on) => {
  draws(on, (ctx, $) => section(ctx, $, 'Agents', '2 working'))
  const [r] = await rows($, 26)
  expect(colOf(r, 'Agents')).toBe(1)
  expect(r!.length).toBe(25)
  expect(r!.endsWith('2 working')).toBe(true)
})

// ---------- header ----------

test('header at 62: lintel, pill row, critter at 2, kicker and headline at 9 (29 wide), gauges at 40 and 51, words under them, sill', async ($, on) => {
  draws(on, (ctx, $) => header(ctx, $, BUSY))
  const rs = await rows($)
  expect(rs).toHaveLength(9)
  expect(rs[0]).toBe('┏━━' + '─'.repeat(59))
  expect(rs[1]).toBe('   WORKING   41 min this turn')
  expect(colOf(rs[1], ' WORKING ')).toBe(2)
  expect(rs[2]).toBe('')
  expect(colOf(rs[3], '●')).toBe(2)
  expect(colOf(rs[3], 'Working on')).toBe(9)
  // R3-B M8: meaning changed. The text form reads `● lead` on one row (R22: the glyph, then the role word) where it was `●` over `lead`; the critter box is as before.
  expect(colOf(rs[3], 'lead')).toBe(4)
  expect(colOf(rs[4], 'Wiring the limiter into the')).toBe(9)
  expect(colOf(rs[5], 'middleware chain')).toBe(9)
  for (const i of [4, 5]) expect(rs[i]!.slice(9, 40).trimEnd().length).toBeLessThanOrEqual(29)
  // the gauges' text form: the figures centred in the middle row of 9 x 5 boxes at 40 and 51
  expect(colOf(rs[4], '62%')).toBe(43)
  expect(colOf(rs[4], '34%')).toBe(54)
  expect(colOf(rs[7], '620k of 1M used')).toBe(2)
  expect(colOf(rs[7], 'context')).toBe(41)
  expect(colOf(rs[7], 'this week')).toBe(51)
  expect(rs[8]).toBe('─'.repeat(59) + '━━┛')
  gutterClean(rs, 62, [0, 8])
})

test('header on the terminal: lintel, sill, critter and gauges are Rasters at their columns; no Raster in a Button', async ($, on) => {
  draws(on, (ctx, $) => header(ctx, $, { ...BUSY, onTitle: () => {}, onBudget: () => {} }), 'auto')
  const ui = await $.ui.mount({ ...PANE(62), surface: 'terminal' })
  expect((await ui.find({ type: 'Raster', key: 'now-lintel' }))?.props).toMatchObject({ columns: 62, rows: 1 })
  expect((await ui.find({ type: 'Raster', key: 'now-sill' }))?.props).toMatchObject({ columns: 62, rows: 1 })
  expect((await ui.find({ type: 'Raster', key: 'now-who' }))?.props).toMatchObject({ columns: 6, rows: 3 })
  expect((await ui.find({ type: 'Raster', key: 'now-gauges' }))?.props).toMatchObject({ columns: 20, rows: 5 })
  for (const b of await ui.findAll({ type: 'Button' })) expect(JSON.stringify(b)).not.toContain('"Raster"')
  const rs = screen(await ui.drawn())
  // the boxes sit where the text form puts them: the headline at 9 beside a 7-wide critter column, gauges after 40
  expect(colOf(rs[4], 'Wiring the limiter into the')).toBe(9)
  expect(colOf(rs[7], 'context')).toBe(41)
  await ui.unmount()
})

test('header narrower than 62: no gauges, the headline takes the width, the gauges become words on the budget line', async ($, on) => {
  draws(on, (ctx, $) => header(ctx, $, BUSY))
  const rs = await rows($, 54)
  expect(rs).toHaveLength(9)
  expect(rs.join('\n')).not.toContain('62%   ')
  expect(colOf(rs[4], 'Wiring the limiter into the')).toBe(9)
  expect(rs[7]).toContain('context 62%')
  gutterClean(rs, 54, [0, 8])
})

test('header compact (slim, 26): pill, kicker and up to three headline lines from column 1', async ($, on) => {
  draws(on, (ctx, $) => header(ctx, $, BUSY))
  const rs = await rows($, 26)
  expect(rs).toHaveLength(7)
  // the meta does not fit beside the pill at 26, so it is left out whole
  expect(rs[1]).toBe('  WORKING')
  expect(rs[2]).toBe('')
  expect(colOf(rs[3], 'Working on')).toBe(1)
  expect(rs[4]).toBe(' Wiring the limiter into')
  expect(rs[5]).toBe(' the middleware chain')
  for (const r of rs) expect(r.length).toBeLessThanOrEqual(26)
})

test('header compact keeps a short meta flush right', async ($, on) => {
  draws(on, (ctx, $) => header(ctx, $, { ...BUSY, meta: '41 min' }))
  const rs = await rows($, 26)
  expect(rs[1]).toBe(' ' + ' WORKING ' + ' '.repeat(9) + '41 min')
  expect(rs[1]!.length).toBe(24 + 1)
})

test('header: amber when a dialog waits; the pill is a Text on the tone, nothing else coloured', async ($, on) => {
  draws(on, (ctx, $) => header(ctx, $, { ...BUSY, tone: 'amber', pill: 'WAITING FOR YOU', meta: '40s', kicker: 'Paused on', critter: critterArgs('lead', 'waiting') }))
  const ui = await $.ui.mount({ ...PANE(62), surface: 'desktop' })
  const leaf = async (text: string) => (await ui.findAll({ type: 'Text', text })).find(t => t.text === text)
  expect((await leaf(' WAITING FOR YOU '))?.props).toMatchObject({ backgroundColor: 'warning', color: 'inverseText', bold: true })
  expect((await leaf('┏━━'))?.props).toMatchObject({ color: 'warning' })
  await ui.unmount()
})

// ---------- agent card ----------

test('agentCard: critter at 2 with its badge at 7, name at 9, time ending at 59, doing under it, the third row empty', async ($, on) => {
  draws(on, (ctx, $) => (
    <>
      {agentCard(ctx, $, { key: 'a1', critter: critterArgs('scout', 'working'), name: 'Explorer', job: 'find every caller of upload()', time: '2 min', doing: 'Searching src/server for “upload(”', tokens: '31k tokens' })}
      {agentCard(ctx, $, { key: 'a2', critter: critterArgs('build', 'waiting'), name: 'Builder', job: 'wire the limiter middleware', time: [{ text: '40s', color: CK.ask }], doing: [{ text: 'Waiting for your answer', color: CK.ask }], onPress: () => {} })}
    </>
  ))
  const rs = await rows($)
  expect(rs).toHaveLength(6)
  expect(colOf(rs[0], '●')).toBe(2)
  expect(colOf(rs[0], 'Explorer  find every caller of upload()')).toBe(9)
  expect(rs[0]!.endsWith('2 min')).toBe(true)
  expect(rs[0]!.length).toBe(60)
  expect(colOf(rs[1], 'scout')).toBe(2)
  expect(colOf(rs[1], 'Searching src/server')).toBe(9)
  expect(rs[1]!.endsWith('31k tokens')).toBe(true)
  expect(rs[2]).toBe('')
  expect(colOf(rs[3], '?')).toBe(7)
  expect(colOf(rs[3], 'Builder')).toBe(9)
  expect(rs[3]!.endsWith('40s')).toBe(true)
  expect(colOf(rs[4], 'Waiting for your answer')).toBe(9)
  gutterClean(rs, 62)
})

test('agentCard: a long job is cut at a word and leaves the time two columns', async ($, on) => {
  const job = 'map every caller of upload() across the server, the CLI and the workers'
  draws(on, (ctx, $) => agentCard(ctx, $, { key: 'a', critter: critterArgs('check', 'working'), name: 'Code reviewer', job, time: '12 min', doing: 'Reading src/cli/upload.ts' }))
  const [r] = await rows($)
  expect(r!.endsWith('12 min')).toBe(true)
  const text = r!.slice(9, 60 - 6).trimEnd()
  expect(text.endsWith('…')).toBe(true)
  expect(9 + text.length).toBeLessThanOrEqual(60 - 6 - 2)
  for (const w of text.replace(/…$/, '').split(/\s+/).filter(Boolean)) expect(`Code reviewer  ${job}`.split(/\s+/)).toContain(w)
})

// ---------- all clear and the filled button ----------

test('allClear: ✓ in success at 2, the words dim, an extra after them', async ($, on) => {
  draws(on, (ctx, $) => allClear(ctx, $, ' · 2 things to watch'))
  const [r] = await rows($)
  expect(r).toBe('  ✓ Nothing needs you · 2 things to watch')
  const ui = await $.ui.mount({ ...PANE(62), surface: 'terminal' })
  expect((await ui.findAll({ type: 'Text', text: '✓' })).find(t => t.text === '✓')?.props).toMatchObject({ color: 'success' })
  await ui.unmount()
})

test('primaryButton: a pressable Button variant="primary", drawn [ label ] on the terminal (R33)', async ($, on) => {
  let pressed = 0
  draws(on, (ctx, $) => primaryButton(ctx, $, { key: 'go', label: '↵ go to prompt', onPress: () => void pressed++ }))
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE(62), surface })
    const b = await ui.find({ type: 'Button', key: 'go' })
    expect(b?.props).toMatchObject({ variant: 'primary' })
    expect(b?.props.plain).toBeUndefined()
    await ui.unmount()
  }
  expect((await rows($))[0]).toBe('[ ↵ go to prompt ]')
  const ui = await $.ui.mount({ ...PANE(62), surface: 'terminal' })
  await $.ui.press({ plugin: 'test', key: 'go', surface: 'terminal' })
  expect(pressed).toBe(1)
  await ui.unmount()
})

