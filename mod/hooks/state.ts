import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Ev, Timeline, UiState } from '../types'
import { empty, reduce } from './model/reduce'

// Change a tag when the value's fields change: a reload then declines what
// the earlier code stored instead of misreading it.
export const timeline = atom({ plugin: 'mission-control', key: 'timeline' } as const, empty, {
  shape: 'timeline-1',
})

const initialUi: UiState = { tab: 'overview', filter: { kind: 'all' }, agentsMode: 'list', folded: [] }

export const ui = atom({ plugin: 'mission-control', key: 'ui' } as const, initialUi, { shape: 'ui-1' })

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

/** Takes `snap` as the timeline when the state holds nothing yet; otherwise keeps what is there. */
export async function adopt($: EngineInterface, snap: Timeline): Promise<void> {
  await update($, timeline, cur => (isEmpty(cur) ? snap : cur))
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
