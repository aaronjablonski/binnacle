import type { EngineInterface } from 'claude-code'

import type { StepBody, Timeline } from '../types'
import {
  adopt, debug, dropClearMark, errText, hasTimeline, markClear, readTimeline, stampJournal, takeClearMark,
} from './state'

// The journal on disk: <home>/.claude/mission-control/<id>/ holds
// timeline.json (the last snapshot) and steps/<step-id>.json (each step's
// input and result text). `$.fs` does not expand `~`, so the root is built
// from the home variable; with none set, journalling is skipped.
//
// <id> is the timeline's `journal`: the session id it was first written
// under, kept across /clear (which changes the session id), so every body of
// one timeline sits in one folder. `journalOf` answers it for reads and
// `claimJournal` stamps it for writes.
//
// A /clear resets `$.state` and goes on under a new session id with no
// session.start. `saveForClear` (session.end, reason clear) saves the
// snapshot and leaves a `$.store` mark naming the folder; `restoreAfterClear`
// (classic.SessionStart, source clear) adopts that snapshot and writes
// <root>/<new id>/journal.json = { journal: <folder id> }, a link `restore`
// follows once, so a later `--resume <new id>` finds the record.

/** Result text kept per step, and the cut applied to each string of an input. */
export const MAX_TEXT = 20000
/** Session folders kept on disk. */
export const KEEP_SESSIONS = 20
/** A session folder younger than this is never pruned: it may be a live session's. */
export const MIN_PRUNE_AGE_MS = 24 * 60 * 60 * 1000
/**
 * A /clear's mark older than this is ignored. session.end and the next
 * classic.SessionStart run back to back in one process, so a fresh mark is
 * seconds old; an older one was left by a session that ended some other way
 * (a crash between the two) and must not hand its record to an unrelated
 * /clear later, perhaps in another project.
 */
export const CLEAR_MARK_MAX_AGE_MS = 2 * 60 * 1000
/** session.end shares one short bound with core: stop writing with less than this left. */
export const END_RESERVE_MS = 300
const LINK = 'journal.json'
const MAX_DEPTH = 8
const SAFE_NAME = /^[A-Za-z0-9_-]+$/
// `cmd /c` re-reads its command line: `&`, `^`, `%`, `|`, `<`, `>`, `(`, `)`
// and quotes all mean something there. Only a drive-rooted path of these
// characters is ever handed to it.
const CMD_SAFE_PATH = /^[A-Za-z]:[\\/][A-Za-z0-9 _.\-\\/]+$/

/** The folder that holds every session's journal, or undefined with no home. */
export async function journalRoot($: EngineInterface): Promise<string | undefined> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  if (home === undefined || home === '') return undefined
  return `${home.replace(/[\\/]+$/, '')}/.claude/mission-control`
}

const safe = (name: string): string => name.replace(/[^A-Za-z0-9_-]/g, '_')

async function sessionDir($: EngineInterface, sessionId: string): Promise<string | undefined> {
  const root = await journalRoot($)
  if (root === undefined) {
    debug($, 'no USERPROFILE or HOME: the journal is off')
    return undefined
  }
  return `${root}/${safe(sessionId)}`
}

function cutStrings(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) : value
  if (value === null || typeof value !== 'object') return value
  if (depth >= MAX_DEPTH) return '[nested too deep]'
  if (Array.isArray(value)) return value.map(v => cutStrings(v, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) out[k] = cutStrings(v, depth + 1)
  return out
}

/** A step's body as kept on disk: the input (long strings cut), the result text cut to MAX_TEXT. */
export function bodyOf(
  input: Record<string, unknown>,
  result: { text?: unknown; isError?: unknown } | undefined,
): StepBody {
  const full = typeof result?.text === 'string' ? result.text : ''
  const text = full.length > MAX_TEXT ? full.slice(0, MAX_TEXT) : full
  return {
    input: cutStrings(input) as Record<string, unknown>,
    text,
    cut: full.length - text.length,
    isError: result?.isError === true,
  }
}

/**
 * The id of the folder that holds this timeline's bodies and snapshot: its
 * `journal`, else this session's id. For reads; it stamps nothing. Task 8's
 * detail view reads a body with `readBody($, await journalOf($), stepId)`.
 */
export async function journalOf($: EngineInterface, t?: Timeline): Promise<string> {
  const cur = t ?? (await readTimeline($))
  return cur.journal ?? (await $.session.id())
}

/**
 * The folder id for a write: the timeline's `journal`, stamped with this
 * session's id the first time. Kept afterwards, across /clear.
 */
export async function claimJournal($: EngineInterface): Promise<string> {
  const cur = await readTimeline($)
  if (cur.journal !== undefined) return cur.journal
  return stampJournal($, await $.session.id())
}

/** Writes one step's body under journal folder `journal` (see `claimJournal`). */
export async function writeBody($: EngineInterface, journal: string, stepId: string, body: StepBody): Promise<void> {
  try {
    const dir = await sessionDir($, journal)
    if (dir === undefined) return
    await $.fs.write(`${dir}/steps/${safe(stepId)}.json`, JSON.stringify(body))
  } catch (err) {
    debug($, `writeBody ${stepId} failed: ${errText(err)}`)
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Reads one step's body from journal folder `journal` (see `journalOf`). */
export async function readBody($: EngineInterface, journal: string, stepId: string): Promise<StepBody | undefined> {
  try {
    const dir = await sessionDir($, journal)
    if (dir === undefined) return undefined
    const raw = await $.fs.read(`${dir}/steps/${safe(stepId)}.json`)
    if (typeof raw !== 'string') return undefined
    const v: unknown = JSON.parse(raw)
    if (!isObj(v) || !isObj(v.input) || typeof v.text !== 'string') return undefined
    return { input: v.input, text: v.text, cut: typeof v.cut === 'number' ? v.cut : 0, isError: v.isError === true }
  } catch {
    return undefined
  }
}

/** Writes `t` as the snapshot of journal folder `journal` (see `claimJournal`). */
export async function saveSnapshot($: EngineInterface, journal: string, t: Timeline): Promise<void> {
  try {
    const dir = await sessionDir($, journal)
    if (dir === undefined) return
    await $.fs.write(`${dir}/timeline.json`, JSON.stringify(t))
  } catch (err) {
    debug($, `saveSnapshot failed: ${errText(err)}`)
  }
}

function isTimeline(v: unknown): v is Timeline {
  return isObj(v) && typeof v.seq === 'number' && Array.isArray(v.turns) && Array.isArray(v.steps) &&
    isObj(v.agents) && isObj(v.runs) && Array.isArray(v.tasks) && Array.isArray(v.notes) &&
    Array.isArray(v.artifacts) && Array.isArray(v.changed)
}

export async function loadSnapshot($: EngineInterface, sessionId: string): Promise<Timeline | undefined> {
  try {
    const dir = await sessionDir($, sessionId)
    if (dir === undefined) return undefined
    const raw = await $.fs.read(`${dir}/timeline.json`)
    if (typeof raw !== 'string') return undefined
    const v: unknown = JSON.parse(raw)
    return isTimeline(v) ? v : undefined
  } catch {
    return undefined
  }
}

/** The folder id a link file names, when it is a plain id other than `self`. */
function linkTarget(raw: unknown, self: string): string | undefined {
  if (typeof raw !== 'string') return undefined
  try {
    const v: unknown = JSON.parse(raw)
    if (!isObj(v) || typeof v.journal !== 'string') return undefined
    const target = v.journal
    return SAFE_NAME.test(target) && target !== self ? target : undefined
  } catch {
    return undefined
  }
}

/** The journal folder <root>/<sessionId>/journal.json points to, if any. */
export async function readLink($: EngineInterface, sessionId: string): Promise<string | undefined> {
  try {
    const dir = await sessionDir($, sessionId)
    if (dir === undefined) return undefined
    return linkTarget(await $.fs.read(`${dir}/${LINK}`), safe(sessionId))
  } catch {
    return undefined
  }
}

/** Writes <root>/<sessionId>/journal.json pointing at folder `journal`. Never throws. */
export async function writeLink($: EngineInterface, sessionId: string, journal: string): Promise<void> {
  try {
    if (safe(sessionId) === safe(journal)) return
    const dir = await sessionDir($, sessionId)
    if (dir === undefined) return
    await $.fs.write(`${dir}/${LINK}`, JSON.stringify({ journal }))
  } catch (err) {
    debug($, `writeLink failed: ${errText(err)}`)
  }
}

/**
 * The snapshot of `sessionId`: its own, else the one its journal.json points
 * to, followed once (a link to a link loads nothing). A followed snapshot
 * keeps the folder it came from as its `journal`.
 */
export async function loadFollowing($: EngineInterface, sessionId: string): Promise<Timeline | undefined> {
  const own = await loadSnapshot($, sessionId)
  if (own !== undefined) return own
  const target = await readLink($, sessionId)
  if (target === undefined) return undefined
  const snap = await loadSnapshot($, target)
  if (snap === undefined) return undefined
  return snap.journal === undefined ? { ...snap, journal: target } : snap
}

async function mtimeOf($: EngineInterface, path: string): Promise<number> {
  for (const p of [`${path}/timeline.json`, `${path}/${LINK}`, path]) {
    try {
      const s = await $.fs.stat(p)
      if (s.mtimeMs > 0) return s.mtimeMs
    } catch {
      // try the next
    }
  }
  return 0
}

/**
 * Removes one session folder. `$.fs` has no delete, so this runs the
 * platform's own. On Windows that is `cmd`, which re-parses its command
 * line, so a path outside CMD_SAFE_PATH is left alone.
 */
async function removeDir($: EngineInterface, path: string): Promise<void> {
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  let argv: string[]
  if (isWindows) {
    const target = path.replace(/\//g, '\\')
    if (!CMD_SAFE_PATH.test(target)) {
      debug($, `prune: not removing ${target}: cmd could misread a character in it`)
      return
    }
    argv = ['cmd', '/d', '/c', 'rmdir', '/s', '/q', target]
  } else {
    argv = ['rm', '-rf', '--', path]
  }
  const ran = await $.process.run(argv)
  if (ran.exitCode !== 0) debug($, `prune: removing ${path} exited ${ran.exitCode}`)
}

/** True when the folder holds this mod's own files: a snapshot, a steps folder or a link. */
async function isOurs($: EngineInterface, path: string): Promise<boolean> {
  for (const p of [`${path}/timeline.json`, `${path}/steps`, `${path}/${LINK}`]) {
    try {
      if (await $.fs.exists(p)) return true
    } catch {
      // try the next
    }
  }
  return false
}

/**
 * Keeps the newest `keep` session folders (by their snapshot's time) and
 * removes the rest. A folder is removed only when its name is a plain id, it
 * is not in `spare`, no folder's journal.json points to it, its time is known
 * and over MIN_PRUNE_AGE_MS old, and it holds this mod's own files. With no
 * clock, nothing is removed.
 *
 * Every link spares its target, kept or not: simple, and a target outlives
 * its link by one prune at most.
 */
export async function prune($: EngineInterface, keep: number, spare: string | readonly string[] = []): Promise<void> {
  try {
    const root = await journalRoot($)
    if (root === undefined) return
    if (!(await $.fs.exists(root))) return
    const dirs = (await $.fs.list(root)).filter(d => d.kind === 'dir' && SAFE_NAME.test(d.name))
    if (dirs.length <= keep) return
    const now = await $.clock.now().catch(() => 0)
    if (!(now > 0)) {
      debug($, 'prune: no clock, nothing removed')
      return
    }
    const dated: { name: string; at: number }[] = []
    for (const d of dirs) dated.push({ name: d.name, at: await mtimeOf($, `${root}/${d.name}`) })
    dated.sort((a, b) => b.at - a.at)
    const spared = new Set((typeof spare === 'string' ? [spare] : spare).map(safe))
    for (const d of dirs) {
      const target = await readLink($, d.name)
      if (target !== undefined) spared.add(target)
    }
    for (const d of dated.slice(Math.max(0, keep))) {
      if (spared.has(d.name)) continue
      if (d.at <= 0 || now - d.at < MIN_PRUNE_AGE_MS) continue
      const path = `${root}/${d.name}`
      try {
        if (!(await isOurs($, path))) continue
        await removeDir($, path)
      } catch (err) {
        debug($, `prune: removing ${d.name} failed: ${errText(err)}`)
      }
    }
  } catch (err) {
    debug($, `prune failed: ${errText(err)}`)
  }
}

/**
 * Session-start work for the journal: prunes old session folders (sparing
 * this one and the current timeline's journal folder), then restores this
 * session's snapshot, or the one its journal.json links to, when the state
 * holds nothing yet. With `keepCurrent`, a timeline already in the state is
 * kept and no snapshot is read. Never throws.
 */
export async function restore(
  $: EngineInterface,
  sessionId: string,
  options: { prune?: boolean; keepCurrent?: boolean } = {},
): Promise<void> {
  try {
    if (options.keepCurrent === true && (await hasTimeline($))) return
    if (options.prune !== false) {
      const cur = await readTimeline($)
      await prune($, KEEP_SESSIONS, cur.journal === undefined ? [sessionId] : [sessionId, cur.journal])
    }
    const snap = await loadFollowing($, sessionId)
    if (snap === undefined) return
    await adopt($, snap)
  } catch (err) {
    debug($, `restore failed: ${errText(err)}`)
  }
}

/**
 * session.end with reason `clear`: leaves the `$.store` mark naming the
 * timeline's journal folder, then saves the snapshot there, each only while
 * `remainingMs()` (the exit's shared bound) leaves END_RESERVE_MS for core.
 * An empty timeline leaves no mark. Never throws.
 */
export async function saveForClear(
  $: EngineInterface,
  endingId: string,
  remainingMs: () => number,
): Promise<void> {
  try {
    if (!(await hasTimeline($))) {
      await dropClearMark($)
      return
    }
    const t = await readTimeline($)
    const journal = t.journal ?? endingId
    if (remainingMs() < END_RESERVE_MS) return
    await markClear($, { journal, at: await $.clock.now().catch(() => 0) })
    if (remainingMs() < END_RESERVE_MS) return
    await saveSnapshot($, journal, t.journal === undefined ? { ...t, journal } : t)
  } catch (err) {
    debug($, `saveForClear failed: ${errText(err)}`)
  }
}

/**
 * classic.SessionStart with source `clear`, under the new id `sessionId`.
 * When the state still holds a timeline it is kept. Otherwise a fresh mark
 * (under CLEAR_MARK_MAX_AGE_MS) names the folder whose snapshot is adopted,
 * its `journal` kept as that folder; failing that, the new id's own snapshot
 * is restored as at any start. Either way the new id gets a journal.json link
 * to the timeline's folder. The mark is removed once read. Never throws.
 */
export async function restoreAfterClear($: EngineInterface, sessionId: string): Promise<void> {
  try {
    if (!(await hasTimeline($))) {
      const mark = await takeClearMark($)
      const now = await $.clock.now().catch(() => 0)
      const fresh = mark !== undefined && now > 0 && mark.at > 0 && Math.abs(now - mark.at) <= CLEAR_MARK_MAX_AGE_MS
      if (mark !== undefined && !fresh) debug($, `a /clear mark for ${mark.journal} is stale: not restored`)
      const snap = fresh ? await loadSnapshot($, mark.journal) : undefined
      if (snap !== undefined) await adopt($, { ...snap, journal: mark!.journal })
      else await restore($, sessionId, { prune: false })
    } else {
      await dropClearMark($)
    }
    if (!(await hasTimeline($))) return
    const journal = (await readTimeline($)).journal
    if (journal === undefined || journal === sessionId) return
    const dir = await sessionDir($, sessionId)
    // A folder with its own snapshot needs no link (restore reads that first).
    if (dir === undefined || (await $.fs.exists(`${dir}/timeline.json`))) return
    await writeLink($, sessionId, journal)
  } catch (err) {
    debug($, `restoreAfterClear failed: ${errText(err)}`)
  }
}
