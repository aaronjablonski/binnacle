import type { EngineInterface, Timer } from 'claude-code'

// Which tool rows the transcript shows now, per surface, as each row's
// `ToolUse` render reports it in `onScreen`. Ephemeral UI, not session state:
// a render hook may not write `$.state`, and a reload starting it empty only
// loses the marks until the rows are drawn again.

export const MAX_SHOWN = 500

// The pane redraws once per burst of changes, after this long.
const REDRAW_MS = 250
// Changes seen while a redraw waits, after which the wait is taken for lost (a
// refused `clock.after` never calls back) and a new one is asked.
const STALE_CHANGES = 20

// Insertion order is age: the first key is the oldest.
const shown = new Set<string>()
let pending: Timer | undefined
let changesWhilePending = 0

const keyOf = (surface: string, id: string): string => `${surface}\n${id}`

/** Whether the row of tool call `id` is in the transcript's viewport on `surface`. */
export function isOnScreen(surface: string, id: string): boolean {
  return shown.has(keyOf(surface, id))
}

/** How many rows are marked, across surfaces. */
export function shownCount(): number {
  return shown.size
}

function redrawSoon($: EngineInterface): void {
  if (pending !== undefined) {
    changesWhilePending += 1
    if (changesWhilePending < STALE_CHANGES) return
    pending.cancel()
    pending = undefined
  }
  changesWhilePending = 0
  try {
    pending = $.clock.after(REDRAW_MS, () => {
      pending = undefined
      changesWhilePending = 0
      try {
        $.ui.invalidate('ui.render')
      } catch {
        // No redraw this time; the next change asks again.
      }
    })
  } catch {
    pending = undefined
  }
}

/**
 * Notes a tool row's `onScreen` from its `ToolUse` render input. O(1); never
 * throws; writes no state. A redraw is asked only when the set changed.
 */
export function observeRow($: EngineInterface, e: unknown): void {
  try {
    const input = e as { surface?: unknown; requestId?: unknown; props?: { tool_use_id?: unknown; onScreen?: unknown } }
    const props = input.props
    if (props === undefined || props === null) return
    const onScreen = props.onScreen
    // Absent where the surface does not say: leave the mark as it was.
    if (onScreen === undefined) return
    const id = typeof input.requestId === 'string' && input.requestId !== '' ? input.requestId : props.tool_use_id
    if (typeof id !== 'string' || id === '' || typeof input.surface !== 'string') return
    const key = keyOf(input.surface, id)
    const isShown = typeof onScreen === 'object' && onScreen !== null
    if (isShown === shown.has(key)) return
    if (isShown) {
      shown.add(key)
      if (shown.size > MAX_SHOWN) {
        const oldest = shown.values().next().value
        if (oldest !== undefined) shown.delete(oldest)
      }
    } else {
      shown.delete(key)
    }
    redrawSoon($)
  } catch {
    // An observer never breaks a row.
  }
}
