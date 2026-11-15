// Detail pages (rich spec binding rule 4): `ui.page = { kind, id }` names the
// page that replaces the open tab's list. Set on a press (Enter on a task,
// agent, step or artifact), cleared by `b`, by a tab switch and by /mc 1-5.

import type { EngineInterface } from 'claude-code'

import type { PageKind, UiState } from '../../types'
import { debug, errText, updateUi } from '../state'

/** The kinds of page: the four detail pages, and Options. */
export const PAGE_KINDS: readonly PageKind[] = ['task', 'agent', 'step', 'artifact', 'options']

/** The longest page id kept. */
const MAX_PAGE_ID = 200

/** The page `u` names, or none when it names none or something an earlier version could not have written. */
export function pageOf(u: UiState): { kind: PageKind; id: string } | undefined {
  const p: unknown = u.page
  if (typeof p !== 'object' || p === null) return undefined
  const { kind, id } = p as { kind?: unknown; id?: unknown }
  if (typeof id !== 'string' || !PAGE_KINDS.includes(kind as PageKind)) return undefined
  return { kind: kind as PageKind, id }
}

/** The pane's state with no page open. */
export function leavePage(u: UiState): UiState {
  if (u.page === undefined) return u
  const { page: _page, ...rest } = u
  return rest
}

/** Opens the page of `kind` for `id`. From a press handler only. Never throws. */
export async function openPage($: EngineInterface, kind: PageKind, id: string): Promise<void> {
  try {
    await updateUi($, cur => ({ ...cur, page: { kind, id: id.slice(0, MAX_PAGE_ID) } }))
  } catch (err) {
    debug($, `open page ${kind} ${id} failed: ${errText(err)}`)
  }
}

/** Closes the open page (`b`): the tab's list comes back. From a press handler only. Never throws. */
export async function closePage($: EngineInterface): Promise<void> {
  try {
    await updateUi($, leavePage)
  } catch (err) {
    debug($, `close page failed: ${errText(err)}`)
  }
}
