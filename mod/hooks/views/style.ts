import type { AgentRow, StepStatus, TaskItem } from '../../types'
import { accentPalette, BLINK_BEATS, CRITTER, critterFrames, critterPoseBox, MOVE_MS, moveFrames, SPRITE, sprite } from './raster'
import type { CritterRole, CritterSize, Grid, Ground, Move, Palette, PoseFrame, Size, State } from './raster'
import type { BurstOf } from './paint'

/**
 * The accent (R35): the theme key the structural colour draws in. `iris`
 * (default) is `suggestion`; `sky` is `ide` (the IDE blue) and `slate` is
 * `promptBorder` (the neutral prompt-box grey). None is a state colour
 * (`success`, `error`, `warning`) or a role hue (`merged`, `claude`).
 */
export const ACCENTS = { iris: 'suggestion', sky: 'ide', slate: 'promptBorder' } as const
export type AccentName = keyof typeof ACCENTS

/** The theme key of an accent option; anything unknown is iris. */
export function accentKeyOf(option: unknown): string {
  return typeof option === 'string' && Object.hasOwn(ACCENTS, option) ? ACCENTS[option as AccentName] : ACCENTS.iris
}

let accentKey: string = ACCENTS.iris

/**
 * Points `C.accent`, `C.live` and `CK.accent` at the accent option. Options
 * call it at register time (`configureOptions`) and on the Accent press, so a
 * press applies at once and no draw writes it (M9); every view reads one
 * structural colour with no per-view option read. Module configuration, not
 * session state.
 */
export function setAccent(option: unknown): void {
  accentKey = accentKeyOf(option)
}

/** The accent as its option name (`iris`, `sky`, `slate`), read from the same one value as `C.accent`. */
export function accentName(): AccentName {
  return (Object.keys(ACCENTS) as AccentName[]).find(n => ACCENTS[n] === accentKey) ?? 'iris'
}

/**
 * The Raster palette for a ground under the current Accent: the structural pieces (lintel, sill, gauges, bars,
 * the map and the effort chart) draw `iris` from here, so they follow the option as the text does. A critter
 * never reads this: its role hues come from `CREW_PALETTE`. Put `accentName()` in a piece's `sig`.
 */
export function palette(ground: Ground): Palette {
  return accentPalette(ground, accentName())
}

/**
 * The palette: theme keys only, so the pane follows the person's theme.
 * Views never write a colour literal.
 *
 * HUD v2 roles (spec "Type, colour, spacing"):
 * - `live` / `accent` (`suggestion`): structure and live things: `▍ ┌ ▸ ◂`,
 *   hotkeys, the open tab, its track, a bar's fill, find hits.
 * - `wait` (`warning`): waiting on the person: `?`, `▲`, the NEEDS YOU corner,
 *   a rate bar at 70 % or more.
 * - `fail` / `error` (`error`): `✖`, `!`, a FAILED value, a rate bar at 90 % or more.
 * - `model` / `doc` (`merged`): model share bars and documents.
 * - `result` (`success`): artifact results only.
 * - `subtle` / `rule` (`subtle`): a bar's rest, the tab track, tree guides.
 * - Meta is `dimColor`, not a key.
 *
 * Neo adds (spec "Palette"): `lead` / `spark` (`claude`) for the lead's
 * working hull and the kept `★`, and `inverse` (`inverseText`) for the text
 * on a pill. Brackets, working hulls, bars and dials under 70 % are `live`;
 * rails, tethers and a bar's rest are `subtle`; waiting and stalled hulls,
 * `?` and `z` are `wait`; failed hulls and `!` are `fail`.
 */
export const C = {
  get accent(): string { return accentKey },
  get live(): string { return accentKey },
  wait: 'warning',
  error: 'error',
  fail: 'error',
  model: 'merged',
  doc: 'merged',
  result: 'success',
  rule: 'subtle',
  subtle: 'subtle',
  /** Neo: the lead's hull while it works (`podOf`). */
  lead: 'claude',
  /** Neo (spec `C.spark`): the kept `★`. The sparkline itself stays in the accent. */
  spark: 'claude',
  /** Neo: the text on a pill (`pillRun`, `pill`). */
  inverse: 'inverseText',
} as const

/**
 * A styled piece of one line. Colours are theme keys from `C`; `dim` is
 * `dimColor`; `bg` is the Text's `backgroundColor` (a pill).
 */
export type Run = { text: string; color?: string; bold?: boolean; dim?: boolean; underline?: boolean; bg?: string }

/**
 * The character grid. One column is one character; a cell is 12 columns,
 * 10 of content and 2 of gap. Column 0 is the gutter, column 1 is blank,
 * content starts at `margin` (2).
 */
export const GRID = { margin: 2, cell: 12, content: 10 } as const

/**
 * The fixed start columns at 62 columns (spec "Grid"). A table row narrower
 * than 62 takes its metric and time columns from `tableCols`.
 * - `gutter` 0: `▍`, `┌`, the row flags `◂` and `!`
 * - `glyph` 2: a row's glyph, a section label (the first cell)
 * - `name` 4: a row's name (6 and 8 at tree depth 1 and 2)
 * - `detailKey` 6: an opened row's dim key; `action` 6: its action line
 * - `arg` 10: a step's argument after its 5-wide tool name at 4
 * - `detailValue` 14: an opened row's value (the second cell)
 * - `nameEnd` 36: a name ends by here (exclusive) when a metric follows
 * - `metric` 38: a table row's one metric, at most 10 wide
 * - `time` 50: a table row's time, at most 10 wide
 */
export const COL = {
  gutter: 0,
  glyph: 2,
  name: 4,
  detailKey: 6,
  action: 6,
  arg: 10,
  detailValue: 14,
  nameEnd: 36,
  metric: 38,
  time: 50,
} as const

/**
 * @deprecated Neo deck stops. The cockpit's columns are `COCKPIT` (the spec's
 * new `DECK`: text 9, gauges 40 and 51, mid 49, right 59).
 *
 * A deck row's stops at 62 columns (spec "Label column"): the rail at 0, a dim
 * caps label at 2 (to 11), the gauge at 14 (22 wide, to 35), the value at 38
 * (10 wide), the aside at 50 (ends by 59), the right rail at the last column
 * (61). The same stops as a table's name, metric and time. `ring` (39) is
 * where the Now hero's three rings start (23 wide, to 61; Neo Rich).
 */
export const DECK = { rail: 0, label: 2, gauge: 14, value: 38, aside: 50, ring: 39 } as const

/** The start column of cell `i` (0-based): 2, 14, 26, 38, 50, … */
export function cellCol(i: number): number {
  return GRID.margin + i * GRID.cell
}

/** How many readout cells fit `cols`: min(5, floor((cols − 2) / 12)), never negative. */
export function cellsFor(cols: number): number {
  return Math.max(0, Math.min(5, Math.floor((cols - GRID.margin) / GRID.cell)))
}

/** The width tier of a pane body: wide ≥ 62, mid 38 to 61, icon 32 to 37, slim under 32. */
export type Tier = 'wide' | 'mid' | 'icon' | 'slim'

/** The tier of `cols` (spec "Widths"). */
export function tier(cols: number): Tier {
  if (cols >= 62) return 'wide'
  if (cols >= 38) return 'mid'
  if (cols >= 32) return 'icon'
  return 'slim'
}

/**
 * Where a table row's columns fall at `cols`:
 * - 5 cells (≥ 62): metric at 38, time at 50, the name ends by 36
 * - 3 or 4 cells (38 to 61): time on the last cell (38 or 26), no metric
 * - fewer (under 38): the name only, to the edge
 * `nameEnd` is exclusive: the name's last character sits at `nameEnd − 1`.
 */
export function tableCols(cols: number): { nameEnd: number; metric?: number; time?: number } {
  const cells = cellsFor(cols)
  if (cells >= 5) return { nameEnd: COL.nameEnd, metric: COL.metric, time: COL.time }
  if (cells >= 3) {
    const time = cellCol(cells - 1)
    return { nameEnd: time - 2, time }
  }
  return { nameEnd: cols }
}

/** The colour of a rate or context bar at `pct`: the accent, `warning` from 70, `error` from 90. */
export function rateColor(pct: number): string {
  if (pct >= 90) return C.fail
  if (pct >= 70) return C.wait
  return C.live
}

/**
 * The HUD v2 colour of a status glyph: live in the accent, a failure in
 * `error`; undefined means dim (done, pending, interrupted).
 */
export function statusColor(status: StepStatus | AgentRow['status'] | TaskItem['status']): string | undefined {
  switch (status) {
    case 'running':
    case 'in_progress':
      return C.live
    case 'error':
    case 'denied':
      return C.fail
    default:
      return undefined
  }
}

// ---------- Neo: the identity (spec "Identity") ----------

/** A crew member's role: the shape of its hull. */
export type Role = 'lead' | 'scout' | 'build' | 'check'

/**
 * A crew member's state: the fill of its hull, its colour and its signal.
 * `waiting` (on the person) and `stalled` come from the model's problems
 * (`asking`, `stalled`); the others follow `AgentRow.status`.
 */
export type PodState = 'queued' | 'working' | 'waiting' | 'stalled' | 'failed' | 'done'

/** Every structural glyph Neo draws, so one constant can swap the whole set. */
export type GlyphSet = {
  /** Per role: [outline (queued, failed), lit core (working, waiting, stalled), solid (done)]. */
  hull: Record<Role, readonly [string, string, string]>
  /** The signal cell after a hull. */
  signal: { waiting: string; stalled: string; failed: string }
  /** A dial for 0, up to 25, up to 50, under 100, and 100 %. */
  dial: readonly [string, string, string, string, string]
  /** A bar's lit and resting cells. */
  bar: { lit: string; rest: string }
  /** Task pips: done, current, queued. */
  pip: readonly [string, string, string]
  /** Eight sparkline levels, lowest first. */
  sparks: readonly [string, string, string, string, string, string, string, string]
  /** A deck's twin bracket. */
  rail: { top: string; mid: string; bottom: string; topRight: string; bottomRight: string }
  /** A tree's dashed tethers (2 wide) and its outer guide (1 wide). */
  tether: { mid: string; last: string; guide: string }
}

/** The Neo glyphs: every hull in Geometric Shapes (U+25A0 to U+25FF). */
export const UNICODE: GlyphSet = {
  hull: {
    lead: ['◇', '◈', '◆'],
    scout: ['○', '◉', '●'],
    build: ['□', '▣', '■'],
    check: ['△', '◬', '▲'],
  },
  signal: { waiting: '?', stalled: 'z', failed: '!' },
  dial: ['○', '◔', '◑', '◕', '●'],
  bar: { lit: '▮', rest: '▯' },
  pip: ['▪', '▸', '▫'],
  sparks: ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'],
  rail: { top: '┏', mid: '┃', bottom: '┗', topRight: '┓', bottomRight: '┛' },
  tether: { mid: '├╌', last: '╰╌', guide: '┆' },
}

/**
 * The fallback for terminals whose font lacks the shapes (spec: `<> () [] /\`,
 * state by colour and signal). A hull's outline is the role's opening
 * character and its lit and solid forms the closing one; colour, bold, dim
 * and the signal cell tell the states apart. Not wired to an option yet:
 * point `GLYPHS` at it to use it.
 */
export const ASCII: GlyphSet = {
  hull: {
    lead: ['<', '>', '>'],
    scout: ['(', ')', ')'],
    build: ['[', ']', ']'],
    check: ['/', '\\', '\\'],
  },
  signal: { waiting: '?', stalled: 'z', failed: '!' },
  dial: ['.', ':', '+', '*', '#'],
  bar: { lit: '#', rest: '.' },
  pip: ['*', '>', '.'],
  sparks: ['_', '.', ',', '-', '~', '=', '+', '#'],
  rail: { top: '+', mid: '|', bottom: '+', topRight: '+', bottomRight: '+' },
  tether: { mid: '|-', last: '`-', guide: ':' },
}

/** The glyph set every Neo primitive draws with. The one switch for the ASCII fallback. */
export const GLYPHS: GlyphSet = UNICODE

/** A deck's bracket: `┏ ┃ ┗` in column 0, `┓ ┃ ┛` in the last column. */
export const RAIL = GLYPHS.rail

/** A tree's tethers: `├╌` and `╰╌` (2 wide), and `┆` as the outer guide two deep. */
export const TETHER = GLYPHS.tether

/**
 * The role of an agent type, matched case-insensitively on substrings:
 * `main` (the main conversation) and any type holding `plan` lead;
 * `explore`, `search` (and so `research`) scout; `review`, `test` or `verif`
 * check; everything else, `general-purpose`, workflow agents and unknown
 * types included, builds. Checked in that order.
 *
 * @example roleOf('Explore')         // 'scout'
 * @example roleOf('code-reviewer')   // 'check'
 * @example roleOf('general-purpose') // 'build'
 */
export function roleOf(agentType: string): Role {
  const t = agentType.toLowerCase()
  if (t === 'main' || t.includes('plan')) return 'lead'
  if (t.includes('explore') || t.includes('search')) return 'scout'
  if (t.includes('review') || t.includes('test') || t.includes('verif')) return 'check'
  return 'build'
}

/**
 * What `podOf` reads of an agent: an `AgentRow` fits. `subagentType`, where a
 * caller has it, wins over `type` for the role; `state` (from the model's
 * problems: `waiting`, `stalled`; or `queued`) wins over `status`.
 */
export type PodAgent = Pick<AgentRow, 'id' | 'type' | 'status'> & { subagentType?: string; state?: PodState; startedAt?: number }

/** The state of a pod: `agent.state` when given, else running works, error fails, done is done. */
export function podStateOf(agent: PodAgent): PodState {
  if (agent.state !== undefined) return agent.state
  if (agent.status === 'error') return 'failed'
  if (agent.status === 'done') return 'done'
  return 'working'
}

/**
 * One crew member: its hull (a one-cell Run) and, when it has one, its
 * signal (a one-cell Run: `?`, `z` or `!`).
 */
export type Pod = { role: Role; state: PodState; hull: Run; signal?: Run }

/** The pulse: bold on even seconds of the existing 1 s clock (`ctx.now`), plain on odd ones. */
export function pulseOn(now: number): boolean {
  return Math.floor(now / 1000) % 2 === 0
}

/**
 * An agent as a pod (spec "Crew: pods"): the hull's shape is the role, its
 * fill the state, its colour the urgency.
 * - queued: outline, dim
 * - working: lit core in the accent (the lead in `claude`), bold on the even
 *   second and plain on the odd one (`pulseOn(now)`; no timer of its own)
 * - waiting: lit core, bold, in `warning`; signal `?` bold in `warning`
 * - stalled: lit core, dim; signal `z` in `subtle` (R19: no amber outside a dialog)
 * - failed: outline in `error`; signal `!` bold in `error`
 * - done: solid, dim
 * The role is `roleOf(subagentType ?? type)`; `main` is always the lead.
 * Hull glyphs come only from here.
 *
 * @example
 * const p = podOf(agent, ctx.now) // { role: 'scout', state: 'working', hull: { text: '◉', color: 'suggestion', bold: true } }
 * const q = podOf({ ...agent, state: 'waiting' }, ctx.now) // q.signal: { text: '?', color: 'warning', bold: true }
 * row(ctx, $, { key, flag: q.signal !== undefined ? 'problem' : undefined, glyph: p.hull.text, glyphColor: p.hull.color, name })
 */
export function podOf(agent: PodAgent, now: number): Pod {
  const role = agent.id === 'main' ? 'lead' : roleOf(agent.subagentType ?? agent.type)
  const state = podStateOf(agent)
  const [outline, lit, solid] = GLYPHS.hull[role]
  const sig = GLYPHS.signal
  switch (state) {
    case 'queued':
      return { role, state, hull: { text: outline, dim: true } }
    case 'working': {
      const color = role === 'lead' ? C.lead : C.live
      return { role, state, hull: pulseOn(now) ? { text: lit, color, bold: true } : { text: lit, color } }
    }
    case 'waiting':
      return { role, state, hull: { text: lit, color: C.wait, bold: true }, signal: { text: sig.waiting, color: C.wait, bold: true } }
    case 'stalled':
      return { role, state, hull: { text: lit, dim: true }, signal: { text: sig.stalled, color: C.subtle } }
    case 'failed':
      return { role, state, hull: { text: outline, color: C.fail }, signal: { text: sig.failed, color: C.fail, bold: true } }
    case 'done':
      return { role, state, hull: { text: solid, dim: true } }
  }
}

/**
 * A one-cell dial for `pct`: `○` at 0 or less, `◔` up to 25, `◑` up to 50,
 * `◕` under 100, `●` at 100 or more; in `rateColor(pct)`.
 *
 * @example dialOf(9)  // { text: '◔', color: 'suggestion' }
 * @example dialOf(78) // { text: '◕', color: 'warning' }
 */
export function dialOf(pct: number): Run {
  const d = GLYPHS.dial
  const p = Number.isFinite(pct) ? pct : 0
  const text = p <= 0 ? d[0] : p <= 25 ? d[1] : p <= 50 ? d[2] : p < 100 ? d[3] : d[4]
  return { text, color: rateColor(p) }
}

// ---------- Neo Rich: the look and the crew as Rasters (rich spec) ----------

/**
 * How a surface draws (spec "Surfaces and fallbacks"): `rich` with Rasters
 * (the terminal), `svg` with one Svg deck (desktop, VS Code, mobile; R6),
 * `text` the Neo text form. Until R6 lands, `svg` draws the text form.
 */
export type Look = 'rich' | 'svg' | 'text'

/** What `lookOf` reads of the options: `look: 'text'` asks for the text form everywhere. */
export type LookOptions = { look?: string }

/** One cell at the terminal's default colours, as `RasterProps.cells` takes it. */
const PROBE_CELL = 'IAAAAAAAAAEAAAAB'

/**
 * Whether `table` really draws `name`: the engine hands out every surface's
 * table completed with every element name, an element the surface lacks
 * constructing a Box (a fragment there), so a key being present says
 * nothing. The constructor is a pure function from props to a plain
 * element; one throwaway element tells.
 */
function draws(table: object, name: string, props: Record<string, unknown>): boolean {
  const make: unknown = (table as Record<string, unknown>)[name]
  if (typeof make !== 'function') return false
  try {
    const el: unknown = make(props)
    return typeof el === 'object' && el !== null && (el as { type?: unknown }).type === name
  } catch {
    return false
  }
}

/**
 * The look for a surface, from its element table (`$.ui.resolve(e)`), never
 * from its name: a table whose `Raster` makes a Raster is rich, one whose
 * `Svg` makes an Svg is svg, any other text. The option `look: 'text'` wins
 * on every table; any other value follows the table. Call it once per draw.
 *
 * @example const look = lookOf($.ui.resolve(e), { look: options.look })
 */
export function lookOf(table: object, options: LookOptions = {}): Look {
  if (options.look === 'text') return 'text'
  if (draws(table, 'Raster', { key: 'look-probe', columns: 1, rows: 1, cells: PROBE_CELL })) return 'rich'
  if (draws(table, 'Svg', { source: '<svg xmlns="http://www.w3.org/2000/svg"/>', alt: 'look probe' })) return 'svg'
  return 'text'
}

/**
 * One crew member as an instrument: what `inst` mounts. `frames` draws the
 * sprite (two frames, lamp on and dim, while working; one otherwise);
 * `fallback` is its text form in the same box (hull and signal on the first
 * row, from `podOf`); `sig` changes only with role, state and size, so the
 * paint clock re-encodes it only then.
 */
export type SpriteArgs = {
  role: Role
  state: State
  size: Size
  columns: number
  rows: number
  sig: string
  frames: () => Grid[]
  fallback: Run[][]
}

/**
 * @deprecated Neo Rich sprites. Use `critterOf` (Critters, small and micro).
 *
 * An agent as a sprite (the rich form of `podOf`, which stays the text form):
 * role from `roleOf` (`main` is the lead), state from `state` when given,
 * else the agent's own (`podStateOf`). Size `L` is 9 x 4 cells, `S` 5 x 2
 * (the badge column included).
 *
 * @example
 * const s = spriteOf(agent, ctx.now)
 * inst(ctx, $, { key: `who-${agent.id}`, ...s })
 */
export function spriteOf(agent: PodAgent, now: number, state?: PodState, size: Size = 'L'): SpriteArgs {
  const pod = podOf(state !== undefined ? { ...agent, state } : agent, now)
  const box = SPRITE[size]
  const role = pod.role
  const st: State = pod.state
  const first: Run[] = [pod.hull]
  if (pod.signal !== undefined) first.push(pod.signal)
  const used = first.reduce((n, r) => n + r.text.length, 0)
  first.push({ text: ' '.repeat(Math.max(0, box.columns - used)) })
  const fallback: Run[][] = [first]
  for (let i = 1; i < box.rows; i++) fallback.push([{ text: ' '.repeat(box.columns) }])
  return {
    role,
    state: st,
    size,
    columns: box.columns,
    rows: box.rows,
    sig: `sprite:${role}:${st}:${size}`,
    frames: () =>
      st === 'working'
        ? [sprite(role, st, size, { lamp: 'on' }), sprite(role, st, size, { lamp: 'dim' })]
        : [sprite(role, st, size)],
    fallback,
  }
}

// ---------- the cockpit (cockpit spec "Palette", "Spacing and type"; rulings R19 to R25) ----------

/**
 * The cockpit's text roles, as theme keys (owner ruling 1: text and every
 * non-sprite element use these; the role hues stay inside critters).
 * - `accent` (`suggestion`, iris): now: the current task, the open tab, the
 *   one filled button, hotkeys. Done segments are the accent dimmed (iris
 *   soft has no theme key; it is a Raster hue).
 * - `ask` (`warning`, amber): a dialog waits (Needs you) and nothing else (R9).
 * - `fail` (`error`, red): a failure you can open; a gauge at 90 %.
 * - `ok` (`success`, mint): the all-clear tick, `ALL DONE`.
 * - `rule` (`subtle`): hairlines, open circles, a bar's rest.
 * - ink is the default colour, dim is `dimColor`: neither is a key.
 * - `inverse` (`inverseText`): the text on a pill.
 */
export const CK = {
  get accent(): string { return accentKey },
  ask: 'warning',
  fail: 'error',
  ok: 'success',
  rule: 'subtle',
  inverse: 'inverseText',
} as const

/**
 * The cockpit's columns at 62 (cockpit spec "Spacing and type"; the spec's new
 * `DECK`, under its own name while the Neo views still read `DECK`):
 * - `marker` 0: the gutter, only `▍` and `◂`
 * - `left` 2: content starts
 * - `text` 9: the header's kicker and headline, an agent card's name and job
 * - `gauge` 40, `gauge2` 51: the header's two 9 x 5 gauges
 * - `mid` 49: a second figure ends here (tokens)
 * - `right` 59: content ends; times end here
 * - `headline` 29: the headline's width beside the gauges
 */
export const COCKPIT = { marker: 0, left: 2, text: 9, gauge: 40, gauge2: 51, mid: 49, right: 59, headline: 29 } as const

/**
 * Where content runs at a body width (narrow tiers scale per the spec): from
 * 2 to `cols - 3` (59 at 62) with two gutter columns each side; under 32
 * columns (slim) from 1 to `cols - 2`.
 */
export function edges(cols: number): { left: number; right: number } {
  return cols < 32 ? { left: 1, right: Math.max(1, cols - 2) } : { left: 2, right: Math.max(2, cols - 3) }
}

/** A frame or pill tone, and its theme key: iris works, amber asks, mint is all done, red stopped. */
export type Tone4 = 'iris' | 'amber' | 'mint' | 'red'

/** The theme key of a tone, for Text (a pill's background, a clamp's text form). */
export function toneKey(tone: Tone4): string {
  return tone === 'amber' ? CK.ask : tone === 'mint' ? CK.ok : tone === 'red' ? CK.fail : CK.accent
}

/**
 * A gauge's text style (R9: amber is the dialog colour only): dim under 70 %,
 * bold ink from 70, red from 90. Used for the word under a gauge and a gauge
 * written as words.
 */
export function gaugeStyle(pct: number): Omit<Run, 'text'> {
  if (pct >= 90) return { color: CK.fail }
  if (pct >= 70) return { bold: true }
  return { dim: true }
}

/** The ground a Raster is drawn for: `day` on light themes, `night` on the rest (R21). */
export type { Ground }

/**
 * The ground for the `ground` option and the theme's name (R21): `night` and
 * `day` win; `auto` (and anything else) reads the theme: a light theme
 * (`light`, `light-daltonized`, `light-ansi`, any name with "light") gives
 * day, every other theme (and no theme) night.
 *
 * @example groundOf(options.ground, await themeOf($)) // 'day' on the light theme
 */
export function groundOf(option: unknown, theme: string | undefined): Ground {
  if (option === 'night' || option === 'day') return option
  return theme !== undefined && /light/i.test(theme) ? 'day' : 'night'
}

/**
 * Whether a theme draws in the text look by default (R21): the ANSI themes
 * (16 colours: a Raster's hex would ignore the person's palette) and the
 * daltonized ones (role hues are told apart by hue). The `look` option still wins.
 */
export function isTextTheme(theme: string | undefined): boolean {
  return theme !== undefined && /ansi|dalton/i.test(theme)
}

/**
 * The `look` option as `lookOf` should read it (R21). `rich` and `text` are
 * explicit and win. `auto` (the default, and an unset option) means rich,
 * except text on an ANSI or daltonized theme; where the surface cannot draw a
 * Raster, `lookOf` gives the text (or desktop Svg) form whatever this says.
 * Returns the value to hand `lookOf`, or undefined to follow the surface.
 *
 * @example lookFor(table, surface, { look: lookAsked(options.look, theme) })
 */
export function lookAsked(option: string | undefined, theme: string | undefined): string | undefined {
  if (option === 'rich' || option === 'text') return option
  return isTextTheme(theme) ? 'text' : undefined
}

/**
 * The theme's name from `/config` (the `theme` row of `$.config.list()`), or
 * undefined when it cannot be read. Async: call it outside a draw (the shell
 * reads it once per open and on `config.set`) and hand the result to
 * `groundOf` and `isTextTheme`.
 */
export async function themeOf($: { config: { list: () => Promise<{ key: string; value: unknown }[]> } }): Promise<string | undefined> {
  try {
    const row = (await $.config.list()).find(r => r.key === 'theme')
    return typeof row?.value === 'string' ? row.value : undefined
  } catch {
    return undefined
  }
}

/** Whether the `motion` option allows the blink and the sweep (R24): on unless it says `off` (or false). */
export function motionOn(option: unknown): boolean {
  return option !== 'off' && option !== false
}

/**
 * An agent's role for its critter: only `main` is the lead (ember means the
 * lead, R20); every other agent takes `roleOf` of its type, a planning agent
 * (which `roleOf` calls lead) drawing the builder hat, a type that names
 * building the hat too, and general-purpose and unknown types the plain
 * general mascot (R23, amended).
 */
export function crewRole(agentId: string, agentType: string): CritterRole {
  if (agentId === 'main') return 'lead'
  const t = agentType.toLowerCase()
  const r = roleOf(agentType)
  if (r === 'lead') return 'build'
  if (r !== 'build') return r
  return t.includes('build') || t.includes('implement') || t.includes('develop') || t.includes('engineer') ? 'build' : 'general'
}

const TYPE_NAMES: Record<string, string> = {
  main: 'Claude',
  'general-purpose': 'General',
  explore: 'Explorer',
  plan: 'Planner',
}

/**
 * An agent type in friendly case for the name column (R23: the role word
 * never lies; the hat is only a hint): `general-purpose` is "General",
 * `Explore` "Explorer", `Plan` "Planner", `main` "Claude"; any other type
 * has its hyphens and underscores turned to spaces, its camel case parted,
 * and only its first letter capitalised ("code-reviewer" is "Code reviewer").
 */
export function typeName(agentType: string): string {
  // R3-B M6: a plugin's prefix is dropped ("superpowers:code-reviewer" is "Code reviewer").
  const t = (agentType.includes(':') ? agentType.slice(agentType.lastIndexOf(':') + 1) : agentType).trim()
  const known = TYPE_NAMES[t.toLowerCase()]
  if (known !== undefined) return known
  const words = t
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter(w => w !== '')
    .map(w => w.toLowerCase())
  if (words.length === 0) return 'Agent'
  const s = words.join(' ')
  return s[0]!.toUpperCase() + s.slice(1)
}

/** The role word a critter's text form writes (R22): the hat it wears. */
export const ROLE_WORD: Record<CritterRole, string> = { lead: 'lead', scout: 'scout', build: 'build', check: 'check', general: 'agent' }

/**
 * A critter's state glyph and badge as text (R22: one state glyph in the
 * state colour, then the role word): queued `○` dim, working `●` in the
 * accent, waiting `●` with `?` in amber, stalled `●` with `z` dim, failed
 * `×` with `!` in red, done `✓` dim.
 */
export function critterGlyph(state: PodState): { glyph: Run; badge?: Run } {
  switch (state) {
    case 'queued':
      return { glyph: { text: '○', dim: true } }
    case 'working':
      return { glyph: { text: '●', color: CK.accent } }
    case 'waiting':
      return { glyph: { text: '●', color: CK.ask }, badge: { text: '?', color: CK.ask, bold: true } }
    case 'stalled':
      return { glyph: { text: '●', dim: true }, badge: { text: 'z', dim: true } }
    case 'failed':
      return { glyph: { text: '×', color: CK.fail }, badge: { text: '!', color: CK.fail, bold: true } }
    case 'done':
      return { glyph: { text: '✓', dim: true } }
  }
}

/** What `critterOf` reads besides the agent. */
export type CritterOpts = {
  /** The state, when the model's problems know better than the row (waiting, stalled, queued). */
  state?: PodState
  /** `small` (default) or `micro`. */
  size?: CritterSize
  ground?: Ground
  /** The blink (R24): pass it only where the spec allows it (not the band, not idle). */
  motion?: boolean
  /** Shifts the blink so agents blink apart; `critterOf` derives one from the id when absent. */
  phase?: number
  /** Whether the text form writes the role word under the glyph: `critterArgs` does (the header's lead), `critterOf` does not, since a name stands beside it (R43). */
  roleWord?: boolean
  /**
   * When the state began (an agent's start, an ask's time): a critter drawn
   * for the first time within `APPEAR_FRESH_MS` of it plays its arrival once
   * (working: the wake hop; waiting: the glance and hop). `critterOf` gives
   * the agent's start.
   */
  since?: number
  /** One frame of a move drawn in place of the still critter (10: the lead on the finish sweep's frames). */
  pose?: PoseFrame
}

/** A critter met for the first time this soon after its state began plays its arrival (motion sketches 2 and 4). */
export const APPEAR_FRESH_MS = 2000

/** The state part of a critter's tag (`working@1700000`). */
const tagState = (tag: string | undefined): string | undefined => tag?.split('@')[0]

/**
 * The one-shot move a critter plays when its state changes (motion sketches
 * 2, 3, 4, 8, 9), from the state it showed before:
 *   - working after done or queued (the lead woken by a prompt, a queued agent starting), or a new card just started: the wake
 *   - done after working, waiting or stalled (not the lead: the finish sweep moves it): the nod and fade, then the card folds
 *   - waiting after anything else, or a new asker just asked: the glance toward the badge and one hop
 *   - stalled after working: eyes shut, a slow sink
 *   - failed after working, waiting or stalled: the flinch
 */
export function critterMove(role: CritterRole, prev: string | undefined, state: PodState, since: number | undefined, now: number): { move: Move; once?: string } | undefined {
  const was = tagState(prev)
  const fresh = since !== undefined && now - since >= 0 && now - since < APPEAR_FRESH_MS
  if (was === undefined || (was === state && prev !== undefined)) {
    // New to the registry (or a new ask under the same key): only an arrival this fresh moves, once.
    if (!fresh) return undefined
    if (state === 'working') return { move: 'wake', once: `wake@${since}` }
    if (state === 'waiting') return { move: 'ask', once: `ask@${since}` }
    return undefined
  }
  if (was === state) return undefined
  const live = was === 'working' || was === 'waiting' || was === 'stalled'
  if (state === 'working' && (was === 'done' || was === 'queued')) return { move: 'wake' }
  if (state === 'done' && live && role !== 'lead') return { move: 'settle' }
  if (state === 'waiting') return { move: 'ask' }
  if (state === 'stalled' && was === 'working') return { move: 'stall' }
  if (state === 'failed' && live) return { move: 'fail' }
  return undefined
}

/** A critter's burst picker for `inst` (paint.ts `trackBurst`). */
function critterBurst(role: CritterRole, state: PodState, size: CritterSize, ground: Ground, since: number | undefined): BurstOf {
  return (prev, now) => {
    const m = critterMove(role, prev, state, since, now)
    if (m === undefined) return undefined
    return {
      frames: () => moveFrames(m.move).map(f => critterPoseBox(role, size, f, ground)),
      ms: MOVE_MS[m.move],
      ...(m.move === 'settle' ? { end: 'redraw' as const } : {}),
      ...(m.once !== undefined ? { once: m.once } : {}),
    }
  }
}

/**
 * One critter as an instrument: what `inst` mounts (add a `key`). The box is
 * the body and the badge column: 6 x 3 small, 5 x 2 micro. `fallback` is its
 * text form at the same size (R22): the state glyph and the badge on the
 * first row, the role word on the second. `sig` changes only with role,
 * state, size, ground and the blink, so the paint clock re-encodes it only then.
 */
export type CritterArgs = {
  role: CritterRole
  state: PodState
  size: CritterSize
  columns: number
  rows: number
  sig: string
  frames: () => Grid[]
  fallback: Run[][]
  /** The state it shows, with `@since` when known: a change plays a move (`critterMove`). */
  tag?: string
  burst?: BurstOf
}

/** A stable small number from an id: the blink's phase. */
function phaseOf(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return h % BLINK_BEATS
}

/** A critter for a role and state, without an agent row (the header's lead, a map node). */
export function critterArgs(role: CritterRole, state: PodState, o: Omit<CritterOpts, 'state'> = {}): CritterArgs {
  const size = o.size ?? 'small'
  const box = CRITTER[size]
  const columns = box.columns + 1
  const ground = o.ground ?? 'night'
  const motion = o.motion === true && state === 'working'
  const phase = o.phase ?? 0
  const { glyph, badge } = critterGlyph(state)
  // R3-B M8 (R22): the state glyph, then the role word on the same row when the cell has room for it and the badge column is
  // free ("● lead"); with a badge (R25: its column is reserved) or a word too wide, the word is under it. R43: no role word where a name stands beside the critter.
  const word = o.roleWord === false ? '' : ROLE_WORD[role]
  const beside = word !== '' && badge === undefined && 2 + word.length <= columns
  const first: Run[] = beside
    ? [glyph, { text: ` ${word}`.padEnd(columns - 1), dim: true }]
    : [glyph, { text: ' '.repeat(columns - 1 - (badge !== undefined ? 1 : 0)) }, ...(badge !== undefined ? [badge] : [])]
  const fallback: Run[][] = [first, [{ text: (beside ? '' : word).padEnd(columns), dim: true }]]
  for (let i = 2; i < box.rows; i++) fallback.push([{ text: ' '.repeat(columns) }])
  // The moves are for the places that pass `motion` (R24: never the band); `inst` plays them only with the option on, in the rich look.
  const moves = o.motion === true
  const pose = moves ? o.pose : undefined
  const poseSig = pose !== undefined ? `:pose-${pose.pose}-${pose.face}-${pose.state}-${pose.toward ?? ''}${pose.t ?? ''}` : ''
  return {
    role,
    state,
    size,
    columns,
    rows: box.rows,
    sig: `critter:${role}:${state}:${size}:${ground}:${motion && pose === undefined ? `blink${phase % BLINK_BEATS}` : 'still'}${poseSig}`,
    frames: () => (pose !== undefined ? [critterPoseBox(role, size, pose, ground)] : critterFrames(role, state, size, { ground, motion, phase })),
    fallback,
    ...(moves ? { tag: o.since !== undefined ? `${state}@${o.since}` : state, burst: critterBurst(role, state, size, ground, o.since) } : {}),
  }
}

/**
 * An agent as a critter (the cockpit form of `spriteOf`): role from
 * `crewRole` (`main` is the lead), state from `o.state` when given, else the
 * agent's own (`podStateOf`). Its text form has no role word (R43: its name is beside it).
 *
 * @example inst(ctx, $, { key: `card-${a.id}`, ...critterOf(a, { ground, motion }) })
 */
export function critterOf(agent: PodAgent, o: CritterOpts = {}): CritterArgs {
  const state = o.state ?? podStateOf(agent)
  const since = o.since ?? agent.startedAt
  return critterArgs(crewRole(agent.id, agent.subagentType ?? agent.type), state, { ...o, roleWord: o.roleWord ?? false, phase: o.phase ?? phaseOf(agent.id), ...(since !== undefined ? { since } : {}) })
}
