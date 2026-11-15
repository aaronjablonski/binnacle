import type { EngineInterface } from 'claude-code'

import type { StepBody, UiState } from '../../types'
import { journalOf, readBody } from '../journal'
import { updateUi } from '../state'

/**
 * The body an inline-opened step draws its `result` lines from. It lives in
 * the pane's state beside `stepOpen` (a view may not read the disk), so a
 * reload keeps it. `missing` is set when the disk holds none.
 */
export type StepBodyOpen = { stepId: string; body?: StepBody; missing?: true }

/** `ui` as it is stored, with the inline step's body. */
export type UiWithBody = UiState & { stepBody?: StepBodyOpen }

/** The inline step's body when it belongs to step `id`. */
export function bodyOfOpen(u: UiState, id: string): StepBodyOpen | undefined {
  const b = (u as UiWithBody).stepBody
  return b !== undefined && b.stepId === id ? b : undefined
}

async function bodyFor($: EngineInterface, stepId: string): Promise<StepBody | undefined> {
  try {
    return await readBody($, await journalOf($), stepId)
  } catch {
    return undefined
  }
}

/**
 * Opens a step in place on the Steps tab (`ui.stepOpen`): the tab and the
 * step are set at once, then the body is read from the timeline's journal
 * folder and written beside it (`stepBody`, or `missing`). Any full step
 * (`detail`) is closed. The Steps rows and `n`/`p` use it; `openStep` is the
 * full step, opened only by a second press inside Steps. Never throws.
 */
export async function openStepInline($: EngineInterface, stepId: string): Promise<void> {
  await updateUi($, u => {
    const { detail: _detail, ...rest } = u
    const keep = bodyOfOpen(u, stepId)
    const { stepBody: _old, ...bare } = rest as UiWithBody
    return { ...bare, tab: 'timeline', stepOpen: stepId, ...(keep !== undefined ? { stepBody: keep } : {}) } as UiState
  })
  const body = await bodyFor($, stepId)
  await updateUi($, u => {
    if (u.stepOpen !== stepId) return u
    const stepBody: StepBodyOpen = body !== undefined ? { stepId, body } : { stepId, missing: true }
    return { ...u, stepBody } as UiState
  })
}

/**
 * The full step (the second press on a step, inside Steps): `detail` is set at once with the body
 * the inline open already read, or bare while a fresh read runs and is then
 * written under it (`body`, or `missing`). Never throws.
 */
export async function openStep($: EngineInterface, stepId: string): Promise<void> {
  let known: StepBodyOpen | undefined
  await updateUi($, u => {
    known = bodyOfOpen(u, stepId)
    const detail: NonNullable<UiState['detail']> =
      known?.body !== undefined ? { stepId, body: known.body } : known?.missing === true ? { stepId, missing: true } : { stepId }
    return { ...u, tab: 'timeline', stepOpen: stepId, detail }
  })
  if (known !== undefined) return
  const body = await bodyFor($, stepId)
  await updateUi($, u => {
    if (u.detail?.stepId !== stepId) return u
    return { ...u, detail: body !== undefined ? { stepId, body } : { stepId, missing: true } }
  })
}
