// The paint clock: the one `$.clock.every(1000)` of the mod, and the blits
// of the rich instruments that move on it.
//
// The shell already ran a 1 s clock for its own tick (needs, budget, the
// redraw while something runs). Rather than add a second clock, that clock
// moved here: `startClock($, onTick)` is the only place the mod calls
// `$.clock.every`, and each period runs the shell's tick and then one paint
// pass. The clock itself keeps running for the shell; the paint pass is what
// stops when nothing is live: with no instrument of more than one frame it
// draws, encodes and blits nothing.
//
// While drawing, a view calls `begin(requestId)` once for its site and then
// `track(...)` for each Raster it mounts, getting back the cells to mount for
// this beat. An instrument is a list of frames (a pulsing lamp has two, a
// still ring one) drawn and encoded only when its signature changes. Each
// period moves the beat on and blits a key only when its frame for the new
// beat differs from the cells it last showed.
//
// The registry is this module's: a reload starts it over, and the next draw
// fills it again.

import type { EngineInterface, Timer } from 'claude-code'

import { encode, type Grid } from './raster'

export type Painted = { columns: number; rows: number; cells: string }

type Entry = {
  columns: number
  rows: number
  sig: string
  /** Each frame's encoded cells; the beat picks one. */
  frames: string[]
  /** The cells the surface shows now, as mounted or last blitted. */
  shown: string
  /** The site's draw this entry was last tracked in. */
  draw: number
}

type Site = { draw: number; entries: Map<string, Entry> }

const sites = new Map<string, Site>()
let beat = 0
let timer: Timer | undefined

function siteOf(requestId: string): Site {
  let site = sites.get(requestId)
  if (site === undefined) {
    site = { draw: 0, entries: new Map() }
    sites.set(requestId, site)
  }
  return site
}

/** Starts a new draw of a site: keys it does not track again stop painting. */
export function begin(requestId: string): void {
  siteOf(requestId).draw += 1
}

/**
 * Registers one mounted Raster and returns what to mount: its size and the
 * cells of the current beat. `frames` runs (and its grids are encoded) only
 * when `sig` differs from the last one tracked under this key.
 */
export function track(requestId: string, key: string, sig: string, frames: () => Grid[]): Painted {
  const site = siteOf(requestId)
  let entry = site.entries.get(key)
  if (entry === undefined || entry.sig !== sig) {
    const grids = frames()
    const first = grids[0]
    if (first === undefined) throw new Error(`instrument ${key} has no frames`)
    for (const g of grids) {
      if (g.columns !== first.columns || g.rows !== first.rows) {
        throw new Error(`instrument ${key}: frames of ${first.columns}x${first.rows} and ${g.columns}x${g.rows}`)
      }
    }
    entry = { columns: first.columns, rows: first.rows, sig, frames: grids.map(encode), shown: '', draw: site.draw }
    site.entries.set(key, entry)
  }
  entry.draw = site.draw
  entry.shown = entry.frames[beat % entry.frames.length]!
  return { columns: entry.columns, rows: entry.rows, cells: entry.shown }
}

/** Drops a site whole: its pane closed, or it draws no instruments now. */
export function forget(requestId: string): void {
  sites.delete(requestId)
}

const isMoving = (site: Site, e: Entry) => e.draw === site.draw && e.frames.length > 1

/** Whether any tracked instrument has more than one frame. */
export function isLive(): boolean {
  for (const site of sites.values()) for (const e of site.entries.values()) if (isMoving(site, e)) return true
  return false
}

/**
 * One paint pass: moves the beat on and blits each moving key whose cells
 * for the new beat differ from what it shows. A key the last draw left out
 * is dropped; so is one whose blit is denied or throws (not mounted any
 * more), until a draw tracks it again. Resolves how many blits were taken.
 */
export async function paintTick($: EngineInterface): Promise<number> {
  beat += 1
  const sends: Promise<boolean>[] = []
  for (const [requestId, site] of sites) {
    for (const [key, e] of site.entries) {
      if (e.draw !== site.draw) {
        site.entries.delete(key)
        continue
      }
      if (e.frames.length < 2) continue
      const cells = e.frames[beat % e.frames.length]!
      if (cells === e.shown) continue
      e.shown = cells
      sends.push(
        $.ui
          .blit({ requestId, key, cells, columns: e.columns, rows: e.rows })
          .then(got => {
            if (got.deny === undefined) return true
            if (site.entries.get(key) === e) site.entries.delete(key)
            return false
          })
          .catch((err: unknown) => {
            if (site.entries.get(key) === e) site.entries.delete(key)
            $.ui.log(`mission-control: blit ${key} failed: ${String(err)}`, { to: 'debug' })
            return false
          }),
      )
    }
  }
  const taken = await Promise.all(sends)
  return taken.filter(Boolean).length
}

/**
 * Starts the mod's one 1 s clock (a running one is cancelled first). Each
 * period runs `onTick` (the shell's tick) and then, only while something is
 * live, a paint pass. Never throws.
 */
export function startClock($: EngineInterface, onTick: () => void | Promise<void>): void {
  stopClock()
  timer = $.clock.every(1000, () => {
    void Promise.resolve()
      .then(onTick)
      .catch(() => undefined)
    if (isLive()) void paintTick($).catch(() => 0)
  })
}

/** Stops the clock; `startClock` starts it again. */
export function stopClock(): void {
  timer?.cancel()
  timer = undefined
}

/** Empties the registry and the beat: for tests, whose module outlives each test. */
export function resetPaint(): void {
  sites.clear()
  beat = 0
}
