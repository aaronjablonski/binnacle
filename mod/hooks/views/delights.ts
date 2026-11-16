import type { EngineInterface } from 'claude-code'

import type { Timeline, TurnRow, UiState } from '../../types'
import { needs } from '../model/alerts'
import { todoBlock } from '../model/todo'
import { debug, errText, readTimeline, readUi, updateUi } from '../state'
import type { ViewCtx } from './shell'

// The delights (R36): the clean-run sweep and the round-number toasts. All of
// it runs from the 1 s clock's tick, never from a render: a draw only reads
// `sweepFrame`. Nothing here is loud: one pass of the accent along the Now
// header's rule, and a toast only when the number means something.

/** A finished request is swept and toasted only while this fresh, so a restore replays nothing. */
const FRESH_MS = 15_000

/** The sweep: this many frames, this far apart (5 x 160 ms = 800 ms, under a second), then it clears and stops. */
export const SWEEP_FRAMES = 5
export const SWEEP_STEP_MS = 160
/** The highlight's width in cells. */
export const SWEEP_WIDTH = 6

/**
 * The frame of the running sweep (0 to SWEEP_FRAMES - 1), or undefined when
 * none runs. Ephemeral UI state like the pane's ring: a reload starts it
 * over, and it is cleared by its own bounded timers.
 */
let frame: number | undefined
let timer: { cancel: () => void } | undefined

export function sweepFrame(): number | undefined {
  return frame
}

/** Stops a running sweep at once (a test, or a reload). */
export function resetSweep(): void {
  timer?.cancel()
  timer = undefined
  frame = undefined
}

/**
 * Starts one pass: frame 0 now, one more every SWEEP_STEP_MS, then undefined.
 * A bounded chain of `clock.after` calls (SWEEP_FRAMES + 1 of them at most);
 * each step redraws the pane. Starting again cancels the first.
 */
export function startSweep($: EngineInterface): void {
  resetSweep()
  let i = 0
  const step = (): void => {
    frame = i < SWEEP_FRAMES ? i : undefined
    $.ui.invalidate('ui.render')
    if (i >= SWEEP_FRAMES) {
      timer = undefined
      return
    }
    i++
    timer = $.clock.after(SWEEP_STEP_MS, step)
  }
  step()
}

/**
 * The cells the sweep lights on a lintel `width` wide at `frameNo`: a
 * SWEEP_WIDTH window that moves from the clamp's end (column 3) to the right
 * edge. `[from, to)`; empty when none.
 */
export function sweepCells(frameNo: number | undefined, width: number): [number, number] {
  if (frameNo === undefined || width <= 3) return [0, 0]
  const room = Math.max(0, width - 3 - SWEEP_WIDTH)
  const from = 3 + Math.round((frameNo * room) / Math.max(1, SWEEP_FRAMES - 1))
  return [from, Math.min(width, from + SWEEP_WIDTH)]
}

/** The pane's own site: the band draws under another and never sweeps. */
const PANE_SITE = 'binnacle'

/**
 * Whether a draw lights the sweep: the pane (not the band), the `motion`
 * option on, a sweep running, and Needs you empty.
 */
export function sweepShows(ctx: ViewCtx): boolean {
  if (frame === undefined || ctx.motion !== true) return false
  if ((ctx.site ?? PANE_SITE) !== PANE_SITE) return false
  return needs(ctx.t, ctx.now, { covered: ctx.isPromptCovered === true }).items.length === 0
}

/** The newest main turn. */
function mainTurn(t: Timeline): TurnRow | undefined {
  for (let i = t.turns.length - 1; i >= 0; i--) if (t.turns[i]!.agent === 'main') return t.turns[i]
  return undefined
}

/**
 * The request that just finished cleanly, or undefined: its newest main turn
 * ended within FRESH_MS without error or interruption, and the lead's list is
 * all done (or there is none).
 */
export function cleanFinish(t: Timeline, now: number): TurnRow | undefined {
  const turn = mainTurn(t)
  if (turn === undefined || turn.endedAt === undefined || turn.failed === true || turn.aborted === true) return undefined
  if (now - turn.endedAt > FRESH_MS) return undefined
  return todoBlock(t).open === 0 ? turn : undefined
}

/** The marker that this request was swept. */
export const sweptMark = (turnId: string): string => `swept:${turnId}`
/** The marker that this request's to-do round number was toasted. */
export const todosMark = (turnId: string): string => `todos-done:${turnId}`

/**
 * The clock's call. Once per finished request, with the pane open, the
 * `motion` option on and Needs you empty, it marks the request in
 * `ui.toasted` (bounded) before starting the sweep. Once per request whose
 * list of two or more to-dos has just all been done, it toasts that. Never
 * throws.
 */
export async function delightsTick($: EngineInterface, o: { motion: boolean }): Promise<void> {
  try {
    const t = await readTimeline($)
    const u: UiState = await readUi($)
    const now = await $.clock.now()
    const turn = mainTurn(t)
    if (turn === undefined) return
    const quiet = needs(t, now).items.length === 0
    const marks: string[] = []
    let sweep = false
    let toast: string | undefined
    const done = cleanFinish(t, now)
    if (o.motion && quiet && u.paneOpen === true && u.strip !== true && done !== undefined && !u.toasted.includes(sweptMark(done.id))) {
      marks.push(sweptMark(done.id))
      sweep = true
    }
    // All the list done, with something to celebrate: two or more tasks, the last one finished a moment ago.
    const block = todoBlock(t)
    if (block.total >= 2 && block.open === 0 && block.lastDone !== undefined && now - block.lastDone.updatedAt <= FRESH_MS && !u.toasted.includes(todosMark(turn.id))) {
      marks.push(todosMark(turn.id))
      toast = `All ${block.total} done`
    }
    if (marks.length === 0) return
    await updateUi($, cur => ({ ...cur, toasted: [...cur.toasted, ...marks.filter(m => !cur.toasted.includes(m))] }))
    if (toast !== undefined) $.ui.toast(toast)
    if (sweep) startSweep($)
  } catch (err) {
    debug($, `delights tick failed: ${errText(err)}`)
  }
}
