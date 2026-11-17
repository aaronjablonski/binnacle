// The Options card (distillation item 6; rich spec "Options"): every option
// of the manifest's userConfig as a row with its value and when it applies,
// changed in the pane. Opened as a page (`ui.page = { kind: 'options' }`)
// by the tab bar's `0` (a Button hotkey takes only a digit or a lowercase
// letter, so the mock's `,` cannot be bound) or `/binnacle options`.
//
// A press is the only thing that writes: `$.config.set` on the row's key, as
// `$.config.list` names it (`binnacle.<field>`, or the `@inline` form a
// --plugin-dir load may use). A change reloads the mod with the new options
// (the type file's `Register`), so a value drawn here is the module's own;
// until that reload lands, the value just written is drawn.

import type { ConfigValue, EngineInterface, PluginOptions, RenderElement } from 'claude-code'

import { debug, errText } from '../state'
import { nameFit, wordFit } from './fit'
import { closePage, openPage } from './pagenav'
import { heightOf, runText, section } from './parts'
import { applyShowAs, TAB_ROWS } from './shell'
import type { ViewCtx } from './shell'
import { footerSlot } from './tabkit'
import { C, edges, GRID, setAccent } from './style'
import type { Run } from './style'

/** The hotkey that opens and closes Options (the tab bar's Button). */
export const OPTIONS_HOTKEY = '0'

const PLUGIN = 'binnacle'
/** The pane's request id (shell.tsx `PANE`; not imported, as shell imports this module). */
const PANE_ID = 'binnacle'

type Section = 'Look' | 'Signals' | 'Budget' | 'Start' | 'More'
type Kind = 'boolean' | 'choice' | 'number' | 'text'

/** What the card knows of a field: its words, its section, when a change applies, and how it changes. */
type Field = {
  field: string
  label: string
  section: Section
  applies: string
  kind: Kind
  choices?: readonly string[]
  step?: number
  max?: number
  unit?: string
  offAtZero?: boolean
}

/**
 * The fields the card knows, in its order. A field the manifest declares
 * and this list lacks is still drawn, under More, its kind from its value.
 */
const FIELDS: readonly Field[] = [
  { field: 'look', label: 'Look', section: 'Look', applies: 'now', kind: 'choice', choices: ['auto', 'rich', 'text'] },
  { field: 'showAs', label: 'Show as', section: 'Look', applies: 'now', kind: 'choice', choices: ['pane', 'band', 'strip'] },
  { field: 'header', label: 'Header', section: 'Look', applies: 'now', kind: 'choice', choices: ['full', 'slim'] },
  { field: 'accent', label: 'Accent', section: 'Look', applies: 'now', kind: 'choice', choices: ['iris', 'sky', 'slate'] },
  { field: 'ground', label: 'Crew background', section: 'Look', applies: 'now', kind: 'choice', choices: ['auto', 'night', 'day'] },
  { field: 'motion', label: 'Crew motion', section: 'Look', applies: 'now', kind: 'choice', choices: ['on', 'off'] },
  { field: 'notify', label: 'Notify', section: 'Signals', applies: 'now', kind: 'choice', choices: ['off', 'waits', 'done', 'all'] },
  { field: 'watchNotify', label: 'Notify for Watch', section: 'Signals', applies: 'now', kind: 'boolean' },
  { field: 'doneSound', label: 'Done sound', section: 'Signals', applies: 'now', kind: 'boolean' },
  {
    field: 'agentLimitMin', label: 'Agent time limit', section: 'Signals', applies: 'now',
    kind: 'number', step: 5, max: 600, unit: ' min', offAtZero: true,
  },
  {
    field: 'turnLimitMin', label: 'Turn time limit', section: 'Signals', applies: 'now',
    kind: 'number', step: 5, max: 600, unit: ' min', offAtZero: true,
  },
  { field: 'showCost', label: 'Show cost', section: 'Budget', applies: 'now', kind: 'boolean' },
  { field: 'autoOpen', label: 'Open at start', section: 'Start', applies: 'next start', kind: 'boolean' },
  { field: 'guide', label: 'Guide Claude', section: 'Start', applies: 'new thread', kind: 'boolean' },
  { field: 'editor', label: 'Editor', section: 'Start', applies: 'now', kind: 'text' },
]

const SECTIONS: readonly Section[] = ['Look', 'Signals', 'Budget', 'Start', 'More']

/** What the mod will not offer, whatever is asked (the distillation's anti-goals). */
export const NEVER: readonly string[] = [
  'picks a model for you',
  'sets an effort for you',
  'splits your work into a crew',
  'sends a request to keep the cache warm',
]

/** The options `register` received. A reload sets them again. */
let given: PluginOptions = {}

/** What a press wrote and the module has not been reloaded with yet. Bounded by the fields. */
const written = new Map<string, ConfigValue>()

/** Takes the options `register` received; called once per load. */
export function configureOptions(options: PluginOptions): void {
  given = options
  written.clear()
  // M9: the accent is configuration, set here and on the Accent press, never while drawing.
  setAccent(valueOf('accent'))
}

/**
 * The `look` option as it stands now: what a press on the Look row just
 * wrote, else the module's option. The pane and the band read it on every
 * draw, so a change applies at once, before any reload.
 */
/** The `showAs` option as it stands now (R53): `pane`, `band` or `strip`; the band reads it on every draw. */
export function showAsOption(): string {
  const v = valueOf('showAs')
  return v === 'band' || v === 'strip' ? v : 'pane'
}

export function lookOption(): string | undefined {
  const v = valueOf('look')
  return typeof v === 'string' ? v : undefined
}

/** The `accent` option as it stands now (what a press just wrote, else the module's), for a draw to hand `setAccent`. */
export function accentOption(): string | undefined {
  const v = valueOf('accent')
  return typeof v === 'string' ? v : undefined
}

/** Whether Now draws the slim header (`header: slim`, R44 amended) instead of the full one with the ring gauges (the default). */
export function slimHeader(): boolean {
  return valueOf('header') === 'slim'
}

/** The value drawn for `field`: what a press just wrote, else the module's option. */
function valueOf(field: string): ConfigValue | undefined {
  return written.get(field) ?? given[field]
}

/** A field name as words for a field the card has no label for: `someOption` reads "Some option". */
function plainName(field: string): string {
  const words = field.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** The fields the manifest declares, each with what the card knows of it. */
export function fieldsShown(): Field[] {
  const out: Field[] = []
  for (const f of FIELDS) if (f.field in given) out.push(f)
  for (const [field, v] of Object.entries(given)) {
    if (FIELDS.some(f => f.field === field)) continue
    const kind: Kind = typeof v === 'boolean' ? 'boolean' : typeof v === 'number' ? 'number' : 'text'
    out.push({ field, label: plainName(field), section: 'More', applies: 'now', kind, step: 1 })
  }
  return out
}

/** A value as the card says it: on/off, `20 min`, `off` for a zero that turns it off. */
export function shownValue(f: Field, v: ConfigValue | undefined): string {
  if (v === undefined) return '—'
  if (typeof v === 'boolean') return v ? 'on' : 'off'
  if (typeof v === 'number') return v === 0 && f.offAtZero === true ? 'off' : `${v}${f.unit ?? ''}`
  if (typeof v === 'string') return v === '' ? '—' : v
  return v.join(', ')
}

const isOff = (v: ConfigValue | undefined): boolean => v === false || v === 0 || v === 'off'

// ---------- writing, on a press only ----------

/** The config key of `field`, as `$.config.list` names it; the plain form when the list cannot be read. */
async function rowOf($: EngineInterface, field: string): Promise<{ key: string; isLocked: boolean }> {
  const plain = `${PLUGIN}.${field}`
  try {
    const rows = await $.config.list()
    const hit =
      rows.find(r => r.key === plain) ?? rows.find(r => r.key.startsWith(`${PLUGIN}@`) && r.key.endsWith(`.${field}`))
    if (hit !== undefined) return { key: hit.key, isLocked: hit.isLocked }
  } catch (err) {
    debug($, `options: config list failed: ${errText(err)}`)
  }
  return { key: plain, isLocked: false }
}

/**
 * Writes one option, from a press only: `$.config.set` on its row. A deny,
 * a locked row or a failure leaves it as it was and says why in a toast.
 * Never throws.
 */
export async function setOption($: EngineInterface, f: Field, value: ConfigValue): Promise<void> {
  try {
    const row = await rowOf($, f.field)
    if (row.isLocked) {
      $.ui.toast(`${f.label} not changed: your organization sets it.`)
      return
    }
    const got = await $.config.set({ key: row.key, value })
    if (got.deny !== undefined) {
      $.ui.toast(`${f.label} not changed: ${got.deny}`)
      return
    }
    written.set(f.field, got.value)
    if (f.field === 'accent') setAccent(got.value)
    // R53: previewed at once above the prompt (the strip on or off; the band's two rows), while the pane and this
    // page stay open so the person can step through all three. Leaving Options applies the rest (`leaveOptions`).
    if (f.field === 'showAs') await applyShowAs($, got.value, { keepPane: true })
    $.ui.invalidate('ui.render')
    const when = f.applies === 'now' ? '' : ` (applies ${f.applies})`
    $.ui.toast(`${f.label}: ${shownValue(f, got.value)}${when}`)
  } catch (err) {
    debug($, `options: set ${f.field} failed: ${errText(err)}`)
    $.ui.toast(`${f.label} not changed: ${errText(err)}`)
  }
}

/** The values a time limit steps through on Enter (minutes; 0 is off). */
const LIMIT_STEPS = [0, 30, 45, 60, 90, 120, 180, 240] as const

/** The value after `v` for a row's press (R52): a switch flips, a choice takes the next one (wrapping), a number its next step. */
export function nextValue(f: Field, v: ConfigValue | undefined): ConfigValue | undefined {
  if (f.kind === 'boolean') return v !== true
  if (f.kind === 'choice') {
    const cs = f.choices ?? []
    if (cs.length === 0) return undefined
    const i = cs.indexOf(typeof v === 'string' ? v : '')
    return cs[(i + 1) % cs.length]
  }
  if (f.kind === 'number') {
    const n = typeof v === 'number' ? v : 0
    if (f.offAtZero === true) return LIMIT_STEPS.find(x => x > n) ?? 0
    const max = f.max ?? Number.MAX_SAFE_INTEGER
    const up = n + (f.step ?? 1)
    return up > max ? 0 : up
  }
  return undefined
}

/**
 * A row's press (R52): the value changes in place, with no rows opening
 * under it, and the ring is put back on the same row once the write has
 * landed (a config write may redraw, or reload, the pane). Text points to
 * /config.
 */
async function pressRow($: EngineInterface, f: Field): Promise<void> {
  if (f.kind === 'text') {
    $.ui.toast(`${f.label} takes text: change it in /config.`)
    return
  }
  const next = nextValue(f, valueOf(f.field))
  if (next === undefined) return
  await setOption($, f, next)
  try {
    await $.ui.focus({ requestId: PANE_ID, key: `opt-${f.field}` })
  } catch (err) {
    debug($, `options: refocus ${f.field} failed: ${errText(err)}`)
  }
}

/** Opens Options, or closes it when it is open. From a press or a command only. */
export async function toggleOptions($: EngineInterface, isOpen: boolean): Promise<void> {
  if (isOpen) await leaveOptions($)
  else await openPage($, 'options', '')
}

/** Leaves the Options page (`0`, `b`): under `showAs: band` or `strip` the pane then closes (R53). */
export async function leaveOptions($: EngineInterface): Promise<void> {
  await closePage($)
  const v = showAsOption()
  if (v !== 'pane') await applyShowAs($, v)
}

// ---------- drawing ----------

/** The accent the page names: the option when declared, else iris. */
function accentName(): string {
  const v = valueOf('accent')
  return typeof v === 'string' && v !== '' ? v : 'iris'
}


/** Where a row's parts start at `cols`: the name at 4, the value at 38, when it applies at 50 (from 62 columns). */
function rowRuns(cols: number, name: Run, value: Run, applies: string): Run[] {
  if (cols >= 50) {
    const out: Run[] = [{ ...name, text: nameFit(name.text, 32).padEnd(34) }, { ...value, text: wordFit(value.text, 10) }]
    if (cols >= 62 && applies !== '') {
      out.push({ text: ' '.repeat(12 - Math.min(10, value.text.length)) }, { text: wordFit(applies, cols - 50), dim: true })
    }
    return out
  }
  const room = Math.max(4, cols - 4 - 2 - value.text.length)
  return [{ ...name, text: nameFit(name.text, room).padEnd(room + 2) }, value]
}

function optionRow(ctx: ViewCtx, $: EngineInterface, f: Field): RenderElement {
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  const v = valueOf(f.field)
  // R52: the right column says what Enter sets next (`↵ rich`, `↵ 90 min`), or when a change applies when that is not now.
  const after = nextValue(f, v)
  const next = f.kind === 'text' ? 'in /config' : f.applies !== 'now' ? f.applies : after !== undefined ? `↵ ${shownValue(f, after)}` : ''
  const runs = rowRuns(
    ctx.cols,
    { text: f.label },
    { text: shownValue(f, v), color: isOff(v) ? undefined : C.accent, dim: isOff(v) ? true : undefined },
    next,
  )
  return (
    <Box key={`opt-row-${f.field}`} flexDirection="row">
      <Text>{'    '}</Text>
      <Button key={`opt-${f.field}`} plain onPress={() => pressRow($, f)}>
        {runs.map((r, i) => runText(r, ctx.e, $, `opt-${f.field}-${i}`))}
      </Button>
    </Box>
  )
}

/** A row that cannot be pressed: the look this surface draws, or a field still to come. */
function infoRow(ctx: ViewCtx, $: EngineInterface, key: string, name: string, value: string, applies: string): RenderElement {
  const { Text } = $.ui.resolve(ctx.e)
  const runs = rowRuns(ctx.cols, { text: name }, { text: value, dim: true }, applies)
  return (
    <Text key={key}>
      {'    '}
      {runs.map((r, i) => runText(r, ctx.e, $, `${key}-${i}`))}
    </Text>
  )
}

/**
 * The Options page (R38, the cockpit look of the other pages): the frame's
 * top, a bold title with its readout, the preview, the frame's foot; then a
 * sentence-case section head for Look, Signals, Budget, Start (and More for a
 * field it does not know), each option one row Button; Never; the keys.
 * `open` is the field whose choices are opened under its row ('' for none).
 * Nothing here writes: only a press does.
 */
export function optionsPage(ctx: ViewCtx, $: EngineInterface, _open = ''): RenderElement {
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  const cols = Math.max(24, ctx.cols)
  const { left, right } = edges(cols)
  const ground = ctx.ground ?? 'night'
  const out: RenderElement[] = []
  // R52: no frame or preview; the title and how to change, then the options right away.
  const readout = '↵ changes the value'
  const room = right - left + 1
  out.push(
    <Text key="opt-title">
      {' '.repeat(left)}
      <Text bold>Options</Text>
      {room >= 'Options'.length + readout.length + 3 ? <Text dimColor>{`${' '.repeat(room - 'Options'.length - readout.length)}${readout}`}</Text> : null}
    </Text>,
  )
  const shown = fieldsShown()
  for (const name of SECTIONS) {
    const fields = shown.filter(f => f.section === name)
    const rows: RenderElement[] = []
    if (name === 'Look') {
      // Without the option declared, the row only says what this surface draws.
      if (!('look' in given)) rows.push(infoRow(ctx, $, 'opt-look', 'Look', ctx.look ?? 'text', 'this surface'))
      if (!('accent' in given)) rows.push(infoRow(ctx, $, 'opt-accent', 'Accent', 'iris', 'default'))
    }
    for (const f of fields) rows.push(optionRow(ctx, $, f))
    if (rows.length === 0) continue
    out.push(<Text key={`opt-gap-${name}`}>{' '}</Text>)
    out.push(section(ctx, $, name, undefined, { key: `opt-sec-${name}` }))
    out.push(...rows)
  }
  out.push(<Text key="opt-gap-never">{' '}</Text>)
  out.push(section(ctx, $, 'Never', undefined, { key: 'opt-sec-never' }))
  NEVER.forEach((line, i) => {
    out.push(
      <Text key={`opt-never-${i}`} dimColor>
        {`    ${wordFit(line, Math.max(1, cols - 4 - GRID.margin))}`}
      </Text>,
    )
  })
  // R3-B M10: the keys are the pane's footer, on its last row, in the footers' notation (`b back`, no colon), like every tab's.
  // Unfocused the hints are not drawn (the keys are not the pane's), but the page keeps a plain `back` to click.
  const foot =
    ctx.isFocused === true ? (
      footerSlot(ctx, $, [
        { key: '↵', label: 'change' },
        { key: '↑↓', label: 'move' },
        { hotkey: 'b', label: 'back', id: 'opt-back', onPress: () => leaveOptions($) },
      ])
    ) : (
      <Box key="opt-keys" flexDirection="row">
        <Text>{' '.repeat(left)}</Text>
        <Button key="opt-back" plain dimColor onPress={() => leaveOptions($)}>
          back
        </Button>
      </Box>
    )
  const used = out.reduce((n, el) => n + heightOf(el), 0)
  const pad = Math.max(1, (ctx.bodyRows ?? 46) - TAB_ROWS - 1 - used)
  for (let i = 0; i < pad; i++) out.push(<Text key={`opt-pad-${i}`}>{' '}</Text>)
  out.push(foot)
  return (
    <Box key="options" flexDirection="column">
      {out}
    </Box>
  )
}
