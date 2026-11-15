import type { Register } from 'claude-code'

import { registerCapture } from './capture'
import { registerGuide, startGuide } from './guide'
import { restore } from './journal'

export const register: Register = (on, options) => {
  registerCapture(on)
  registerGuide(on, options)

  // The module's one session.start hook: every task's session-start work is
  // a helper called from here (validate refuses a second unmatched hook).
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'mc',
      description: 'Open Mission Control',
    })
    try {
      await restore($, await $.session.id())
    } catch {
      // restore reports its own failures
    }
    // Before next(e), so the tool is listed by the first prompt (Finding i).
    await startGuide($, options)
    return next(e)
  })

  // A /clear, a resume or a fork goes on under another session id with no
  // session.start: load that session's snapshot here.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    try {
      await restore($, e.session_id, { prune: false })
    } catch {
      // restore reports its own failures
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'mc' }, async () => {
    return { text: 'Mission Control: not built yet.' }
  })
}
