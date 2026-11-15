import type { EngineInterface, RenderElement } from 'claude-code'

import type { Step, StepFilter, Timeline, TurnRow } from '../../types'
import { clean } from '../model/code'
import { quoteOf, stepMarkdown } from '../model/digest'
import { findSteps, stepGroups } from '../model/select'
import { windowRows } from '../model/window'
import { apply, debug, errText, readTimeline, updateUi } from '../state'
import { STEP_GLYPH } from './agentmeta'
import { at, clock, elapsed, fit, line, promptTitle, shortPaths, wordFit } from './fit'
import { deepSearch, FIND_KEY, focusFind, setQuery, showInChat, stepTarget } from './find'
import { isOnScreen } from './onscreen'
import { copyResult, quoteInPrompt, toggleKeep } from './detail'
import { bodyOfOpen, openStep, openStepInline } from './openstep'
import { blank, footer, opened, row, section } from './parts'
import type { Action, Detail, Hint, Run } from './parts'
import type { ViewCtx } from './shell'
import { C, cellsFor, GRID, statusColor, tableCols } from './style'

const MIN_PAD = 20
/** Rows a turn shows before `+ n more in this turn`. */
const TURN_ROWS = 5
/** Older turns listed under EARLIER TURNS before `+ n more turns`. */
const EARLIER_ROWS = 6
// What openTurns holds beside a turn id: the turn shows every step, or the
// EARLIER TURNS list shows every turn.
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

/** The turn's title as a section label or a row name. */
function titleOf(g: Group, cols: number): string {
  if (g.turn === undefined) return 'Earlier steps'
  return promptTitle(g.turn.prompt, cols) || '“(no prompt)”'
}

// The tool is its own column, so the name drops the tool's word from the label.
function nameOf(s: Step): string {
  const prefix = `${s.tool} `
  const rest = s.label.startsWith(prefix) ? s.label.slice(prefix.length) : s.label
  return shortPaths(oneLine(rest)) || oneLine(s.label)
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

// The detail lines of an opened step: status, then the kept note (if any) and
// up to two lines of the result; three at most.
function stepDetails(t: Timeline, s: Step, u: ViewCtx['u'], now: number): Detail[] {
  const end = s.status === 'running' ? now : (s.endedAt ?? s.startedAt)
  const took = elapsed(s.startedAt, end)
  const word =
    s.status === 'error'
      ? `failed after ${took}`
      : s.status === 'done'
        ? `done in ${took}`
        : s.status
  const who = s.agent === 'main' ? 'main' : agentName(t, s.agent)
  const details: Detail[] = [
    {
      key: 'status',
      value: [
        { text: word, ...(statusColor(s.status) !== undefined ? { color: statusColor(s.status) } : {}) },
        { text: ` · ${clock(s.startedAt, true)} · ${who}`, dim: true },
      ],
    },
  ]
  const note = s.pin !== undefined && s.pin !== '' ? oneLine(s.pin) : ''
  if (note !== '') details.push({ key: 'kept', value: note })
  const got = bodyOfOpen(u, s.id)
  if (got?.body !== undefined) {
    const lines = clean(got.body.text)
      .split('\n')
      .map(l => l.trim())
      .filter(l => l !== '')
    const room = 3 - details.length
    lines.slice(0, room).forEach((l, i) => {
      details.push({ key: i === 0 ? 'result' : '', value: got.body?.isError === true && i === 0 ? [{ text: l, color: C.fail }] : l })
    })
    if (lines.length === 0) details.push({ key: 'result', value: [{ text: '(empty)', dim: true }] })
  } else if (got?.missing === true) {
    details.push({ key: 'result', value: [{ text: 'not kept on disk', dim: true }] })
  }
  return details.slice(0, 3)
}

type Chip = { key: string; name: string; count?: string; on: boolean; countColor?: string; onPress?: () => void | Promise<void> }

// The chips that fit the cells: the open one and All stay, then the rest from the front.
function fitChips(chips: Chip[], cells: number): Chip[] {
  const out = [...chips]
  while (out.length > cells) {
    let drop = -1
    out.forEach((c, i) => {
      if (!c.on && c.key !== 'filter-all') drop = i
    })
    if (drop < 0) break
    out.splice(drop, 1)
  }
  return out.slice(0, Math.max(0, cells))
}

// The footer's hints that fit the width: from column 2, 3 apart, dropped from the end.
function fitHints(hints: Hint[], cols: number): Hint[] {
  const width = (h: Hint): number => ('hotkey' in h ? h.hotkey.length + 2 + h.label.length : h.text.length)
  const out = [...hints]
  while (out.length > 1 && GRID.margin + out.reduce((n, h) => n + width(h), 0) + 3 * (out.length - 1) > cols) out.pop()
  return out
}

// The pane's scroll seat, read off the render input (K4: never viewport.rows).
function scrollOf(ctx: ViewCtx): { offset: number; bodyRows: number } {
  const props = ctx.e.props as { scroll?: { offset?: number; bodyRows?: number } }
  return { offset: props.scroll?.offset ?? 0, bodyRows: props.scroll?.bodyRows ?? 30 }
}

/** The Steps tab: the find row and chips, then the newest turn, any opened older turns and EARLIER TURNS. */
export function timelineView(ctx: ViewCtx, $: EngineInterface): RenderElement {
  const { Box, Text, Button, Input } = $.ui.resolve(ctx.e)
  const { t, u, cols } = ctx
  try {
    if (t.steps.length === 0) return <Text dimColor>No steps yet.</Text>

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

    // ---- the find row: f: Find (or / query), a count at the metric column, errors or `of n` at the time column
    const tc = tableCols(cols)
    const firstCol = tc.metric ?? tc.time
    const errors = t.steps.filter(s => s.status === 'error').length
    const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many)
    const errorsText = `✖ ${errors} ${plural(errors, 'error', 'errors')}`
    const countCell = find.active ? (
      <Text>
        <Text bold>{String(shownCount)}</Text>
        <Text dimColor>{` ${plural(shownCount, 'hit', 'hits')}`}</Text>
      </Text>
    ) : (
      <Text>
        <Text bold>{String(t.steps.length)}</Text>
        <Text dimColor>{' steps'}</Text>
      </Text>
    )
    const lastCell = find.active ? (
      <Text dimColor>{`of ${t.steps.length}`}</Text>
    ) : errors > 0 ? (
      <Text color={C.fail}>{errorsText.length <= GRID.content ? errorsText : `✖ ${errors}`}</Text>
    ) : null
    const findRow = (
      <Box key="find-row" flexDirection="row">
        <Box flexDirection="row" width={firstCol ?? cols}>
          <Text>{'  '}</Text>
          {find.active ? (
            <Text color={C.accent}>{'/ '}</Text>
          ) : (
            <Button key="find-f" hotkey="f" plain onPress={() => focusFind($, requestId)}>
              Find
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
        {firstCol !== undefined ? <Box width={GRID.cell}>{countCell}</Box> : null}
        {tc.metric !== undefined && lastCell !== null ? <Box width={GRID.cell}>{lastCell}</Box> : null}
      </Box>
    )

    // ---- the chips: one cell each, a zero count hidden unless it is the open filter
    const kept = t.steps.filter(s => s.pin !== undefined).length
    const inView = t.steps.filter(s => seen(s.id)).length
    const chipList: Chip[] = [
      { key: 'filter-all', name: 'All', count: String(t.steps.length), on: f.kind === 'all', onPress: () => setFilter($, requestId, { kind: 'all' }) },
    ]
    if (kept > 0 || f.kind === 'pinned') {
      chipList.push({ key: 'filter-pinned', name: 'Kept', count: String(kept), on: f.kind === 'pinned', onPress: () => setFilter($, requestId, { kind: 'pinned' }) })
    }
    if (errors > 0 || f.kind === 'errors') {
      chipList.push({
        key: 'filter-errors',
        name: 'Errors',
        count: String(errors),
        on: f.kind === 'errors',
        countColor: C.fail,
        onPress: () => setFilter($, requestId, { kind: 'errors' }),
      })
    }
    if (f.kind === 'agent') {
      chipList.push({ key: 'filter-agent', name: fit(`${agentName(t, f.id)} ✕`, GRID.content), on: true, onPress: () => setFilter($, requestId, { kind: 'all' }) })
    }
    if (inView > 0) chipList.push({ key: 'chip-inview', name: 'In view', count: String(inView), on: false })
    const chipCell = (c: Chip): RenderElement => {
      const label = c.count !== undefined ? `${c.name} ${c.count}` : c.name
      if (c.on) {
        return (
          <Button key={c.key} plain onPress={() => c.onPress?.()}>
            <Text color={C.accent} bold>
              {label}
            </Text>
          </Button>
        )
      }
      const body = [
        <Text key="name" dimColor>
          {c.name}
        </Text>,
        c.count !== undefined ? (
          <Text key="gap" dimColor>
            {' '}
          </Text>
        ) : null,
        c.count !== undefined ? (
          <Text key="count" color={c.countColor}>
            {c.count}
          </Text>
        ) : null,
      ]
      const press = c.onPress
      if (press === undefined) return <Text key={c.key}>{body}</Text>
      return (
        <Button key={c.key} plain onPress={press}>
          {body}
        </Button>
      )
    }
    const chips = (
      <Box key="chips" flexDirection="row">
        <Text>{'  '}</Text>
        {fitChips(chipList, cellsFor(cols)).map(c => (
          <Box key={`cell-${c.key}`} width={GRID.cell}>
            {chipCell(c)}
          </Box>
        ))}
      </Box>
    )

    if (groups.length === 0) {
      return (
        <Box flexDirection="column">
          {findRow}
          {blank(ctx, $, 'gap-find')}
          {chips}
          {blank(ctx, $, 'gap-chips')}
          <Text dimColor>No steps match.</Text>
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
    const stepRow = (s: Step, isOpen: boolean): RenderElement => {
      const kept = s.pin !== undefined
      const calm = s.status === 'done' || s.status === 'denied' || s.status === 'interrupted'
      const end = s.status === 'running' ? ctx.now : (s.endedAt ?? s.startedAt)
      const hit = find.hits.has(s.id)
      return row(ctx, $, {
        key: `step-${s.id}`,
        ...(seen(s.id) ? { flag: 'inView' as const } : {}),
        glyph: kept && calm ? '★' : STEP_GLYPH[s.status],
        ...(kept && calm ? { glyphColor: C.accent } : statusColor(s.status) !== undefined ? { glyphColor: statusColor(s.status) } : {}),
        tool: s.tool,
        name: marked(nameOf(s), find.query),
        bold: isOpen,
        metric: hit ? { text: 'in result', color: C.accent } : s.agent === 'main' ? 'main' : agentName(t, s.agent),
        time: s.status === 'running' ? 'now' : elapsed(s.startedAt, end),
        onPress: () => (isOpen ? openStep($, s.id) : openStepInline($, s.id)),
      })
    }
    const addStep = (s: Step, sectionAt: number): void => {
      const isOpen = u.stepOpen === s.id
      if (!isOpen) {
        add(`step-${s.id}`, 1, () => stepRow(s, false))
        return
      }
      if (items.length > sectionAt + 1) gap()
      add(`step-${s.id}`, 1, () => stepRow(s, true))
      const body = bodyOfOpen(u, s.id)?.body
      const details = stepDetails(t, s, u, ctx.now)
      const actions: Action[] = [
        { hotkey: 'g', label: 'chat', key: `chat-${s.id}`, onPress: () => showInChat($, s.id) },
        { hotkey: 'k', label: s.pin === undefined ? 'keep' : 'unkeep', key: `keep-${s.id}`, onPress: () => toggleKeep($, s) },
        { hotkey: 'c', label: 'copy', key: `copy-${s.id}`, onPress: () => copyResult($, stepMarkdown(s, body), surface) },
      ]
      add(`open-${s.id}`, details.length + 1, () => opened(ctx, $, details, actions))
      gap()
    }
    const addMore = (key: string, n: number, what: string, onPress: () => Promise<void>): void => {
      add(key, 1, () => (
        <Button key={key} plain dimColor onPress={onPress}>
          {line([at(2, '+'), at(4, wordFit(`${n} ${what}`, Math.max(0, cols - 4)))])}
        </Button>
      ))
    }
    // A turn: its label (a Button when older), up to 5 rows, `+ n more in this turn`.
    const addTurn = (g: Group, isNewest: boolean): void => {
      const id = groupId(g)
      gap()
      const label = g.turn === undefined ? 'EARLIER STEPS' : titleOf(g, 34)
      const ids = g.steps.map(s => s.id)
      const sectionAt = items.length
      add(`turn-${id}`, 1, () =>
        section(ctx, $, label, 'agent', 'time', {
          key: `turn-${id}`,
          ...(isNewest ? {} : { onPress: () => toggleTurn($, id, ids) }),
        }),
      )
      const every = u.openTurns.includes(allOf(id))
      const visible = every ? g.steps : g.steps.filter((s, i) => i < TURN_ROWS || s.id === u.stepOpen)
      for (const s of visible) addStep(s, sectionAt)
      const hidden = g.steps.length - visible.length
      if (hidden > 0) addMore(`more-${id}`, hidden, 'more in this turn', () => toggleMark($, allOf(id)))
    }

    const [newest, ...older] = groups as [Group, ...Group[]]
    const isOpenGroup = (g: Group): boolean =>
      u.openTurns.includes(groupId(g)) || g.steps.some(s => s.id === u.stepOpen)
    addTurn(newest, true)
    for (const g of older.filter(isOpenGroup)) addTurn(g, false)
    const earlier = older.filter(g => !isOpenGroup(g))
    if (earlier.length > 0) {
      gap()
      add('sec-earlier', 1, () => section(ctx, $, 'EARLIER TURNS', find.active ? 'hits' : 'steps', 'at'))
      const every = u.openTurns.includes(ALL_EARLIER)
      for (const g of every ? earlier : earlier.slice(0, EARLIER_ROWS)) {
        const id = groupId(g)
        const ids = g.steps.map(s => s.id)
        add(`turn-${id}`, 1, () =>
          row(ctx, $, {
            key: `turn-${id}`,
            glyph: '›',
            name: titleOf(g, 40),
            metric: String(g.steps.length),
            time: g.turn !== undefined ? clock(g.turn.startedAt) : '',
            onPress: () => toggleTurn($, id, ids),
          }),
        )
      }
      if (!every && earlier.length > EARLIER_ROWS) {
        addMore('more-earlier', earlier.length - EARLIER_ROWS, 'more turns', () => toggleMark($, ALL_EARLIER))
      }
    }
    while (items.length > 0 && items[items.length - 1]?.isBlank === true) items.pop()

    const total = items.reduce((sum, it) => sum + it.height, 0)
    const { offset, bodyRows } = scrollOf(ctx)
    const win = windowRows(total, offset, bodyRows, Math.max(MIN_PAD, bodyRows))
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

    // ---- the footer: at most 3 entries, only while the pane has the focus
    const openStepRow = u.stepOpen !== undefined ? t.steps.find(s => s.id === u.stepOpen) : undefined
    const nextHint = (label: string): Hint => ({ hotkey: 'n', label, key: 'hint-n', onPress: walk(1) })
    const prevHint: Hint = { hotkey: 'p', label: 'prev', key: 'hint-p', onPress: walk(-1) }
    let hints: Hint[]
    if (openStepRow !== undefined && targetIds.length > 0) {
      // n and p stay armed while a step is open, so the walk goes on; q is in the full step.
      hints = [nextHint(find.active ? 'next hit' : 'next error'), prevHint, { text: '↵ full step' }]
    } else if (openStepRow !== undefined) {
      const body = bodyOfOpen(u, openStepRow.id)?.body
      hints = [
        { text: '↵ full step' },
        { hotkey: 'q', label: 'quote', key: 'hint-q', onPress: () => quoteInPrompt($, quoteOf(openStepRow, body)) },
        { text: 'esc close' },
      ]
    } else if (find.active) {
      hints = targetIds.length > 0 ? [nextHint('next hit'), prevHint, { text: 'esc clear' }] : [{ text: 'esc clear' }]
    } else if (targetIds.length > 0) {
      hints = [nextHint('next error'), prevHint, { text: '↵ open' }]
    } else {
      hints = [{ text: '↵ open' }, { text: 'esc prompt' }]
    }
    const foot = footer(ctx, $, fitHints(hints, cols))

    return (
      <Box flexDirection="column">
        {findRow}
        {blank(ctx, $, 'gap-find')}
        {chips}
        {blank(ctx, $, 'gap-chips')}
        <Box key="list" flexDirection="column">
          {top > 0 ? <Box key="space-top" height={top} /> : null}
          {drawn}
          {bottom > 0 ? <Box key="space-bottom" height={bottom} /> : null}
        </Box>
        {foot !== null ? blank(ctx, $, 'gap-foot') : null}
        {foot}
      </Box>
    )
  } catch (err) {
    debug($, `timeline view failed: ${errText(err)}`)
    return <Text dimColor>{fit(`Steps: ${errText(err)}`, cols)}</Text>
  }
}
