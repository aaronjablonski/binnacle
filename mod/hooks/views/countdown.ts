// The idle countdown (plan constraint 5: idle is still). While the session
// waits and the prompt cache is warm, the Now lintel's readout counts down
// once a second. A view that draws that readout registers how to draw its
// lintel at any moment; the clock then blits just that lintel (paint.ts
// `repaint`) instead of redrawing the pane. Ephemeral: a reload starts with
// none, and the next draw registers again.

import type { EngineInterface } from 'claude-code'

import { repaint } from './paint'
import type { InstSpec } from './parts'

type Entry = { site: string; key: string; build: (now: number) => InstSpec }

const entries = new Map<string, Entry>()

/** From a draw: the lintel `key` on `site` shows the countdown, drawn at `now` by `build`. */
export function setCountdown(site: string, key: string, build: (now: number) => InstSpec): void {
  entries.set(`${site}\u0000${key}`, { site, key, build })
}

/** From a draw: the lintel `key` on `site` no longer shows the countdown. */
export function clearCountdown(site: string, key: string): void {
  entries.delete(`${site}\u0000${key}`)
}

/**
 * The clock's countdown beat: blits each registered lintel drawn at `now`.
 * Resolves true when there is at least one and every one is a mounted Raster
 * (so the pane needs no redraw); false when there is none, or one is drawn as
 * text. Never throws.
 */
export async function tickCountdown($: EngineInterface, now: number): Promise<boolean> {
  if (entries.size === 0) return false
  let all = true
  for (const e of entries.values()) {
    try {
      const spec = e.build(now)
      if ((await repaint($, e.site, e.key, spec.sig, spec.frames)) === 'absent') all = false
    } catch {
      all = false
    }
  }
  return all
}

/** Empties the registry: for tests, whose module outlives each test. */
export function resetCountdown(): void {
  entries.clear()
}
