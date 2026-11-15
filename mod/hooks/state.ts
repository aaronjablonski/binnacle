import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Ev, Timeline, UiState } from '../types'
import { empty, reduce } from './model/reduce'
import { boundUi } from './model/usage'

// Change a tag when the value's fields change: a reload then declines what
// the earlier code stored instead of misreading it.
export const timeline = atom({ plugin: 'mission-control', key: 'timeline' } as const, empty, {
  shape: 'timeline-3',
})

export const initialUi: UiState = {
  tab: 'overview', filter: { kind: 'all' }, agentsMode: 'list', folded: [], openTurns: [],
  dismissed: [], query: '', runningOnly: false, notified: [], toasted: [],
}

export const ui = atom({ plugin: 'mission-control', key: 'ui' } as const, initialUi, { shape: 'ui-3' })

/** Folds one event into the timeline. Never throws: a failure goes to the debug log. */
export async function apply($: EngineInterface, ev: Ev): Promise<void> {
  try {
    await update($, timeline, t => reduce(t, ev))
  } catch (err) {
    debug($, `apply ${ev.kind} failed: ${errText(err)}`)
  }
}

// Every read and write of the atoms sits in this file: the engine's scan
// accepts an atom only where it is written as a const of the same file.

/** The timeline as it stands. */
export async function readTimeline($: EngineInterface): Promise<Timeline> {
  return read($, timeline)
}

const isEmpty = (t: Timeline): boolean => JSON.stringify(t) === JSON.stringify(empty)

/** The pane's own state: tab, filter, detail. */
export async function readUi($: EngineInterface): Promise<UiState> {
  return read($, ui)
}

/**
 * Changes the pane's state from a press handler or another event; never from
 * ui.render. What `fn` answers is held to the lists' and query's bounds.
 */
export async function updateUi($: EngineInterface, fn: (u: UiState) => UiState): Promise<void> {
  await update($, ui, u => boundUi(fn(u)))
}

/** True when the state holds a timeline with anything in it. */
export async function hasTimeline($: EngineInterface): Promise<boolean> {
  return !isEmpty(await read($, timeline))
}

/** Sets the timeline's `journal` to `id` unless it has one; answers the one it holds. */
export async function stampJournal($: EngineInterface, id: string): Promise<string> {
  const t = await update($, timeline, cur => (cur.journal !== undefined ? cur : { ...cur, journal: id }))
  return t.journal ?? id
}

/** Takes `snap` as the timeline when the state holds nothing yet; otherwise keeps what is there. */
export async function adopt($: EngineInterface, snap: Timeline): Promise<void> {
  await update($, timeline, cur => (isEmpty(cur) ? snap : cur))
}

// The mark a /clear leaves in `$.store` for the session that follows it: a
// /clear resets `$.state`, so the journal folder of the timeline it ended is
// handed across here. `$.store` is shared by every session of the mod.

const CLEAR_MARK = 'mission-control:cleared'

/** Where the timeline a /clear ended was journalled, and when (ms). */
export type ClearMark = { journal: string; at: number }

/** Leaves the mark for the session after a /clear. Never throws. */
export async function markClear($: EngineInterface, mark: ClearMark): Promise<void> {
  try {
    await $.store.set(CLEAR_MARK, mark)
  } catch (err) {
    debug($, `markClear failed: ${errText(err)}`)
  }
}

/** Reads the mark and removes it, so it is used at most once. Never throws. */
export async function takeClearMark($: EngineInterface): Promise<ClearMark | undefined> {
  let v: unknown
  try {
    v = await $.store.get(CLEAR_MARK)
  } catch {
    return undefined
  }
  if (v === undefined) return undefined
  await dropClearMark($)
  if (typeof v !== 'object' || v === null) return undefined
  const m = v as Record<string, unknown>
  if (typeof m.journal !== 'string' || m.journal === '' || typeof m.at !== 'number') return undefined
  return { journal: m.journal, at: m.at }
}

/** Removes the mark. Never throws. */
export async function dropClearMark($: EngineInterface): Promise<void> {
  try {
    await $.store.delete(CLEAR_MARK)
  } catch {
    // nothing to remove, or no store
  }
}

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** One line to the debug log; never throws. */
export function debug($: EngineInterface, msg: string): void {
  try {
    $.ui.log(`mission-control: ${msg}`, { to: 'debug' })
  } catch {
    // nowhere left to report it
  }
}

/** The pane's state with no step open. */
export function leaveDetail(u: UiState): UiState {
  const { detail: _detail, ...rest } = u
  return rest
}
