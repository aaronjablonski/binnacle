import type { EngineInterface } from 'claude-code'

import { journalOf, readBody } from '../journal'
import { MAX_HITS } from '../model/limits'
import { debug, errText, readTimeline, readUi, updateUi } from '../state'

/** Deep search reads at most this many stored bodies. */
export const DEEP_MAX_BODIES = 200
/** Deep search stops this long after it starts, inside the engine's 10 s hook budget. */
export const DEEP_MAX_MS = 8000

/** The Input's onInput: the query follows the text, and the old deep-search hits no longer apply. */
export async function setQuery($: EngineInterface, query: string): Promise<void> {
  await updateUi($, ({ hits: _old, ...u }) => ({ ...u, query }))
}

/**
 * The Input's onSubmit: reads stored step results, newest step first, for the
 * query's text. Reads at most `DEEP_MAX_BODIES` bodies and stops after
 * `DEEP_MAX_MS`. The hit ids go to `ui.hits`, unless the person typed on
 * meanwhile. A blank query only clears the hits. Never throws.
 */
export async function deepSearch($: EngineInterface, text: string): Promise<void> {
  const query = text.trim()
  try {
    if (query === '') {
      await updateUi($, ({ hits: _old, ...u }) => ({ ...u, query: text }))
      return
    }
    const needle = query.toLowerCase()
    const t = await readTimeline($)
    const journal = await journalOf($, t)
    const started = await $.clock.now()
    const newestFirst = [...t.steps].sort((a, b) => b.seq - a.seq)
    const hits: string[] = []
    let read = 0
    for (const s of newestFirst) {
      if (read >= DEEP_MAX_BODIES) break
      if ((await $.clock.now()) - started >= DEEP_MAX_MS) break
      read += 1
      const body = await readBody($, journal, s.id)
      if (body !== undefined && body.text.toLowerCase().includes(needle)) {
        hits.push(s.id)
        if (hits.length >= MAX_HITS) break
      }
    }
    // The person may have typed on while the files were read.
    if ((await readUi($)).query.trim() !== query) return
    await updateUi($, u => ({ ...u, hits }))
    $.ui.toast(hits.length === 0 ? `No step result holds "${query}".` : `${hits.length} ${hits.length === 1 ? 'result holds' : 'results hold'} "${query}".`)
  } catch (err) {
    debug($, `deep search failed: ${errText(err)}`)
  }
}

/**
 * Scrolls the transcript to the step's own row and centres it. Only for a
 * press: the engine refuses an unasked move of a transcript row, and a refusal
 * is shown as a toast.
 */
export async function showInChat($: EngineInterface, stepId: string): Promise<void> {
  try {
    const got = await $.ui.scroll({ to: { requestId: stepId }, block: 'center' })
    if (got.deny !== undefined) $.ui.toast(`Not shown in chat: ${got.deny}`)
  } catch (err) {
    debug($, `show in chat failed: ${errText(err)}`)
    $.ui.toast(`Not shown in chat: ${errText(err)}`)
  }
}
