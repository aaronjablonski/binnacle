// Fetches the pull request and GitHub stack the session works on (gh and
// gh-stack on the host), into the `pr` atom the views read.
//
// When: at session start, 2 s after a Bash command that may move the branch
// or a PR (model/pr.ts `touchesPr`), when the pane opens, and every 3 min
// while the folder is a git repository. One fetch at a time; a request during
// one runs once more after it. A failure (no gh, no remote, offline) keeps
// the last good state; a branch with no PR clears it to the branch alone.
// Observes only: the tool call's result is what next(e) resolved to.

import type { EngineInterface, On, Timer } from 'claude-code'

import { buildPrState, parsePrList, parseStack, PR_LIST_FIELDS, touchesPr } from './model/pr'
import { debug, errText, readPr, writePr } from './state'

export const PR_EVERY_MS = 3 * 60_000
export const PR_DEBOUNCE_MS = 2_000
const RUN_MS = 15_000

let running = false
let again = false
let soon: Timer | undefined
let tick: Timer | undefined

async function run($: EngineInterface, argv: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const r = await $.process.run(argv, { timeoutMs: RUN_MS })
    return { ok: r.exitCode === 0, out: r.stdout }
  } catch (err) {
    debug($, `${argv.slice(0, 3).join(' ')} failed: ${errText(err)}`)
    return { ok: false, out: '' }
  }
}

/** One fetch: the branch, the stack if any, then one `gh pr list` matched by head branch. Answers false off a git repository. */
export async function fetchPr($: EngineInterface): Promise<boolean> {
  const br = await run($, ['git', 'branch', '--show-current'])
  if (!br.ok) return false
  const branch = br.out.trim()
  if (branch === '') return true // detached HEAD: keep what is shown
  const stackRun = await run($, ['gh', 'stack', 'view', '--json'])
  const stack = stackRun.ok ? parseStack(stackRun.out) : undefined
  const list = await run($, ['gh', 'pr', 'list', '--state', 'all', '--limit', '60', '--json', PR_LIST_FIELDS])
  const had = await readPr($)
  if (!list.ok) {
    // gh missing, signed out or offline: keep the last state of this branch.
    if (had.branch !== branch) await writePr($, { at: await $.clock.now(), branch })
    return true
  }
  // `gh pr list` lists open PRs first and only the newest 60: ask the branch itself when it is missing.
  let prs = parsePrList(list.out)
  if (!prs.has(branch)) {
    const one = await run($, ['gh', 'pr', 'view', branch, '--json', PR_LIST_FIELDS])
    if (one.ok) prs = new Map([...prs, ...parsePrList(`[${one.out}]`)])
  }
  await writePr($, buildPrState(await $.clock.now(), branch, prs, stack))
  return true
}

/** Fetches now, or once more after the fetch running. Never throws. */
export async function refreshPr($: EngineInterface): Promise<void> {
  if (running) {
    again = true
    return
  }
  running = true
  try {
    do {
      again = false
      await fetchPr($)
    } while (again)
  } catch (err) {
    debug($, `pr fetch failed: ${errText(err)}`)
  } finally {
    running = false
  }
}

/** A fetch in `ms`, replacing one already asked for. */
export function refreshSoon($: EngineInterface, ms = PR_DEBOUNCE_MS): void {
  soon?.cancel()
  soon = $.clock.after(ms, () => {
    soon = undefined
    void refreshPr($)
  })
}

/** At session start: a fetch now, then one every 3 min for as long as the folder is a repository. */
export async function startPr($: EngineInterface): Promise<void> {
  tick?.cancel()
  // A reload (an option change writes the config and reloads the mod) runs this again: a PR fetched in the
  // last minute is kept, and the next fetch waits for the usual period, so changing options stays quick.
  try {
    const had = await readPr($)
    const now = await $.clock.now()
    if (had.at > 0 && now - had.at < 60_000) {
      tick = $.clock.after(PR_EVERY_MS, () => void startPr($))
      return
    }
  } catch (err) {
    debug($, `pr freshness check failed: ${errText(err)}`)
  }
  const loop = async (): Promise<void> => {
    let repo = true
    try {
      if (running) again = true
      else {
        running = true
        try {
          repo = await fetchPr($)
        } finally {
          running = false
        }
      }
    } catch (err) {
      debug($, `pr fetch failed: ${errText(err)}`)
    }
    if (repo) tick = $.clock.after(PR_EVERY_MS, () => void loop())
  }
  void loop()
}

export function registerPr(on: On): void {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    try {
      const command = (e as unknown as { command?: unknown }).command
      if (typeof command === 'string' && touchesPr(command)) refreshSoon($)
    } catch (err) {
      debug($, `pr trigger failed: ${errText(err)}`)
    }
    return ran
  }).catch(($, e, next) => next(e))
}
