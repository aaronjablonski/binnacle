import type { EngineInterface, RenderElement } from 'claude-code'

import { dismissKey, watch } from '../model/alerts'
import type { Watch } from '../model/alerts'
import { updateUi } from '../state'
import { openAgentPage } from './agentmeta'
import { showInChat } from './find'
import { shortPaths, wrapWords } from './fit'
import { needsLimits } from './needs'
import { openStepInline } from './openstep'
import { runText, section, viewAgent } from './parts'
import type { Run } from './parts'
import type { ViewCtx } from './shell'
import { edges } from './style'

// Watch (cockpit spec "CockpitNowWatch", R6): what is worth a glance and asks
// nothing. Dim rows, `v g x` on the first, never amber, never the band's
// lead, never autoFocus. The rows come from the alert model's `watch`
// selector alone (alerts.ts), dismissals from `ui.dismissed`.

/** A press: as given, or wrapped (the band's strip leaves for the pane after it). */
export type Press = (f: () => void | Promise<void>) => () => void | Promise<void>
const asIs: Press = f => f

/** The watch rows not dismissed, newest first, under the limits in force. */
export function watchRows(ctx: Pick<ViewCtx, 't' | 'u' | 'now'>): Watch[] {
  return watch(ctx.t, ctx.now, ctx.u.dismissed, needsLimits())
}

/** The kind's glyph and word: `◔ Long run`, `↻ Repeat`. */
export const WATCH_KIND: Record<Watch['kind'], { glyph: string; word: string }> = {
  'long-run': { glyph: '◔', word: 'Long run' },
  stalled: { glyph: '◔', word: 'Stalled' },
  quiet: { glyph: '◌', word: 'Quiet' },
  repeat: { glyph: '↻', word: 'Repeat' },
  loop: { glyph: '↻', word: 'Loop' },
}

/** Where a row's sentence starts at 62 columns (after `◔ Long run   `). */
export const WATCH_TEXT = 15

/**
 * A row's sentence: the model's words for a long run, a stall and a quiet
 * loop (R6); a repeat or a loop quotes its command, as the mock reads:
 * `“npm test upload” failed 3 times in a row`.
 */
export function watchSentence(w: Watch): string {
  const cmd = shortPaths((w.command ?? '').replace(/\s+/g, ' ').trim())
  if (w.kind === 'repeat' && cmd !== '') return `“${cmd}” failed ${w.count ?? 2} times in a row`
  if (w.kind === 'loop' && cmd !== '') return `“${cmd}” ran ${w.count ?? 3} times this turn`
  return w.sentence
}

/** Dismisses a watch row: its key (with its count) goes to `ui.dismissed`. Press handlers only. */
export function dismissWatch($: EngineInterface, w: Watch): Promise<void> {
  return updateUi($, cur => ({ ...cur, dismissed: [...cur.dismissed, dismissKey(w)].slice(-200) }))
}

/** A row's press: its step opened in place, else the agent's page, else the Steps tab. */
function openWatch($: EngineInterface, w: Watch, key: string): Promise<void> {
  if (w.stepId !== undefined) return openStepInline($, w.stepId)
  if (w.agent !== 'main') return openAgentPage($, w.agent, key)
  return updateUi($, u => ({ ...u, tab: 'timeline', filter: { kind: 'all' } }))
}

/** The rows `watchBlock` takes for `rows` with `cap` listed: the head, each row (two when its sentence wraps), the keys under the first, `+ n more`. */
export function watchHeight(ctx: ViewCtx, rows: Watch[], cap: number, keys = true): number {
  if (rows.length === 0) return 0
  const shown = rows.slice(0, cap)
  const room = textRoom(ctx)
  return 1 + shown.reduce((n, w) => n + Math.min(2, wrapWords(watchSentence(w), room, 2).length), 0) + (keys ? 1 : 0) + (rows.length > shown.length ? 1 : 0)
}

const textRoom = (ctx: ViewCtx): number => Math.max(1, edges(ctx.cols).right - WATCH_TEXT + 1)

/**
 * The Watch block: the dim head "Watch … no action needed", then one dim row
 * a thing (the kind's glyph and word, its sentence at 15, wrapped to two
 * lines at most), each a plain Button that opens its step or agent; under
 * the first row its keys as hotkeyed Buttons (`v: transcript` for a
 * subagent, `g: chat` for a step or the call that spawned the agent, `x: dismiss`); more than `cap` rows end in
 * `+ n more to watch`. Nothing in `warning`. Empty when there is nothing.
 * `keys: false` (the band's strip) leaves the hotkeys out.
 */
export function watchBlock(ctx: ViewCtx, $: EngineInterface, rows: Watch[], cap: number, o: { press?: Press; keys?: boolean } = {}): RenderElement[] {
  if (rows.length === 0) return []
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  const press = o.press ?? asIs
  const { left } = edges(ctx.cols)
  const room = textRoom(ctx)
  const out: RenderElement[] = [section(ctx, $, 'Watch', 'no action needed', { tone: 'dim', key: 'sec-watch' })]
  const shown = rows.slice(0, cap)
  shown.forEach((w, i) => {
    const kind = WATCH_KIND[w.kind]
    const lines = wrapWords(watchSentence(w), room, 2)
    const key = `watch-${w.key}`
    const head: Run[] = [
      { text: `${kind.glyph} `, dim: true },
      { text: kind.word.padEnd(WATCH_TEXT - left - 2) },
      { text: lines[0] ?? '', dim: true },
    ]
    out.push(
      <Box key={`row-${key}`} flexDirection="row">
        <Text>{' '.repeat(left)}</Text>
        <Button key={key} plain onPress={press(() => openWatch($, w, key))}>
          {head.map((r, j) => runText(r, ctx.e, $, `${key}-${j}`))}
        </Button>
      </Box>,
    )
    if (lines[1] !== undefined) {
      out.push(
        <Text key={`${key}-more`} dimColor wrap="truncate-end">
          {`${' '.repeat(WATCH_TEXT)}${lines[1]}`}
        </Text>,
      )
    }
    if (i !== 0 || o.keys === false) return
    const keys: { hotkey: string; label: string; key: string; run: () => void | Promise<void> }[] = []
    if (w.agent !== 'main') {
      const id = w.agent
      keys.push({ hotkey: 'v', label: 'transcript', key: `watch-view-${w.key}`, run: () => viewAgent($, id) })
    }
    // g: the step's own row in the chat, or for an agent the call that spawned it.
    const chatId = w.stepId ?? (w.agent !== 'main' ? ctx.t.agents[w.agent]?.spawnStep : undefined)
    if (chatId !== undefined) {
      const id = chatId
      keys.push({ hotkey: 'g', label: 'chat', key: `watch-chat-${w.key}`, run: () => showInChat($, id) })
    }
    keys.push({ hotkey: 'x', label: 'dismiss', key: `watch-dismiss-${w.key}`, run: () => dismissWatch($, w) })
    const kept: typeof keys = []
    let used = WATCH_TEXT
    for (const k of keys) {
      const width = (kept.length > 0 ? 3 : 0) + k.hotkey.length + 2 + k.label.length
      if (used + width > edges(ctx.cols).right + 1) break
      kept.push(k)
      used += width
    }
    out.push(
      <Box key={`${key}-keys`} flexDirection="row" paddingLeft={WATCH_TEXT} columnGap={3}>
        {kept.map(k => (
          <Button key={k.key} hotkey={k.hotkey} plain onPress={k.run}>
            {k.label}
          </Button>
        ))}
      </Box>,
    )
  })
  if (rows.length > shown.length) {
    out.push(
      <Text key="watch-more" dimColor wrap="truncate-end">
        {`${' '.repeat(left + 2)}+ ${rows.length - shown.length} more to watch`}
      </Text>,
    )
  }
  return out
}
