// The Options card (distillation item 6; rich spec "Options"): every option
// of the manifest's userConfig as a row with its value and when it applies,
// changed in the pane. Opened as a page (`ui.page = { kind: 'options' }`)
// by the tab bar's `0` (a Button hotkey takes only a digit or a lowercase
// letter, so the mock's `,` cannot be bound) or `/mc options`.
//
// A press is the only thing that writes: `$.config.set` on the row's key, as
// `$.config.list` names it (`mission-control.<field>`, or the `@inline` form a
// --plugin-dir load may use). A change reloads the mod with the new options
// (the type file's `Register`), so a value drawn here is the module's own;
// until that reload lands, the value just written is drawn.

import type { ConfigValue, EngineInterface, PluginOptions, RenderElement } from 'claude-code'

import { debug, errText } from '../state'
import { closePage, openPage } from './pagenav'
import { richDeck, runText, section } from './parts'
import type { InstSpec } from './parts'
import { drawBars, drawBeads, drawSprite, drawStack, Grid } from './raster'
import type { Hue } from './raster'
import type { ViewCtx } from './shell'
import { C, spriteOf } from './style'
import type { Run } from './style'

/** The hotkey that opens and closes Options (the tab bar's Button). */
export const OPTIONS_HOTKEY = '0'

const PLUGIN = 'mission-control'

type Section = 'LOOK' | 'SIGNALS' | 'BUDGET' | 'START' | 'MORE'
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

/** The accent's choices (R7, plan D5): the Raster hue, and its theme key for Text. */
const ACCENTS: Record<string, { hue: Hue; key: string }> = {
  iris: { hue: 'iris', key: 'suggestion' },
  ember: { hue: 'ember', key: 'claude' },
  mint: { hue: 'mint', key: 'success' },
  orchid: { hue: 'orchid', key: 'merged' },
}

/**
 * The fields the card knows, in its order. A field the manifest declares
 * and this list lacks is still drawn, under MORE, its kind from its value.
 * `accent` is drawn as coming until the manifest declares it.
 */
const FIELDS: readonly Field[] = [
  { field: 'accent', label: 'Accent', section: 'LOOK', applies: 'now', kind: 'choice', choices: Object.keys(ACCENTS) },
  { field: 'notify', label: 'Notify', section: 'SIGNALS', applies: 'now', kind: 'choice', choices: ['off', 'waits', 'done', 'all'] },
  { field: 'doneSound', label: 'Done sound', section: 'SIGNALS', applies: 'now', kind: 'boolean' },
  {
    field: 'agentLimitMin', label: 'Agent time limit', section: 'SIGNALS', applies: 'now',
    kind: 'number', step: 5, max: 600, unit: 'm', offAtZero: true,
  },
  {
    field: 'turnLimitMin', label: 'Turn time limit', section: 'SIGNALS', applies: 'now',
    kind: 'number', step: 5, max: 600, unit: 'm', offAtZero: true,
  },
  { field: 'showCost', label: 'Show cost', section: 'BUDGET', applies: 'now', kind: 'boolean' },
  { field: 'autoOpen', label: 'Open at start', section: 'START', applies: 'next start', kind: 'boolean' },
  { field: 'guide', label: 'Guide Claude', section: 'START', applies: 'new thread', kind: 'boolean' },
  { field: 'editor', label: 'Editor', section: 'START', applies: 'now', kind: 'text' },
]

const SECTIONS: readonly Section[] = ['LOOK', 'SIGNALS', 'BUDGET', 'START', 'MORE']

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
}

/** The value drawn for `field`: what a press just wrote, else the module's option. */
function valueOf(field: string): ConfigValue | undefined {
  return written.get(field) ?? given[field]
}

/** The fields the manifest declares, each with what the card knows of it. */
export function fieldsShown(): Field[] {
  const out: Field[] = []
  for (const f of FIELDS) if (f.field in given) out.push(f)
  for (const [field, v] of Object.entries(given)) {
    if (FIELDS.some(f => f.field === field)) continue
    const kind: Kind = typeof v === 'boolean' ? 'boolean' : typeof v === 'number' ? 'number' : 'text'
    out.push({ field, label: field, section: 'MORE', applies: 'now', kind, step: 1 })
  }
  return out
}

/** A value as the card says it: on/off, `20m`, `off` for a zero that turns it off. */
export function shownValue(f: Field, v: ConfigValue | undefined): string {
  if (v === undefined) return '—'
  if (typeof v === 'boolean') return v ? 'on' : 'off'
  if (typeof v === 'number') return v === 0 && f.offAtZero === true ? 'off' : `${v}${f.unit ?? ''}`
  if (typeof v === 'string') return v === '' ? '—' : v
  return v.join(', ')
}

const isOff = (v: ConfigValue | undefined): boolean => v === false || v === 0 || v === 'off'

/** One hotkey for each choice: its first letter or digit not taken (b is back, 0 closes, 1-5 are the tabs). */
export function choiceKeys(values: readonly string[]): (string | undefined)[] {
  const used = new Set(['b', OPTIONS_HOTKEY, '1', '2', '3', '4', '5'])
  return values.map(v => {
    for (const ch of v.toLowerCase()) {
      if (/[a-z0-9]/.test(ch) && !used.has(ch)) {
        used.add(ch)
        return ch
      }
    }
    return undefined
  })
}

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
    $.ui.invalidate('ui.render')
    const when = f.applies === 'now' ? '' : ` (applies ${f.applies})`
    $.ui.toast(`${f.label}: ${shownValue(f, got.value)}${when}`)
  } catch (err) {
    debug($, `options: set ${f.field} failed: ${errText(err)}`)
    $.ui.toast(`${f.label} not changed: ${errText(err)}`)
  }
}

/** A row's press: a switch flips, a choice or a number opens (or closes) under its row, text points to /config. */
async function pressRow($: EngineInterface, f: Field, isOpen: boolean): Promise<void> {
  if (f.kind === 'boolean') {
    await setOption($, f, valueOf(f.field) !== true)
    return
  }
  if (f.kind === 'text') {
    $.ui.toast(`${f.label} takes text: change it in /config.`)
    return
  }
  await openPage($, 'options', isOpen ? '' : f.field)
}

/** Opens Options, or closes it when it is open. From a press or a command only. */
export async function toggleOptions($: EngineInterface, isOpen: boolean): Promise<void> {
  if (isOpen) await closePage($)
  else await openPage($, 'options', '')
}

// ---------- drawing ----------

/** The accent the preview draws in: the option when declared and known, else iris. */
function accentOf(): { name: string; hue: Hue; key: string } {
  const v = valueOf('accent')
  const name = typeof v === 'string' && v in ACCENTS ? v : 'iris'
  const a = ACCENTS[name]!
  return { name, ...a }
}

const PREVIEW_TRACE = [2, 3, 5, 3, 6, 7, 5, 3, 2, 4, 6, 5, 3, 2]
const SPARK = '▁▂▃▄▅▆▇█'

/**
 * The PREVIEW instrument (mock `RichOptions`): three small characters, a
 * bead meter, a trace, a stack and the accent's name, 44 x 3; it redraws in
 * the chosen accent at once. Its text form: hulls, `▮▯` beads, a sparkline.
 */
function previewInst(now: number): InstSpec {
  const a = accentOf()
  const crew = [
    spriteOf({ id: 'main', type: 'main', status: 'running' }, now, 'working', 'S'),
    spriteOf({ id: 'p1', type: 'Explore', status: 'running' }, now, 'working', 'S'),
    spriteOf({ id: 'p2', type: 'general-purpose', status: 'running' }, now, 'waiting', 'S'),
  ]
  const hulls: Run[] = []
  for (const s of crew) hulls.push(...s.fallback[0]!.filter(r => r.text.trim() !== ''), { text: ' ' })
  const used = hulls.reduce((n, r) => n + r.text.length, 0)
  const max = Math.max(...PREVIEW_TRACE)
  const spark = PREVIEW_TRACE.map(v => SPARK[Math.min(7, Math.round((v / max) * 7))]).join('')
  return {
    key: 'opt-preview',
    columns: 44,
    rows: 3,
    sig: `preview:${a.name}`,
    frames: () => {
      const g = new Grid(44, 3)
      drawSprite(g, 0, 0, 'lead', 'working', 'S')
      drawSprite(g, 6, 0, 'scout', 'working', 'S')
      drawSprite(g, 12, 0, 'build', 'waiting', 'S')
      drawBeads(g, 19, 0, 14, 37, a.hue)
      drawBars(g, 19, 1, 2, PREVIEW_TRACE, () => a.hue)
      drawStack(g, 34, 0, 10, [[71, 'orchid'], [29, 'rest']])
      g.word(34, 2, a.name, a.hue)
      return [g]
    },
    fallback: [
      [
        ...hulls,
        { text: ' '.repeat(Math.max(1, 19 - used)) },
        { text: '▮▮▮', color: a.key },
        { text: '▯▯▯▯', color: C.subtle },
        { text: '   ' },
        { text: '■■■■■■■', color: C.model },
        { text: '■■■', color: C.subtle },
      ],
      [{ text: ' '.repeat(19) }, { text: spark, color: a.key }],
      [{ text: ' '.repeat(34) }, { text: a.name, color: a.key }],
    ],
  }
}

/** Where a row's parts start at `cols`: the name at 4, the value at 38, when it applies at 50 (from 62 columns). */
function rowRuns(cols: number, name: Run, value: Run, applies: string): Run[] {
  if (cols >= 50) {
    const out: Run[] = [{ ...name, text: name.text.slice(0, 32).padEnd(34) }, { ...value, text: value.text.slice(0, 10) }]
    if (cols >= 62 && applies !== '') {
      out.push({ text: ' '.repeat(12 - Math.min(10, value.text.length)) }, { text: applies.slice(0, cols - 50), dim: true })
    }
    return out
  }
  const room = Math.max(4, cols - 4 - 2 - value.text.length)
  return [{ ...name, text: name.text.slice(0, room).padEnd(room + 2) }, value]
}

function optionRow(ctx: ViewCtx, $: EngineInterface, f: Field, isOpen: boolean): RenderElement {
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  const v = valueOf(f.field)
  const runs = rowRuns(
    ctx.cols,
    { text: f.label, bold: isOpen ? true : undefined },
    { text: shownValue(f, v), color: isOff(v) ? undefined : C.accent, dim: isOff(v) ? true : undefined },
    f.applies,
  )
  return (
    <Box key={`opt-row-${f.field}`} flexDirection="row">
      <Text>{'    '}</Text>
      <Button key={`opt-${f.field}`} plain onPress={() => pressRow($, f, isOpen)}>
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

type Pick = { key: string; hotkey?: string; label: string; isOn?: boolean; onPress: () => void | Promise<void> }

/** The opened row's choices: plain hotkeyed Buttons from column 6, three apart, the current one bold. */
function picks(ctx: ViewCtx, $: EngineInterface, key: string, items: Pick[]): RenderElement {
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  const out: RenderElement[] = [<Text key={`${key}-in`}>{'      '}</Text>]
  items.forEach((p, i) => {
    if (i > 0) out.push(<Text key={`${key}-gap-${i}`}>{'   '}</Text>)
    out.push(
      <Button key={p.key} hotkey={p.hotkey} plain onPress={p.onPress}>
        {p.isOn === true ? (
          <Text color={C.accent} bold>
            {p.label}
          </Text>
        ) : (
          p.label
        )}
      </Button>,
    )
  })
  return (
    <Box key={key} flexDirection="row" flexWrap="wrap">
      {out}
    </Box>
  )
}

function choicePicks(ctx: ViewCtx, $: EngineInterface, f: Field): RenderElement {
  const values = f.choices ?? []
  const keys = choiceKeys(values)
  const cur = valueOf(f.field)
  return picks(
    ctx,
    $,
    `opt-picks-${f.field}`,
    values.map((v, i) => ({
      key: `opt-pick-${f.field}-${v}`,
      hotkey: keys[i],
      label: v,
      isOn: v === cur,
      onPress: () => setOption($, f, v),
    })),
  )
}

/** A number option's value now, read at the press: 0 when it holds no number. */
function numberOf(field: string): number {
  const v = valueOf(field)
  return typeof v === 'number' ? v : 0
}

function numberPicks(ctx: ViewCtx, $: EngineInterface, f: Field): RenderElement {
  const step = f.step ?? 1
  const max = f.max ?? Number.MAX_SAFE_INTEGER
  const n = numberOf(f.field)
  const items: Pick[] = [
    {
      key: `opt-less-${f.field}`,
      hotkey: 'l',
      label: `−${step}`,
      onPress: () => setOption($, f, Math.max(0, numberOf(f.field) - step)),
    },
    {
      key: `opt-more-${f.field}`,
      hotkey: 'm',
      label: `+${step}`,
      onPress: () => setOption($, f, Math.min(max, numberOf(f.field) + step)),
    },
  ]
  if (f.offAtZero === true) {
    items.push({ key: `opt-off-${f.field}`, hotkey: 'x', label: 'off', isOn: n === 0, onPress: () => setOption($, f, 0) })
  }
  return picks(ctx, $, `opt-picks-${f.field}`, items)
}

/**
 * The Options page: the PREVIEW deck, then LOOK, SIGNALS, BUDGET, START
 * (and MORE for a field it does not know), each option one row Button;
 * `NEVER`; the keys. `open` is the field whose choices are opened under its
 * row ('' for none). Nothing here writes: only a press does.
 */
export function optionsPage(ctx: ViewCtx, $: EngineInterface, open: string): RenderElement {
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  const out: RenderElement[] = []
  const deck = richDeck(ctx, $, [{ key: 'opt-preview-row', label: 'PREVIEW', inst: previewInst(ctx.now) }], {
    key: 'opt-deck',
    frame: { pill: 'OPTIONS', right: `${OPTIONS_HOTKEY} close` },
  })
  if (deck !== null) out.push(deck)
  const shown = fieldsShown()
  for (const name of SECTIONS) {
    const fields = shown.filter(f => f.section === name)
    const rows: RenderElement[] = []
    if (name === 'LOOK') {
      rows.push(infoRow(ctx, $, 'opt-look', 'Look', ctx.look ?? 'text', 'this surface'))
      if (!('accent' in given)) rows.push(infoRow(ctx, $, 'opt-accent', 'Accent', 'iris', 'coming'))
    }
    for (const f of fields) {
      rows.push(optionRow(ctx, $, f, open === f.field))
      if (open !== f.field) continue
      if (f.kind === 'choice') rows.push(choicePicks(ctx, $, f))
      if (f.kind === 'number') rows.push(numberPicks(ctx, $, f))
    }
    if (rows.length === 0) continue
    out.push(<Text key={`opt-gap-${name}`}>{' '}</Text>)
    out.push(<Box key={`opt-sec-${name}`}>{section(ctx, $, name, 'value', 'applies')}</Box>)
    out.push(...rows)
  }
  out.push(<Text key="opt-gap-never">{' '}</Text>)
  out.push(<Box key="opt-sec-never">{section(ctx, $, 'NEVER')}</Box>)
  NEVER.forEach((line, i) => {
    out.push(
      <Text key={`opt-never-${i}`} dimColor>
        {`    ${line}`}
      </Text>,
    )
  })
  out.push(<Text key="opt-gap-keys">{' '}</Text>)
  out.push(
    <Box key="opt-keys" flexDirection="row">
      <Text dimColor>{'  ↵ change   '}</Text>
      <Button key="opt-back" hotkey="b" plain onPress={() => closePage($)}>
        back
      </Button>
    </Box>,
  )
  return (
    <Box key="options" flexDirection="column">
      {out}
    </Box>
  )
}
