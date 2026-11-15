import type { EngineInterface } from 'claude-code'

import type { StepBody } from '../../types'
import { digest, stamp } from '../model/digest'
import { debug, errText, readTimeline } from '../state'
import { journalOf, journalRoot, readBody } from '../journal'

/**
 * `/mc export`: writes the digest to `<journal root>/<journal id>/export-<stamp>.md`
 * and copies it. Runs only inside a command the person ran. Bodies are read
 * for kept steps alone: they are the only steps exported in full. Never throws.
 */
export async function exportDigest($: EngineInterface): Promise<{ text: string }> {
  try {
    const root = await journalRoot($)
    if (root === undefined) return { text: 'Could not export: no home folder for the journal.' }
    const t = await readTimeline($)
    const journal = await journalOf($, t)
    const bodies: Record<string, StepBody | undefined> = {}
    for (const s of t.steps) if (s.pin !== undefined) bodies[s.id] = await readBody($, journal, s.id)
    const now = await $.clock.now()
    const text = digest(t, bodies, now)
    const path = `${root}/${journal.replace(/[^A-Za-z0-9_-]/g, '_')}/export-${stamp(now)}.md`
    await $.fs.write(path, text)
    let tail = ''
    try {
      const got = await $.ui.copy({ text })
      if (!got.isCopied) tail = ` (copy failed: ${got.reason})`
    } catch (err) {
      tail = ` (copy failed: ${errText(err)})`
    }
    $.ui.toast(`Exported: ${path}${tail}`)
    return { text: `Exported: ${path}${tail}` }
  } catch (err) {
    debug($, `export failed: ${errText(err)}`)
    return { text: `Could not export: ${errText(err)}` }
  }
}
