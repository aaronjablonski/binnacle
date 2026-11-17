// The Pull request block (R46): the PR the session works on and, on a GitHub
// stack (gh stack), its members as one row to step through and open.
//
//     Pull request ────────────────── #123 open · ✓ checks · approved
//     PR 7 host-aware sign-in: build, Fable, submit
//     main › ✓#120 › ○#121 › ▸#123 › ◌#124
//
// The head and the title open the PR under the cursor in the browser; each
// stack item is a Button opening its own. `h` and `l` move the cursor along
// the stack, toward the trunk and away (Now's footer arms them; the engine
// refuses `[` and `]`: a hotkey is one digit or one lowercase letter), `o`
// opens the PR under it. Hidden when
// there is neither a PR nor a stack: a branch with no PR yet says so in one
// dim row only when the pane has seen a PR this session.

import type { EngineInterface, RenderElement } from 'claude-code'

import type { PrState, StackItem } from '../../types'
import { checksMark, prMark, stackIndex } from '../model/pr'
import { updateUi } from '../state'
import { openLink } from './artifacts'
import { wordFit } from './fit'
import { section } from './parts'
import type { Run } from './parts'
import type { ViewCtx } from './shell'
import { CK, edges } from './style'
import type { FootHint } from './tabkit'
import type { Press } from './watch'

const asIs: Press = f => f

/** What the block points at: the stack item under the cursor, else the current PR. */
export type PrFocus = { number?: number; url?: string; title?: string; branch: string; item?: StackItem; index: number }

/** The cursor's index in the stack: the `prCursor` branch when still on it, else the current branch. */
export function cursorIndex(pr: PrState, cursor: string | undefined): number {
  const items = pr.stack?.items ?? []
  const at = cursor !== undefined ? items.findIndex(i => i.branch === cursor) : -1
  return at >= 0 ? at : stackIndex(pr)
}

export function prFocus(pr: PrState, cursor: string | undefined): PrFocus | undefined {
  const items = pr.stack?.items
  const i = cursorIndex(pr, cursor)
  if (items !== undefined && i >= 0) {
    const it = items[i]!
    const cur = it.branch === pr.branch ? pr.current : undefined
    return { branch: it.branch, item: it, index: i, ...(it.number !== undefined ? { number: it.number } : {}), ...(it.url !== undefined ? { url: it.url } : {}), ...((cur?.title ?? it.title) !== undefined ? { title: cur?.title ?? it.title } : {}) }
  }
  if (pr.current === undefined) return undefined
  return { branch: pr.branch, number: pr.current.number, url: pr.current.url, title: pr.current.title, index: -1 }
}

/** Whether the block draws: a PR on this branch or a stack. */
export const hasPr = (pr: PrState | undefined): pr is PrState => pr !== undefined && (pr.current !== undefined || pr.stack !== undefined)

/** The rows the block takes: the head, the title, and the stack row on a stack. */
export function prHeight(pr: PrState | undefined): number {
  if (!hasPr(pr)) return 0
  return 2 + (pr.stack !== undefined ? 1 : 0)
}

/** Moves the stack cursor by `d` (press only). */
export function moveCursor($: EngineInterface, pr: PrState, d: number): Promise<void> {
  const items = pr.stack?.items ?? []
  if (items.length === 0) return Promise.resolve()
  return updateUi($, u => {
    const at = cursorIndex(pr, u.prCursor)
    const next = Math.max(0, Math.min(items.length - 1, (at < 0 ? 0 : at) + d))
    return { ...u, prCursor: items[next]!.branch }
  })
}

/** Opens the focused PR in the browser (press only). */
export async function openFocused($: EngineInterface, ctx: ViewCtx, f: PrFocus | undefined): Promise<void> {
  if (f?.url === undefined || f.url === '') return
  await openLink($, f.url, ctx.e.surface)
}

/** Now's footer hints for the block: `o open PR`, and `h` `l` armed on a stack. */
export function prHints($: EngineInterface, ctx: ViewCtx): FootHint[] {
  const pr = ctx.pr
  if (!hasPr(pr)) return []
  const f = prFocus(pr, ctx.u.prCursor)
  const out: FootHint[] = []
  if (f?.url !== undefined) out.push({ hotkey: 'o', label: f.number !== undefined ? `open #${f.number}` : 'open PR', id: 'hint-pr-open', onPress: () => openFocused($, ctx, f) })
  if ((pr.stack?.items.length ?? 0) > 1) {
    out.push({ hotkey: 'h', label: 'down the stack', id: 'hint-pr-prev', onPress: () => moveCursor($, pr, -1), hidden: true })
    out.push({ hotkey: 'l', label: 'up the stack', id: 'hint-pr-next', onPress: () => moveCursor($, pr, 1), hidden: true })
  }
  return out
}

/** The head's summary for the focused PR: `#123 open · ✓ checks · approved`. */
function summary(pr: PrState, f: PrFocus): Run[] {
  const it = f.item
  const cur = f.branch === pr.branch ? pr.current : undefined
  const state = cur?.state ?? it?.state
  const draft = cur?.draft ?? it?.draft
  const checks = cur?.checks ?? it?.checks
  const out: Run[] = []
  if (f.number === undefined) return [{ text: 'no PR yet', dim: true }]
  out.push({ text: `#${f.number}`, bold: true }, { text: ` ${draft === true && state === 'open' ? 'draft' : state ?? 'open'}`, dim: true })
  if (it?.queued === true) out.push({ text: ' · queued', dim: true })
  if (it?.rebase === true) out.push({ text: ' · needs rebase', color: CK.ask })
  const cm = checksMark(checks)
  if (cm !== '') out.push({ text: ' · ', dim: true }, checks === 'fail' ? { text: `${cm} checks`, color: CK.fail } : checks === 'pass' ? { text: `${cm} checks`, color: CK.ok } : { text: `${cm} checks`, dim: true })
  const review = cur?.review
  if (review === 'approved') out.push({ text: ' · ', dim: true }, { text: 'approved', color: CK.ok })
  else if (review === 'changes') out.push({ text: ' · ', dim: true }, { text: 'changes asked', color: CK.ask })
  return out
}

/** The stack row's item words: its mark and number, or its branch when it has no PR. */
const itemWords = (it: StackItem): string => `${prMark(it)}${it.number !== undefined ? `#${it.number}` : it.branch}`

/**
 * The window of stack items that fits `room` cells around the cursor, with
 * `…` where items are left out; `main ›` first when the bottom is in view.
 */
export function stackWindow(trunk: string, items: StackItem[], at: number, room: number): { from: number; to: number; trunk: boolean } {
  const w = (i: number): number => itemWords(items[i]!).length + 1 + 3 // the cursor's ▸ and the ` › `
  let from = Math.max(0, at)
  let to = Math.max(0, at)
  let used = w(from)
  for (;;) {
    let grew = false
    if (to + 1 < items.length && used + w(to + 1) + 2 <= room) {
      to += 1
      used += w(to)
      grew = true
    }
    if (from > 0 && used + w(from - 1) + 2 <= room) {
      from -= 1
      used += w(from)
      grew = true
    }
    if (!grew) break
  }
  const withTrunk = from === 0 && used + trunk.length + 3 <= room
  return { from, to, trunk: withTrunk }
}

/** The block: the head, the title (both open the PR), and on a stack the members as Buttons. */
export function prBlock(ctx: ViewCtx, $: EngineInterface, o: { press?: Press } = {}): RenderElement[] {
  const pr = ctx.pr
  if (!hasPr(pr)) return []
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  const press = o.press ?? asIs
  const { left, right } = edges(ctx.cols)
  const room = Math.max(1, right - left + 1)
  const f = prFocus(pr, ctx.u.prCursor)
  if (f === undefined) return []
  const open = press(() => openFocused($, ctx, f))
  const out: RenderElement[] = [section(ctx, $, 'Pull request', summary(pr, f), { key: 'sec-pr', ...(f.url !== undefined ? { onPress: open } : {}) })]
  const title = f.title !== undefined && f.title !== '' ? f.title : f.branch
  out.push(
    <Box key="pr-title-row" flexDirection="row">
      <Text>{' '.repeat(left)}</Text>
      {f.url !== undefined ? (
        <Button key="pr-title" plain onPress={open}>
          <Text>{wordFit(title, room)}</Text>
        </Button>
      ) : (
        <Text key="pr-title" dimColor wrap="truncate-end">{wordFit(title, room)}</Text>
      )}
    </Box>,
  )
  const items = pr.stack?.items
  if (items !== undefined && items.length > 0) {
    const at = Math.max(0, f.index)
    const win = stackWindow(pr.stack!.trunk, items, at, room)
    const parts: RenderElement[] = [<Text key="pr-stack-pad">{' '.repeat(left)}</Text>]
    if (win.trunk) parts.push(<Text key="pr-stack-trunk" dimColor>{`${pr.stack!.trunk} › `}</Text>)
    else if (win.from > 0) parts.push(<Text key="pr-stack-more-l" dimColor>{'… '}</Text>)
    for (let i = win.from; i <= win.to; i++) {
      const it = items[i]!
      const here = i === at
      const color = it.state === 'merged' ? CK.ok : it.state === 'closed' ? CK.rule : it.checks === 'fail' ? CK.fail : undefined
      // A long branch name (no PR yet) is cut to the row's room, so the selected item never runs past the pane.
      const words = wordFit(`${here ? '▸' : ''}${itemWords(it)}`, Math.max(4, room - 8))
      const body = here ? <Text bold color={CK.accent}>{words}</Text> : <Text {...(color !== undefined ? { color } : {})} {...(it.branch === pr.branch ? { bold: true } : {})}>{words}</Text>
      const url = it.url
      parts.push(
        url !== undefined ? (
          <Button key={`pr-stack-${i}`} plain onPress={press(() => openLink($, url, ctx.e.surface))}>
            {body}
          </Button>
        ) : (
          <Text key={`pr-stack-${i}`}>{body}</Text>
        ),
      )
      if (i < win.to) parts.push(<Text key={`pr-stack-sep-${i}`} dimColor>{' › '}</Text>)
    }
    if (win.to < items.length - 1) parts.push(<Text key="pr-stack-more-r" dimColor>{' …'}</Text>)
    out.push(
      <Box key="pr-stack-row" flexDirection="row">
        {parts}
      </Box>,
    )
  }
  return out
}

/** The one-line form for the band, the strip and slim: `#123 ✓` and `2/4` on a stack. */
export function prChip(pr: PrState | undefined): Run[] {
  if (!hasPr(pr)) return []
  const n = pr.current?.number
  const out: Run[] = []
  if (n !== undefined) {
    out.push({ text: `#${n}`, bold: true })
    const cm = checksMark(pr.current?.checks)
    if (cm !== '') out.push({ text: ` ${cm}`, ...(pr.current?.checks === 'fail' ? { color: CK.fail } : pr.current?.checks === 'pass' ? { color: CK.ok } : { dim: true }) })
  }
  const items = pr.stack?.items
  if (items !== undefined && items.length > 1) {
    const at = stackIndex(pr)
    out.push({ text: `${out.length > 0 ? ' ' : ''}stack ${at + 1}/${items.length}`, dim: true })
  }
  return out
}
