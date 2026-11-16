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
 * (`detail`) is closed. `n`/`p` on Steps, a need and the strip use it; Enter
 * on a step row opens the page (`openStep`). Never throws.
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
 * The step's page (Enter on a step row anywhere: rich rule 4): `ui.page =
 * { kind: 'step', id, from }` opens at once, with the body already read for
 * it, or bare while a fresh read runs and is then written beside it
 * (`stepBody`, or `missing`). The open tab is kept, so `b` returns to the
 * list it was opened from; on the Steps tab the step is also marked in
 * place (`stepOpen`). Every caller that opens a step page comes here
 * (pagenav's `openPage` sends kind `step` here). Never throws.
 */
export async function openStep($: EngineInterface, stepId: string, from?: string): Promise<void> {
  let known: StepBodyOpen | undefined
  try {
    await updateUi($, u => {
      known = bodyOfOpen(u, stepId)
      const { detail: _detail, ...rest } = u
      const { stepBody: _old, ...bare } = rest as UiWithBody
      const keep = known !== undefined ? { stepBody: known } : {}
      const page = { kind: 'step' as const, id: stepId.slice(0, 200), ...(from !== undefined && from !== '' ? { from: from.slice(0, 200) } : {}) }
      return { ...bare, ...(u.tab === 'timeline' ? { stepOpen: stepId } : {}), page, ...keep } as UiState
    })
    if (known !== undefined) return
    const body = await bodyFor($, stepId)
    await updateUi($, u => {
      if (u.page?.kind !== 'step' || u.page.id !== stepId) return u
      const stepBody: StepBodyOpen = body !== undefined ? { stepId, body } : { stepId, missing: true }
      return { ...u, stepBody } as UiState
    })
  } catch {
    // The page stays as far as it got; the next press retries.
  }
}
