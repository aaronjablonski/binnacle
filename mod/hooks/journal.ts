import type { EngineInterface } from 'claude-code'

import type { StepBody, Timeline } from '../types'
import { adopt, debug, errText } from './state'

// The journal on disk: <home>/.claude/mission-control/<session-id>/ holds
// timeline.json (the last snapshot) and steps/<step-id>.json (each step's
// input and result text). `$.fs` does not expand `~`, so the root is built
// from the home variable; with none set, journalling is skipped.

/** Result text kept per step, and the cut applied to each string of an input. */
export const MAX_TEXT = 20000
/** Session folders kept on disk. */
export const KEEP_SESSIONS = 20
const MAX_DEPTH = 8
const SAFE_NAME = /^[A-Za-z0-9_-]+$/

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

export async function writeBody($: EngineInterface, sessionId: string, stepId: string, body: StepBody): Promise<void> {
  try {
    const dir = await sessionDir($, sessionId)
    if (dir === undefined) return
    await $.fs.write(`${dir}/steps/${safe(stepId)}.json`, JSON.stringify(body))
  } catch (err) {
    debug($, `writeBody ${stepId} failed: ${errText(err)}`)
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export async function readBody($: EngineInterface, sessionId: string, stepId: string): Promise<StepBody | undefined> {
  try {
    const dir = await sessionDir($, sessionId)
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

export async function saveSnapshot($: EngineInterface, sessionId: string, t: Timeline): Promise<void> {
  try {
    const dir = await sessionDir($, sessionId)
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

async function mtimeOf($: EngineInterface, path: string): Promise<number> {
  for (const p of [`${path}/timeline.json`, path]) {
    try {
      const s = await $.fs.stat(p)
      if (s.mtimeMs > 0) return s.mtimeMs
    } catch {
      // try the next
    }
  }
  return 0
}

/** Removes one session folder. `$.fs` has no delete, so this runs the platform's own. */
async function removeDir($: EngineInterface, path: string): Promise<void> {
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const argv = isWindows
    ? ['cmd', '/d', '/c', 'rmdir', '/s', '/q', path.replace(/\//g, '\\')]
    : ['rm', '-rf', '--', path]
  const ran = await $.process.run(argv)
  if (ran.exitCode !== 0) debug($, `prune: removing ${path} exited ${ran.exitCode}`)
}

/**
 * Keeps the newest `keep` session folders (by their snapshot's time) and
 * removes the rest. `spare` (the running session's id) is never removed.
 * Only folders whose names are plain ids are touched.
 */
export async function prune($: EngineInterface, keep: number, spare?: string): Promise<void> {
  try {
    const root = await journalRoot($)
    if (root === undefined) return
    if (!(await $.fs.exists(root))) return
    const dirs = (await $.fs.list(root)).filter(d => d.kind === 'dir' && SAFE_NAME.test(d.name))
    if (dirs.length <= keep) return
    const dated: { name: string; at: number }[] = []
    for (const d of dirs) dated.push({ name: d.name, at: await mtimeOf($, `${root}/${d.name}`) })
    dated.sort((a, b) => b.at - a.at)
    const spareName = spare === undefined ? undefined : safe(spare)
    for (const d of dated.slice(Math.max(0, keep))) {
      if (d.name === spareName) continue
      try {
        await removeDir($, `${root}/${d.name}`)
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
 * this one), then restores this session's snapshot when the state holds
 * nothing yet. Never throws.
 */
export async function restore($: EngineInterface, sessionId: string, options: { prune?: boolean } = {}): Promise<void> {
  try {
    if (options.prune !== false) await prune($, KEEP_SESSIONS, sessionId)
    const snap = await loadSnapshot($, sessionId)
    if (snap === undefined) return
    await adopt($, snap)
  } catch (err) {
    debug($, `restore failed: ${errText(err)}`)
  }
}
