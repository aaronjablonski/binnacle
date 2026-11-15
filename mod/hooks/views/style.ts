import type { AgentRow, StepStatus, TaskItem } from '../../types'
import { SPRITE, sprite } from './raster'
import type { Grid, Hue, Neutral, Size, State } from './raster'

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
  accent: 'suggestion',
  live: 'suggestion',
  wait: 'warning',
  error: 'error',
  fail: 'error',
  model: 'merged',
  doc: 'merged',
  result: 'success',
  rule: 'subtle',
  subtle: 'subtle',
  /** @deprecated HUD v1: running is `live` (the accent) in v2. Kept until wave 2 replaces its callers. */
  running: 'warning',
  /** @deprecated HUD v1: done is dim in v2. Kept until wave 2 replaces its callers. */
  done: 'success',
  /** @deprecated HUD v1: the filled tab. v2 draws the open tab bold in the accent. */
  tabFg: 'inverseText',
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

/** The width of one tab cell per tier: `1: Now` … in 12, `1: Tsk` in 7, `1: ◆` in 5. Slim draws no tabs. */
export const TAB_CELL = { wide: 12, mid: 7, icon: 5 } as const

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

/**
 * The theme key of a status glyph; undefined means a dim glyph (pending, interrupted).
 * @deprecated HUD v1 colours (running in warning, done in success). Use `statusColor`.
 */
export function glyphColor(status: StepStatus | AgentRow['status'] | TaskItem['status']): string | undefined {
  switch (status) {
    case 'running':
    case 'in_progress':
      return C.running
    case 'done':
    case 'completed':
      return C.done
    case 'error':
    case 'denied':
      return C.error
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

/** Role to its three hulls: [outline, lit core, solid] (spec "Crew: pods"). */
export const HULL = GLYPHS.hull

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
export type PodAgent = Pick<AgentRow, 'id' | 'type' | 'status'> & { subagentType?: string; state?: PodState }

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
 * - stalled: lit core in `warning`; signal `z` in `warning`
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
      return { role, state, hull: { text: lit, color: C.wait }, signal: { text: sig.stalled, color: C.wait } }
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
 * Raster hues for the theme roles of `C`: the colour a Raster cell takes
 * where a Text would take the theme key beside it. Raster backgrounds are
 * always the terminal default, so only these hues and neutrals are drawn.
 */
export const RICH = {
  live: 'iris',
  accent: 'iris',
  lead: 'ember',
  spark: 'ember',
  wait: 'amber',
  fail: 'red',
  error: 'red',
  result: 'mint',
  model: 'orchid',
  doc: 'orchid',
  subtle: 'rest',
  rule: 'rest',
  dim: 'mute',
} as const satisfies Record<string, Hue | Neutral>

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
