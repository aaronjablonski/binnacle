// Detail pages (rich spec binding rule 4): `ui.page = { kind, id }` names the
// page that replaces the open tab's list. Set on a press (Enter on a task,
// agent, step or artifact), cleared by `b`, by a tab switch and by /binnacle 1-5.

import type { EngineInterface } from 'claude-code'

import type { PageKind, UiState } from '../../types'
import { debug, errText, updateUi } from '../state'
import { openStep } from './openstep'
import { focusStart } from './shell'

/** The pane's request id (shell.tsx `PANE`; not imported, as shell imports this module). */
const PANE_ID = 'binnacle'

/** The kinds of page: the four detail pages, and Options. */
export const PAGE_KINDS: readonly PageKind[] = ['task', 'agent', 'step', 'artifact', 'options']

/** After a page opens or closes with no row to go back to, the ring lands on the first row (R51; shell.tsx `focusStart`). */
async function landFirst($: EngineInterface, why: string): Promise<void> {
  try {
    await focusStart($, why)
  } catch (err) {
    debug($, `${why}: focus failed: ${errText(err)}`)
  }
}

/** The longest page id kept. */
const MAX_PAGE_ID = 200

/** The page `u` names, or none when it names none or something an earlier version could not have written. */
export function pageOf(u: UiState): { kind: PageKind; id: string; from?: string } | undefined {
  const p: unknown = u.page
  if (typeof p !== 'object' || p === null) return undefined
  const { kind, id, from } = p as { kind?: unknown; id?: unknown; from?: unknown }
  if (typeof id !== 'string' || !PAGE_KINDS.includes(kind as PageKind)) return undefined
  return { kind: kind as PageKind, id, ...(typeof from === 'string' ? { from } : {}) }
}

/** The pane's state with no page open. */
export function leavePage(u: UiState): UiState {
  if (u.page === undefined) return u
  const { page: _page, ...rest } = u
  return rest
}

/** `page` for `kind` and `id`, opened from the row keyed `from` (both cut to their bounds). */
export function pageFor(kind: PageKind, id: string, from?: string): NonNullable<UiState['page']> {
  return { kind, id: id.slice(0, MAX_PAGE_ID), ...(from !== undefined && from !== '' ? { from: from.slice(0, MAX_PAGE_ID) } : {}) }
}

/**
 * Opens the page of `kind` for `id` (Enter on a row: rich rule 4). `from` is
 * the key of the row it was opened from, which `b` focuses again. A step's
 * page goes through `openStep`, so its body is read from the journal
 * whichever row opened it. From a press handler only. Never throws.
 */
export async function openPage($: EngineInterface, kind: PageKind, id: string, from?: string): Promise<void> {
  if (kind === 'step') {
    await openStep($, id, from)
    await landFirst($, `page ${kind}`)
    return
  }
  try {
    await updateUi($, cur => ({ ...cur, page: pageFor(kind, id, from) }))
  } catch (err) {
    debug($, `open page ${kind} ${id} failed: ${errText(err)}`)
    return
  }
  await landFirst($, `page ${kind}`)
}

/**
 * Closes the open page (`b`): the tab's list comes back, and the focus ring
 * goes back to the row the page was opened from (`page.from`), the way a tab
 * switch moves it. From a press handler only. Never throws; a ring that
 * cannot move stays where it was.
 */
export async function closePage($: EngineInterface): Promise<void> {
  let from: string | undefined
  try {
    await updateUi($, cur => {
      from = pageOf(cur)?.from
      return leavePage(cur)
    })
  } catch (err) {
    debug($, `close page failed: ${errText(err)}`)
    return
  }
  if (from === undefined) {
    await landFirst($, 'back')
    return
  }
  try {
    const moved = await $.ui.focus({ requestId: PANE_ID, key: from })
    if (moved.deny !== undefined) debug($, `back: focus ${from} denied: ${moved.deny}`)
  } catch (err) {
    debug($, `back: focus ${from} failed: ${errText(err)}`)
  }
}
