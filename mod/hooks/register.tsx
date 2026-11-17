import type { Register } from 'claude-code'

import { registerCapture } from './capture'
import { registerPr, startPr } from './pr'
import { registerGuide, startGuide } from './guide'
import { END_RESERVE_MS, restore, restoreAfterClear, saveForClear } from './journal'
import { apply, debug, errText, hasTimeline, saveLedger } from './state'
import { registerBand } from './views/band'
import { seedBudget } from './views/budget'
import { configureNeeds } from './views/needs'
import { registerShell, runCommand, startShell, syncPaneOpen } from './views/shell'

export const register: Register = (on, options) => {
  registerCapture(on)
  // The long-run limits and the done sound: read by the views and the clock (needs.tsx).
  configureNeeds(options)
  registerGuide(on, options)
  registerShell(on, options)
  registerBand(on, options)
  registerPr(on)

  // The module's one session.start hook: every task's session-start work is
  // a helper called from here (validate refuses a second unmatched hook).
  // Each step has its own try, so one failing cannot skip the next (M2).
  on('session.start', async ($, e, next) => {
    // `/binnacle` is the one command (the old `/mc` alias is gone with the old name).
    try {
      await $.command.register({
        name: 'binnacle',
        description: 'Open Binnacle',
        argumentHint: '[1-5 | keep <note> | export | close | slim | strip | options]',
        immediate: true,
      })
    } catch (err) {
      debug($, `command.register binnacle failed: ${errText(err)}`)
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
    // The PR and stack: fetched in the background (gh can take seconds), then every 3 min.
    await startPr($)
    return next(e)
  })

  // A /clear resets $.state and goes on under a new session id with no
  // session.start: save the snapshot and leave a mark naming its folder for
  // the classic.SessionStart{clear} that follows. Any end then writes the
  // session's ledger row. The exit's bound is shared with core, so the work
  // reads next.budget.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      try {
        await saveForClear($, e.sessionId, () => next.budget.remainingMs)
      } catch {
        // saveForClear reports its own failures
      }
    }
    if (next.budget.remainingMs >= END_RESERVE_MS) {
      try {
        await saveLedger($, await $.clock.now(), () => next.budget.remainingMs >= END_RESERVE_MS)
      } catch {
        // saveLedger reports its own failures
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // A /clear, a resume or a fork goes on under another session id with no
  // session.start. A /clear adopts the record the mark names (spec goal 6);
  // a resume or fork loads that session's snapshot, following its link.
  // After a /clear the record is kept for Steps and Artifacts, but the
  // cleared conversation's headline, list and request fold away (C1).
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    try {
      if (e.source === 'clear') {
        await restoreAfterClear($, e.session_id)
        if (await hasTimeline($)) await apply($, { kind: 'clear', at: await $.clock.now() })
      } else await restore($, e.session_id, { prune: false })
    } catch (err) {
      // restore and restoreAfterClear report their own failures
      debug($, `session start (${e.source}) failed: ${errText(err)}`)
    }
    // A /clear resets $.state while the pane stays up: take the flag from the engine again.
    await syncPaneOpen($)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'binnacle' }, async ($, e) => {
    return runCommand($, e.args)
  })
}
