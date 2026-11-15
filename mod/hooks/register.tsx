import type { Register } from 'claude-code'

import { registerCapture } from './capture'
import { registerGuide, startGuide } from './guide'
import { restore, restoreAfterClear, saveForClear } from './journal'
import { debug, errText } from './state'
import { registerBand } from './views/band'
import { seedBudget } from './views/budget'
import { registerShell, runMc, startShell } from './views/shell'

export const register: Register = (on, options) => {
  registerCapture(on)
  registerGuide(on, options)
  registerShell(on, options)
  registerBand(on)

  // The module's one session.start hook: every task's session-start work is
  // a helper called from here (validate refuses a second unmatched hook).
  // Each step has its own try, so one failing cannot skip the next (M2).
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'mc',
        description: 'Open Mission Control',
        argumentHint: '[1-5 | pin <note> | export | close]',
        immediate: true,
      })
    } catch (err) {
      debug($, `command.register failed: ${errText(err)}`)
    }
    try {
      await restore($, await $.session.id())
    } catch {
      // restore reports its own failures
    }
    // Before next(e), so the tool is listed by the first prompt (Finding i).
    await startGuide($, options)
    await startShell($, options)
    // The budget line waits for session.measure otherwise; take a first reading.
    await seedBudget($)
    return next(e)
  })

  // A /clear resets $.state and goes on under a new session id with no
  // session.start: save the snapshot and leave a mark naming its folder for
  // the classic.SessionStart{clear} that follows. The exit's bound is shared
  // with core, so the work reads next.budget.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      try {
        await saveForClear($, e.sessionId, () => next.budget.remainingMs)
      } catch {
        // saveForClear reports its own failures
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // A /clear, a resume or a fork goes on under another session id with no
  // session.start. A /clear adopts the record the mark names (spec goal 6);
  // a resume or fork loads that session's snapshot, following its link.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    try {
      if (e.source === 'clear') await restoreAfterClear($, e.session_id)
      else await restore($, e.session_id, { prune: false })
    } catch {
      // both report their own failures
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'mc' }, async ($, e) => {
    return runMc($, e.args)
  })
}
