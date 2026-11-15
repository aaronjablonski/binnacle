import type { EngineInterface } from 'claude-code'

import type { StepBody } from '../../types'
import { journalOf, readBody } from '../journal'
import { updateUi } from '../state'

/**
 * Opens a step's detail on the Timeline tab: the detail is set at once, then
 * the body is read from the timeline's journal folder and written under it
 * (`body`, or `missing` when the disk holds none). Shared by the Timeline's
 * rows and the Overview's LATEST rows. Never throws.
 */
export async function openStep($: EngineInterface, stepId: string): Promise<void> {
  await updateUi($, u => ({ ...u, tab: 'timeline', detail: { stepId } }))
  let body: StepBody | undefined
  try {
    body = await readBody($, await journalOf($), stepId)
  } catch {
    body = undefined
  }
  await updateUi($, u => {
    if (u.detail?.stepId !== stepId) return u
    return { ...u, detail: body !== undefined ? { stepId, body } : { stepId, missing: true } }
  })
}
