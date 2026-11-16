import type { EngineInterface, RenderElement } from 'claude-code'

import type { Step, StepFilter, Timeline, TurnRow } from '../../types'
import { clean } from '../model/code'
import { quoteOf, stepMarkdown } from '../model/digest'
import { findSteps, stepGroups } from '../model/select'
import { windowRows } from '../model/window'
import { apply, debug, errText, readTimeline, updateUi } from '../state'
import { lineOf } from './crewnode'
import type { Seg } from './crewnode'
import { levels, promptTitle, shortPaths, span, toolName, toolRoom, typeShort, wordFit, clock, fitRuns } from './fit'
import { deepSearch, FIND_KEY, focusFind, setQuery, showInChat, stepTarget } from './find'
import { isOnScreen } from './onscreen'
import { copyResult, quoteInPrompt, toggleKeep } from './detail'
import { bodyOfOpen, openStep, openStepInline } from './openstep'
import type { FootHint } from './overview'
import { blank, inst, section } from './parts'
import type { Action, Detail, InstSpec, Run } from './parts'
import { Grid, PALETTE } from './raster'
import type { ViewCtx } from './shell'
import { C, CK, edges, typeName } from './style'
import { flushRight, hasTime, midEnd, moreRow, nameLimit, openedBlock, stepGlyph, withFooter } from './tabkit'

// The Steps tab (cockpit spec "CockpitSteps"): `f: Find a step` and the
// total, the chips `All  Kept  Errors  In view`, the activity map, "This
// turn" with one step opened in place (`g k c`, `↵ full page`), a kept step
// with its note, and "Earlier turns". Enter opens a step's page; `n` and `p`
// walk the errors (or the hits of a find).

/** Rows a turn shows before `+ n more in this turn`. */
const TURN_ROWS = 6
/** Older turns listed under Earlier turns before `+ n more`. */
const EARLIER_ROWS = 3
const MIN_PAD = 20
const MAP_ROWS = 2
/** A chip's cell: 10 of content and 2 of gap. */
const CHIP_CELL = 12
// What openTurns holds beside a turn id: the turn shows every step, or the
// Earlier turns list shows every turn.
const allOf = (id: string): string => `all:${id}`
const ALL_EARLIER = 'all:earlier'

type Group = { turn?: TurnRow; steps: Step[] }

// One drawn block of the list. The window works in terminal rows, so each item
// knows how tall it draws.
type Item = { key: string; height: number; isBlank?: true; draw: () => RenderElement }

// What the row needs of the find: a hit is underlined, and a step whose stored
// result holds the query reads `in result`.
type Find = { active: boolean; query: string; hits: ReadonlySet<string> }

// The surface the pane is drawn on: a step whose row its transcript shows now
// has `◂` in the gutter.
type Seen = (id: string) => boolean

const groupId = (g: Group): string => g.turn?.id ?? 'none'

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

function agentName(t: Timeline, id: string): string {
  return t.agents[id]?.type ?? id
}

/** The turn's title: the prompt in quotes, cut by word. */
function titleOf(g: Group, cols: number): string {
  if (g.turn === undefined) return 'Earlier steps'
  return promptTitle(g.turn.prompt, cols) || '“(no prompt)”'
}

// The tool is its own column, so the name drops the tool's word from the label. A path stays whole while it fits the room.
function nameOf(s: Step, room: number): string {
  const prefix = `${s.tool} `
  const rest = oneLine(s.label.startsWith(prefix) ? s.label.slice(prefix.length) : s.label)
  if (rest !== '' && rest.length <= room) return rest
  return shortPaths(rest) || oneLine(s.label)
}

// The text with each case-insensitive occurrence of the query underlined in the accent.
function marked(text: string, q: string): Run[] {
  if (q === '') return [{ text }]
  const lower = text.toLowerCase()
  const needle = q.toLowerCase()
  const runs: Run[] = []
  let from = 0
  for (;;) {
    const hit = lower.indexOf(needle, from)
    if (hit < 0) break
    runs.push({ text: text.slice(from, hit) })
    runs.push({ text: text.slice(hit, hit + needle.length), color: C.accent, underline: true })
    from = hit + needle.length
  }
  runs.push({ text: text.slice(from) })
  return runs.filter(r => r.text !== '')
}

async function setFilter($: EngineInterface, requestId: string, filter: StepFilter): Promise<void> {
  await updateUi($, u => ({ ...u, filter }))
  // The list changes length: back to its top (E3).
  try {
    await $.ui.scroll({ in: requestId, to: 'start' })
  } catch (err) {
    debug($, `scroll failed: ${errText(err)}`)
  }
}

// Opening an older turn adds its id; closing removes it, and with it any step
// of the turn that was open in place.
async function toggleTurn($: EngineInterface, id: string, stepIds: readonly string[]): Promise<void> {
  await updateUi($, u => {
    if (!u.openTurns.includes(id)) return { ...u, openTurns: [...u.openTurns, id] }
    const closing = u.stepOpen !== undefined && stepIds.includes(u.stepOpen)
    const { stepOpen: _gone, ...rest } = u
    return { ...(closing ? rest : u), openTurns: u.openTurns.filter(x => x !== id && x !== allOf(id)) }
  })
}

// Turns on a marker: `all:<turn>` or `all:earlier`.
async function toggleMark($: EngineInterface, mark: string): Promise<void> {
  await updateUi($, u => ({ ...u, openTurns: u.openTurns.includes(mark) ? u.openTurns.filter(x => x !== mark) : [...u.openTurns, mark] }))
}

/** Keeps the newest step of the main loop with `note`; the answer of `/mc keep`. */
export async function pinNewest($: EngineInterface, note: string): Promise<{ text: string }> {
  const t = await readTimeline($)
  let newest: Step | undefined
  for (const s of t.steps) {
    if (s.agent !== 'main') continue
    if (newest === undefined || s.seq > newest.seq) newest = s
  }
  if (newest === undefined) return { text: 'Nothing to keep yet.' }
  await apply($, { kind: 'pin', id: newest.id, note })
  return { text: `Kept: ${newest.label}` }
}

// `n` and `p`: opens the step in place (its older turn too) and moves the focus ring to its row.
async function goTo($: EngineInterface, requestId: string, id: string, turnToOpen: string | undefined): Promise<void> {
  if (turnToOpen !== undefined) {
    await updateUi($, u => (u.openTurns.includes(turnToOpen) ? u : { ...u, openTurns: [...u.openTurns, turnToOpen] }))
  }
  await openStepInline($, id)
  try {
    const got = await $.ui.focus({ requestId, key: `step-${id}` })
    if (got.deny !== undefined) debug($, `focus refused: ${got.deny}`)
  } catch (err) {
    debug($, `focus failed: ${errText(err)}`)
  }
}

// The detail lines of an opened step: the kept note, then the result (three
// lines at most). The row says whether it failed, so there is no status line
// unless there is nothing else to show.
function stepDetails(t: Timeline, s: Step, u: ViewCtx['u'], now: number): Detail[] {
  const details: Detail[] = []
  const note = s.pin !== undefined && s.pin !== '' ? oneLine(s.pin) : ''
  if (note !== '') details.push({ key: 'Kept', value: note })
  const got = bodyOfOpen(u, s.id)
  if (got?.body !== undefined) {
    const lines = clean(got.body.text)
      .split('\n')
      .map(l => l.trim())
      .filter(l => l !== '')
    const room = 3 - details.length
    lines.slice(0, room).forEach((l, i) => {
      details.push({ key: i === 0 ? 'Result' : '', value: got.body?.isError === true && i === 0 ? [{ text: l, color: C.fail }] : l })
    })
    if (lines.length === 0) details.push({ key: 'Result', value: [{ text: '(empty)', dim: true }] })
  } else if (got?.missing === true) {
    details.push({ key: 'Result', value: [{ text: 'not kept on disk', dim: true }] })
  }
  if (details.length === 0) {
    const end = s.status === 'running' ? now : (s.endedAt ?? s.startedAt)
    const who = s.agent === 'main' ? 'main' : typeName(agentName(t, s.agent))
    const word = s.status === 'error' ? 'failed' : s.status === 'done' ? 'done' : s.status
    details.push({
      key: 'Status',
      value: [{ text: `${word} after ${span(end - s.startedAt, { steps: true })}`, ...(statusTone(s) !== undefined ? { color: statusTone(s)! } : {}) }, { text: ` · ${clock(s.startedAt, true)} · ${who}`, dim: true }],
    })
  }
  return details.slice(0, 3)
}

const statusTone = (s: Step): string | undefined => (s.status === 'error' ? C.fail : undefined)

type Chip = { key: string; name: string; count?: string; on: boolean; span?: number; tone?: 'fail'; onPress?: () => void | Promise<void> }

const spanOf = (chips: Chip[]): number => chips.reduce((n, c) => n + (c.span ?? 1), 0)

// The chips that fit the cells (the agent chip takes two): the open one and All stay, then the rest from the front.
// With one cell only the open chip stays.
function fitChips(chips: Chip[], cells: number): Chip[] {
  if (cells <= 1) return chips.filter(c => c.on).slice(0, 1)
  const out = [...chips]
  while (spanOf(out) > cells) {
    let drop = -1
    out.forEach((c, i) => {
      if (!c.on && c.key !== 'filter-all') drop = i
    })
    if (drop < 0) break
    out.splice(drop, 1)
  }
  return out
}

// The pane's scroll seat, read off the render input (K4: never viewport.rows).
function scrollOf(ctx: ViewCtx): { offset: number; bodyRows: number } {
  const props = ctx.e.props as { scroll?: { offset?: number; bodyRows?: number } }
  return { offset: props.scroll?.offset ?? 0, bodyRows: props.scroll?.bodyRows ?? 30 }
}

/** One MAP bucket: how many steps started in it, whether one failed, whether the chat shows one now. */
type MapBucket = { count: number; error: boolean; view: boolean }

/**
 * The step map's buckets: the session's steps counted into `n` equal slices
 * of time, from the first step to now. A bucket is `error` when a step in it
 * failed and `view` when the transcript shows one of its steps now.
 */
export function mapBuckets(steps: readonly Step[], now: number, n: number, seen: (id: string) => boolean): MapBucket[] {
  const out: MapBucket[] = Array.from({ length: n }, () => ({ count: 0, error: false, view: false }))
  if (steps.length === 0) return out
  const from = Math.min(...steps.map(s => s.startedAt))
  const to = Math.max(now, ...steps.map(s => s.startedAt))
  const span = to - from
  for (const s of steps) {
    const i = span <= 0 ? n - 1 : Math.min(n - 1, Math.floor(((s.startedAt - from) / span) * n))
    const b = out[i]!
    b.count += 1
    if (s.status === 'error') b.error = true
    if (seen(s.id)) b.view = true
  }
  return out
}

/**
 * The step map as an instrument: `n` columns two rows tall (16 levels), the
 * height the steps in the slice, an error red, the run in view bright
 * (iris), the rest soft. Its text form is the same box in eighth blocks.
 */
function mapInst(buckets: MapBucket[], ground: 'night' | 'day'): InstSpec {
  const n = buckets.length
  const lv = levels(buckets.map(b => b.count), MAP_ROWS)
  const style = (b: MapBucket): Omit<Run, 'text'> => (b.error ? { color: CK.fail } : b.view ? { color: CK.accent } : { color: CK.accent, dim: true })
  const rows: Run[][] = [[], []]
  buckets.forEach((b, i) => {
    const v = lv[i] ?? 0
    const low = v <= 0 ? '▁' : '▁▂▃▄▅▆▇█'[Math.min(8, v) - 1]!
    const high = v > 8 ? '▁▂▃▄▅▆▇█'[v - 9]! : ' '
    rows[0]!.push({ ...style(b), text: high })
    rows[1]!.push({ ...(v <= 0 ? { color: C.subtle } : style(b)), text: low })
  })
  return {
    key: 'map',
    columns: n,
    rows: MAP_ROWS,
    sig: `map:${ground}:${buckets.map(b => `${b.count}${b.error ? 'e' : ''}${b.view ? 'v' : ''}`).join(',')}`,
    frames: () => {
      const g = new Grid(n, MAP_ROWS, PALETTE[ground])
      buckets.forEach((b, i) => {
        const v = lv[i] ?? 0
        const hue = b.error ? 'red' : b.view ? 'iris' : 'irisSoft'
        for (let k = 0; k < MAP_ROWS; k++) {
          const part = Math.max(0, Math.min(8, v - k * 8))
          const rr = MAP_ROWS - 1 - k
          if (part > 0) g.lv(i, rr, part, hue)
          else if (k === 0) g.lv(i, rr, 1, 'rest')
        }
      })
      return [g]
    },
    fallback: rows,
  }
}

/** The tab's header time: how long the newest turn has run (or ran). */
function turnSpan(t: Timeline, now: number): string {
  const turns = t.turns.filter(x => x.agent === 'main')
  const newest = turns.reduce<TurnRow | undefined>((a, b) => (a === undefined || b.startedAt > a.startedAt ? b : a), undefined)
  if (newest !== undefined) return span((newest.endedAt ?? now) - newest.startedAt)
  const first = t.steps.reduce((m, s) => Math.min(m, s.startedAt), Infinity)
  return Number.isFinite(first) ? span(now - first) : ''
}

/** The Steps tab: the find row and chips, then the newest turn, any opened older turns and Earlier turns. */
export function timelineView(ctx: ViewCtx, $: EngineInterface): RenderElement {
  const { Box, Text, Button, Input } = $.ui.resolve(ctx.e)
  const { t, u, cols } = ctx
  const { left, right } = edges(cols)
  const ground = ctx.ground ?? 'night'
  try {
    if (t.steps.length === 0) return <Text dimColor>{`${' '.repeat(left)}No steps yet.`}</Text>

    const requestId = ctx.e.requestId
    const surface = ctx.e.surface
    const seen: Seen = id => isOnScreen(surface, id)
    const f = u.filter

    // The query narrows the steps (tool, label, agent, pin note); the hits of a
    // deep search stay in even when only their result matched.
    const q = u.query.trim()
    const find: Find = { active: q !== '', query: q, hits: new Set(q === '' ? [] : (u.hits ?? [])) }
    let shown = t
    if (find.active) {
      const keep = new Set(findSteps(t, q).map(s => s.id))
      for (const id of find.hits) keep.add(id)
      shown = { ...t, steps: t.steps.filter(s => keep.has(s.id)) }
    }
    const groups = stepGroups(shown, f)
    const shownCount = groups.reduce((n, g) => n + g.steps.length, 0)
    const errors = t.steps.filter(s => s.status === 'error').length
    const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many)

    // ---- the find row: `f: Find a step` at 2, the total flush right
    const total = turnSpan(t, ctx.now)
    const countRuns: Run[] = find.active
      ? [{ text: String(shownCount), bold: true }, { text: ` ${plural(shownCount, 'hit', 'hits')} of ${t.steps.length}`, dim: true }]
      : [{ text: String(t.steps.length), bold: true }, { text: ` ${plural(t.steps.length, 'step', 'steps')}${total !== '' ? ` · ${total}` : ''}`, dim: true }]
    const countW = countRuns.reduce((n, r) => n + r.text.length, 0)
    const inputRoom = Math.max(4, right + 1 - left - countW)
    const findRow = (
      <Box key="find-row" flexDirection="row" paddingLeft={left}>
        <Box key="find-field" flexDirection="row" width={inputRoom} flexShrink={0}>
          {find.active ? (
            <Text color={C.live}>{'/ '}</Text>
          ) : (
            <Button key="find-f" hotkey="f" plain dimColor onPress={() => focusFind($, requestId)}>
              {inputRoom >= 14 ? 'Find a step' : 'Find'}
            </Button>
          )}
          <Input
            key={FIND_KEY}
            placeholder={find.active ? '' : ' '}
            value={u.query}
            submitLabel="deep search"
            onInput={(value: string) => void setQuery($, value)}
            onSubmit={(value: string) => deepSearch($, value)}
          />
        </Box>
        <Text key="find-count">
          {countRuns.map((r, i) => (
            <Text key={`c${i}`} bold={r.bold === true ? true : undefined} dimColor={r.dim === true ? true : undefined}>
              {r.text}
            </Text>
          ))}
        </Text>
      </Box>
    )

    // ---- the chips: one cell each (the agent chip takes two); the open one bold between spaces
    const kept = t.steps.filter(s => s.pin !== undefined).length
    const inView = t.steps.filter(s => seen(s.id)).length
    const chipList: Chip[] = [
      { key: 'filter-all', name: 'All', count: String(t.steps.length), on: f.kind === 'all', onPress: () => setFilter($, requestId, { kind: 'all' }) },
    ]
    if (kept > 0 || f.kind === 'pinned') {
      chipList.push({ key: 'filter-pinned', name: 'Kept', count: String(kept), on: f.kind === 'pinned', onPress: () => setFilter($, requestId, { kind: 'pinned' }) })
    }
    if (errors > 0 || f.kind === 'errors') {
      chipList.push({ key: 'filter-errors', name: 'Errors', count: String(errors), on: f.kind === 'errors', tone: 'fail', onPress: () => setFilter($, requestId, { kind: 'errors' }) })
    }
    if (f.kind === 'agent') {
      chipList.push({
        key: 'filter-agent',
        name: `${typeShort(agentName(t, f.id), 2 * CHIP_CELL - 6)} ✕`,
        on: true,
        span: 2,
        onPress: () => setFilter($, requestId, { kind: 'all' }),
      })
    }
    if (inView > 0) chipList.push({ key: 'chip-inview', name: 'In view', count: String(inView), on: false })
    const cells = Math.max(1, Math.floor((right - left + 2) / CHIP_CELL))
    const shownChips = fitChips(chipList, cells)
    let slot = 0
    const chipBoxes = shownChips.map(c => {
      const at0 = slot
      slot += c.span ?? 1
      const width = Math.min((c.span ?? 1) * CHIP_CELL, right + 1 - (left + at0 * CHIP_CELL))
      const label = c.count !== undefined ? `${c.name} ${c.count}` : c.name
      const body = c.on ? (
        <Text key="chip" bold>{` ${wordFit(label, Math.max(1, width - 3))} `}</Text>
      ) : (
        <Text key="chip" {...(c.tone === 'fail' ? { color: C.fail } : { dimColor: true })}>{wordFit(label, Math.max(1, width - 2))}</Text>
      )
      return (
        <Box key={`cell-${c.key}`} width={width} flexShrink={0}>
          {c.onPress !== undefined ? (
            <Button key={c.key} plain onPress={() => void c.onPress?.()}>
              {body}
            </Button>
          ) : (
            body
          )}
        </Box>
      )
    })
    const chipRow = (
      <Box key="chips" flexDirection="row" paddingLeft={left}>
        {chipBoxes}
      </Box>
    )

    // ---- the map: the whole content width, two rows, and under it where it starts and ends
    const mapWidth = right - left + 1
    const mapEl =
      mapWidth >= 4 ? (
        <Box key="map-row" flexDirection="row" paddingLeft={left}>
          {inst(ctx, $, mapInst(mapBuckets(t.steps, ctx.now, mapWidth, seen), ground))}
        </Box>
      ) : null
    const caption: Seg[] = [{ col: left, text: 'start', dim: true }, ...flushRight([{ text: 'now', dim: true }], right)]
    if (inView > 0 && mapWidth >= 50) caption.splice(1, 0, { col: left + 20, text: 'bright: the rows below', dim: true })
    const captionEl = mapWidth >= 4 ? lineOf(ctx, $, { key: 'map-caption', body: caption }) : null
    const deck: RenderElement[] = [findRow, blank(ctx, $, 'gap-find'), chipRow, blank(ctx, $, 'gap-chips'), ...(mapEl !== null ? [mapEl, captionEl!] : []), blank(ctx, $, 'gap-deck')]

    if (groups.length === 0) {
      return (
        <Box flexDirection="column">
          {deck}
          <Text dimColor>{`${' '.repeat(left)}No steps match.`}</Text>
        </Box>
      )
    }

    // ---- n and p: through the hits while a query is on, else through the errors
    const flat = groups.flatMap((g, gi) => g.steps.map(s => ({ s, turn: gi === 0 ? undefined : groupId(g) })))
    const targets = find.active ? flat : flat.filter(x => x.s.status === 'error')
    const targetIds = targets.map(x => x.s.id)
    const walk = (dir: 1 | -1): (() => Promise<void>) => {
      const id = stepTarget(targetIds, u.stepOpen, dir)
      const turn = targets.find(x => x.s.id === id)?.turn
      return async () => {
        if (id !== undefined) await goTo($, requestId, id, turn)
      }
    }

    // ---- the list: every block with its height, then only those near the window are drawn
    const items: Item[] = []
    const gap = (): void => {
      const last = items[items.length - 1]
      if (last === undefined || last.isBlank === true) return
      items.push({ key: `gap-${items.length}`, height: 1, isBlank: true, draw: () => blank(ctx, $, `gap-${items.length}`) })
    }
    const add = (key: string, height: number, draw: () => RenderElement): void => {
      items.push({ key, height, draw })
    }
    const mid = midEnd(cols)
    const toolW = toolRoom(cols)
    const stepRow = (s: Step, isOpen: boolean): RenderElement => {
      const keptStep = s.pin !== undefined
      const calm = s.status === 'done' || s.status === 'denied' || s.status === 'interrupted'
      const end = s.status === 'running' ? ctx.now : (s.endedAt ?? s.startedAt)
      const hit = find.hits.has(s.id)
      const live = s.status === 'running'
      const glyphRun: Run = keptStep && calm ? { text: '★', color: CK.accent } : s.status === 'running' ? { text: stepGlyph(s.status), color: CK.accent } : s.status === 'error' ? { text: stepGlyph(s.status), color: CK.fail } : { text: stepGlyph(s.status), dim: true }
      const nameCol = toolW > 0 ? 4 + toolW + 1 : 4
      const body: Seg[] = [{ col: 2, ...glyphRun }]
      if (toolW > 0) body.push({ col: 4, text: toolName(s.tool, toolW), ...(isOpen || live ? { bold: true } : {}) })
      const room = Math.max(1, nameLimit(cols) - nameCol)
      let col = nameCol
      for (const r of fitRuns(marked(nameOf(s, room), find.query), room) as Run[]) {
        if (r.text === '') continue
        body.push({ ...(isOpen ? { bold: true } : {}), ...r, col })
        col += r.text.length
      }
      const who: Run = hit ? { text: 'in result', color: C.accent } : { text: s.agent === 'main' ? 'main' : typeName(agentName(t, s.agent)), dim: true }
      if (mid !== undefined) body.push(...flushRight([who], mid))
      if (hasTime(cols)) body.push(...flushRight([{ text: live ? 'now' : span(end - s.startedAt, { steps: true }), dim: true }], right))
      return lineOf(ctx, $, {
        key: `step-${s.id}`,
        ...(seen(s.id) ? { pre: [{ col: 0, text: '◂', color: C.live }] } : {}),
        body,
        // Enter on a step row opens its page (rich rule 4); `b` comes back to the row.
        onPress: () => openStep($, s.id, `step-${s.id}`),
      })
    }
    const addStep = (s: Step): void => {
      const isOpen = u.stepOpen === s.id
      add(`step-${s.id}`, 1, () => stepRow(s, isOpen))
      const note = s.pin !== undefined && s.pin !== '' ? oneLine(s.pin) : ''
      if (!isOpen) {
        if (note !== '') add(`kept-${s.id}`, 1, () => lineOf(ctx, $, { key: `kept-${s.id}`, body: [{ col: 4, text: wordFit(`kept: “${note}”`, Math.max(1, right - 3)), dim: true }] }))
        return
      }
      const body = bodyOfOpen(u, s.id)?.body
      const details = stepDetails(t, s, u, ctx.now)
      const actions: Action[] = [
        { hotkey: 'g', label: 'chat', key: `chat-${s.id}`, onPress: () => showInChat($, s.id) },
        { hotkey: 'k', label: s.pin === undefined ? 'keep' : 'unkeep', key: `keep-${s.id}`, onPress: () => toggleKeep($, s) },
        { hotkey: 'c', label: 'copy', key: `copy-${s.id}`, onPress: () => copyResult($, stepMarkdown(s, body), surface) },
      ]
      add(`open-${s.id}`, details.length + 1, () => <Box key={`open-${s.id}`} flexDirection="column">{openedBlock(ctx, $, { key: `open-${s.id}`, details, actions, right: '↵ full page' })}</Box>)
      gap()
    }
    const addMore = (key: string, n: number, what: string, onPress: () => Promise<void>): void => {
      add(key, 1, () => moreRow(ctx, $, key, `+ ${n} ${what}`, onPress))
    }
    // The turn that is running or ran last (the newest main turn): its head reads "This turn".
    const newestTurn = t.turns.filter(x => x.agent === 'main').reduce<TurnRow | undefined>((a, b) => (a === undefined || b.startedAt > a.startedAt ? b : a), undefined)
    // A turn: its head (a Button when older), up to 6 rows, `+ n more in this turn`.
    const addTurn = (g: Group, isNewest: boolean): void => {
      const id = groupId(g)
      gap()
      const ids = g.steps.map(s => s.id)
      const isThis = isNewest && g.turn !== undefined && g.turn.id === newestTurn?.id
      const title = isThis ? 'This turn' : g.turn === undefined ? 'Earlier steps' : titleOf(g, 34)
      const sum: Run[] = isThis ? [{ text: wordFit(promptTitle(g.turn!.prompt, 40) || '“(no prompt)”', right - left - 14), dim: true }] : [{ text: `${g.steps.length} ${g.steps.length === 1 ? 'step' : 'steps'}`, dim: true }]
      add(`turn-${id}`, 1, () => section(ctx, $, title, sum, { key: `turn-${id}`, ...(isNewest ? {} : { onPress: () => toggleTurn($, id, ids) }) }))
      const every = u.openTurns.includes(allOf(id))
      const visible = every ? g.steps : g.steps.filter((s, i) => i < TURN_ROWS || s.id === u.stepOpen)
      for (const s of visible) addStep(s)
      const hidden = g.steps.length - visible.length
      if (hidden > 0) addMore(`more-${id}`, hidden, 'more in this turn', () => toggleMark($, allOf(id)))
    }

    const [newest, ...older] = groups as [Group, ...Group[]]
    const isOpenGroup = (g: Group): boolean => u.openTurns.includes(groupId(g)) || g.steps.some(s => s.id === u.stepOpen)
    addTurn(newest, true)
    for (const g of older.filter(isOpenGroup)) addTurn(g, false)
    const earlier = older.filter(g => !isOpenGroup(g))
    if (earlier.length > 0) {
      gap()
      add('sec-earlier', 1, () => section(ctx, $, 'Earlier turns', String(earlier.length), { key: 'sec-earlier' }))
      const every = u.openTurns.includes(ALL_EARLIER)
      for (const g of every ? earlier : earlier.slice(0, EARLIER_ROWS)) {
        const id = groupId(g)
        const ids = g.steps.map(s => s.id)
        add(`turn-${id}`, 1, () => {
          const body: Seg[] = [{ col: 2, text: '○', color: C.subtle }]
          const mark = `${g.steps.length} ${find.active ? plural(g.steps.length, 'hit', 'hits') : plural(g.steps.length, 'step', 'steps')}`
          const timeText = g.turn !== undefined ? clock(g.turn.startedAt) : ''
          const room = Math.max(1, (mid !== undefined ? mid - mark.length - 2 : hasTime(cols) ? right - timeText.length - 2 : right + 1) - 4)
          body.push({ col: 4, text: titleOf(g, room) })
          if (mid !== undefined) body.push(...flushRight([{ text: mark, dim: true }], mid))
          if (hasTime(cols) && timeText !== '') body.push(...flushRight([{ text: timeText, dim: true }], right))
          return lineOf(ctx, $, { key: `turn-${id}`, body, onPress: () => toggleTurn($, id, ids) })
        })
      }
      if (!every && earlier.length > EARLIER_ROWS) {
        addMore('more-earlier', earlier.length - EARLIER_ROWS, 'more', () => toggleMark($, ALL_EARLIER))
      }
    }
    while (items.length > 0 && items[items.length - 1]?.isBlank === true) items.pop()

    const totalRows = items.reduce((sum, it) => sum + it.height, 0)
    const { offset, bodyRows } = scrollOf(ctx)
    const win = windowRows(totalRows, offset, bodyRows, Math.max(MIN_PAD, bodyRows))
    const drawn: RenderElement[] = []
    let top = 0
    let bottom = 0
    let cursor = 0
    for (const it of items) {
      const start = cursor
      const end = cursor + it.height
      cursor = end
      if (end <= win.from) {
        top = end
        continue
      }
      if (start >= win.to) {
        bottom += it.height
        continue
      }
      drawn.push(it.draw())
    }

    // ---- the footer: only while the pane has the focus
    const openStepRow = u.stepOpen !== undefined ? t.steps.find(s => s.id === u.stepOpen) : undefined
    const nextHint = (label: string): FootHint => ({ hotkey: 'n', label, id: 'hint-n', onPress: walk(1) })
    const prevHint: FootHint = { hotkey: 'p', label: 'prev', id: 'hint-p', onPress: walk(-1) }
    let hints: FootHint[]
    if (openStepRow !== undefined && targetIds.length === 0) {
      const body = bodyOfOpen(u, openStepRow.id)?.body
      hints = [
        { key: '↵', label: 'full step' },
        { hotkey: 'q', label: 'quote', id: 'hint-q', onPress: () => quoteInPrompt($, quoteOf(openStepRow, body)) },
        { key: 'esc', label: 'close' },
      ]
    } else if (find.active) {
      hints = targetIds.length > 0 ? [nextHint('next hit'), prevHint, { key: 'esc', label: 'clear' }] : [{ key: 'esc', label: 'clear' }]
    } else if (targetIds.length > 0) {
      hints = [{ key: '↵', label: 'open step' }, nextHint('next error'), prevHint, { key: 'f', label: 'find' }]
    } else {
      hints = [{ key: '↵', label: 'open step' }, { key: 'f', label: 'find' }, { key: 'esc', label: 'prompt' }]
    }

    const body: RenderElement[] = [
      ...deck,
      <Box key="list" flexDirection="column">
        {top > 0 ? <Box key="space-top" height={top} /> : null}
        {drawn}
        {bottom > 0 ? <Box key="space-bottom" height={bottom} /> : null}
      </Box>,
    ]
    return <Box flexDirection="column">{withFooter(ctx, $, body, hints)}</Box>
  } catch (err) {
    debug($, `timeline view failed: ${errText(err)}`)
    return <Text dimColor>{wordFit(`Steps: ${errText(err)}`, cols)}</Text>
  }
}
