// The paint clock: the one `$.clock.every(1000)` of the mod, and the blits
// of the rich instruments that move on it.
//
// The shell already ran a 1 s clock for its own tick (needs, budget, the
// redraw while something runs). Rather than add a second clock, that clock
// moved here: `startClock($, onTick)` is the only place the mod calls
// `$.clock.every`, and each period runs the shell's tick and then one paint
// pass. The clock stops when nothing is live (M10): the tick says nothing
// runs, nothing is fresh and the cache is cold, and no instrument of more
// than one frame is drawn. A capture hook's write to the Timeline starts it
// again (shell.tsx `wakeClock`, called from capture.ts).
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
  /** What the instrument showed, in the view's words (a critter's state, a count): a change of it may start a burst. */
  tag?: string
  /** The one-shot burst running now, if any: the beat leaves the key alone until it ends. */
  burst?: BurstRun
}

/**
 * A one-shot burst (motion sketches 1 to 6, 8, 9): in-between frames shown
 * once, frame `i` for `ms[i]`, then the instrument's own frame for the beat.
 * The first frame is mounted with the draw that starts it; each later one is
 * a blit on a bounded chain of `$.clock.after` (no standing clock), and a fold
 * (`end: 'redraw'`) asks one redraw after the last.
 */
export type Burst = {
  /** The in-between frames, each the instrument's size. */
  frames: () => Grid[]
  /** How long each frame shows, in ms: as many as the frames. */
  ms: readonly number[]
  /** After the last frame, one redraw too (the finished card folds). */
  end?: 'redraw'
  /**
   * For a burst with no tag before it (a card that just appeared): it plays
   * at most once under this name per site and key, so drawing the key again
   * (a tab switched back) never replays it.
   */
  once?: string
}

/** Picks a burst from the tag the key showed before (undefined when the key is new) and the draw's time; undefined for none. */
export type BurstOf = (prev: string | undefined, now: number) => Burst | undefined

type BurstRun = { cells: string[]; ms: readonly number[]; i: number; end?: 'redraw'; timer?: Timer }

/** The `once` names already played (bounded, oldest first). */
const played = new Set<string>()
const MAX_PLAYED = 400

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
  const entry = tracked(site, key, sig, frames)
  entry.shown = entry.frames[beat % entry.frames.length]!
  return { columns: entry.columns, rows: entry.rows, cells: entry.shown }
}

/** The key's entry for this draw, its frames encoded again when `sig` changed. A running burst stops when the sig changes. */
function tracked(site: Site, key: string, sig: string, frames: () => Grid[]): Entry {
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
    const next: Entry = { columns: first.columns, rows: first.rows, sig, frames: grids.map(encode), shown: '', draw: site.draw }
    if (entry?.tag !== undefined) next.tag = entry.tag
    entry?.burst?.timer?.cancel()
    entry = next
    site.entries.set(key, entry)
  }
  entry.draw = site.draw
  return entry
}

/**
 * `track` for an instrument that may play a one-shot burst. `tag` says what
 * it shows in the view's words; when it differs from the tag the key last
 * showed (or the key is new), `burstOf(previous tag, now)` may pick a burst.
 * The burst's first frame is what this draw mounts, and its chain blits the
 * rest. A draw while a burst runs (same sig) mounts the burst's current frame;
 * a new sig stops it. Never throws for the burst: a burst whose frames are
 * not the instrument's size is not played.
 */
export function trackBurst($: EngineInterface, requestId: string, key: string, sig: string, frames: () => Grid[], tag: string, burstOf: BurstOf | undefined, now: number): Painted {
  const site = siteOf(requestId)
  const before = site.entries.get(key)
  const prev = before?.tag
  const entry = tracked(site, key, sig, frames)
  const out = (cells: string): Painted => {
    entry.shown = cells
    return { columns: entry.columns, rows: entry.rows, cells }
  }
  if (entry.burst !== undefined) return out(entry.burst.cells[entry.burst.i]!)
  const changed = prev !== tag
  entry.tag = tag
  if (!changed || burstOf === undefined) return out(entry.frames[beat % entry.frames.length]!)
  let b: Burst | undefined
  let cells: string[] = []
  try {
    b = burstOf(prev, now)
    if (b !== undefined) {
      const once = b.once !== undefined ? `${requestId}\n${key}\n${b.once}` : undefined
      if (once !== undefined && played.has(once)) b = undefined
      else {
        const grids = b.frames()
        if (grids.length === 0 || grids.length !== b.ms.length || grids.some(g => g.columns !== entry.columns || g.rows !== entry.rows)) b = undefined
        else {
          cells = grids.map(encode)
          if (once !== undefined) {
            played.add(once)
            while (played.size > MAX_PLAYED) played.delete(played.values().next().value!)
          }
        }
      }
    }
  } catch (err) {
    b = undefined
    $.ui.log(`binnacle: burst ${key} failed: ${String(err)}`, { to: 'debug' })
  }
  if (b === undefined) return out(entry.frames[beat % entry.frames.length]!)
  const run: BurstRun = { cells, ms: b.ms, i: 0, ...(b.end !== undefined ? { end: b.end } : {}) }
  entry.burst = run
  stepBurst($, requestId, key, entry, run)
  return out(cells[0]!)
}

/** Asks one redraw; never throws. */
function redraw($: EngineInterface): void {
  try {
    $.ui.invalidate('ui.render')
  } catch (err) {
    $.ui.log(`binnacle: redraw failed: ${String(err)}`, { to: 'debug' })
  }
}

/**
 * The burst's chain: after frame `i`'s time, the next frame is blitted (or,
 * after the last, the instrument's own frame for the beat), and the next step
 * asked. A blit denied (the key is not mounted any more) ends the burst and
 * asks one redraw, so the end state is drawn. Bounded: one `clock.after` a frame.
 */
function stepBurst($: EngineInterface, requestId: string, key: string, e: Entry, run: BurstRun): void {
  try {
    run.timer = $.clock.after(run.ms[run.i] ?? 0, () => {
      if (e.burst !== run) return
      run.i += 1
      const last = run.i >= run.cells.length
      if (last) e.burst = undefined
      const cells = last ? e.frames[beat % e.frames.length]! : run.cells[run.i]!
      const site = sites.get(requestId)
      const finish = (): void => {
        if (!last) stepBurst($, requestId, key, e, run)
        else if (run.end === 'redraw') redraw($)
      }
      if (site === undefined || site.entries.get(key) !== e) {
        e.burst = undefined
        if (run.end === 'redraw') redraw($)
        return
      }
      if (cells === e.shown) return finish()
      e.shown = cells
      void $.ui
        .blit({ requestId, key, cells, columns: e.columns, rows: e.rows })
        .then(got => {
          if (got.deny === undefined) return finish()
          if (e.burst === run) e.burst = undefined
          redraw($)
        })
        .catch((err: unknown) => {
          if (e.burst === run) e.burst = undefined
          $.ui.log(`binnacle: burst blit ${key} failed: ${String(err)}`, { to: 'debug' })
          redraw($)
        })
    })
  } catch (err) {
    // A refused timer never calls back: end the burst now, on the end state at the next draw.
    e.burst = undefined
    $.ui.log(`binnacle: burst ${key} timer failed: ${String(err)}`, { to: 'debug' })
    redraw($)
  }
}

/** How many draws a site has had since it was opened (or forgotten): 1 on the first draw of an opened pane. */
export function siteDraws(requestId: string): number {
  return sites.get(requestId)?.draw ?? 0
}

/** Whether a burst runs now under this site and key (a view holds a finishing card while it does). */
export function bursting(requestId: string, key: string): boolean {
  return sites.get(requestId)?.entries.get(key)?.burst !== undefined
}

/** The tag a key showed at its last draw, or undefined (a view asks whether a card was drawn working). */
export function tagOf(requestId: string, key: string): string | undefined {
  return sites.get(requestId)?.entries.get(key)?.tag
}

/** Drops a site whole: its pane closed, or it draws no instruments now. */
export function forget(requestId: string): void {
  for (const e of sites.get(requestId)?.entries.values() ?? []) e.burst?.timer?.cancel()
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
      if (e.frames.length < 2 || e.burst !== undefined) continue
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
            $.ui.log(`binnacle: blit ${key} failed: ${String(err)}`, { to: 'debug' })
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
 * live, a paint pass. When `onTick` resolves `false` (nothing runs, nothing
 * is fresh) and no instrument moves, the clock stops until the shell's
 * `wakeClock` starts it again.
 * Never throws.
 */
export function startClock($: EngineInterface, onTick: () => boolean | void | Promise<boolean | void>): void {
  stopClock()
  const mine = $.clock.every(1000, () => {
    void Promise.resolve()
      .then(onTick)
      .then(busy => {
        if (busy === false && !isLive() && timer === mine) stopClock()
      })
      .catch(() => undefined)
    if (isLive()) void paintTick($).catch(() => 0)
  })
  timer = mine
}

/** Whether the 1 s clock runs now (tests). */
export function clockRunning(): boolean {
  return timer !== undefined
}

/**
 * Draws one tracked key again outside a draw (the idle countdown in the Now
 * lintel): when the site's last draw mounted it as a Raster, its frames are
 * replaced if `sig` changed and the new cells blitted. Resolves `blit` when a
 * blit was taken, `same` when nothing changed, and `absent` when the last draw
 * did not mount the key as a Raster (the text form), or the blit was denied.
 * Never throws.
 */
export async function repaint($: EngineInterface, requestId: string, key: string, sig: string, frames: () => Grid[]): Promise<'blit' | 'same' | 'absent'> {
  const site = sites.get(requestId)
  const e = site?.entries.get(key)
  if (site === undefined || e === undefined || e.draw !== site.draw) return 'absent'
  if (e.sig === sig) return 'same'
  try {
    const grids = frames()
    const first = grids[0]
    if (first === undefined || first.columns !== e.columns || first.rows !== e.rows) return 'absent'
    e.sig = sig
    e.frames = grids.map(encode)
    const cells = e.frames[beat % e.frames.length]!
    if (cells === e.shown) return 'same'
    e.shown = cells
    const got = await $.ui.blit({ requestId, key, cells, columns: e.columns, rows: e.rows })
    if (got.deny === undefined) return 'blit'
  } catch (err) {
    $.ui.log(`binnacle: repaint ${key} failed: ${String(err)}`, { to: 'debug' })
  }
  if (site.entries.get(key) === e) site.entries.delete(key)
  return 'absent'
}

/** Stops the clock; `startClock` starts it again. */
export function stopClock(): void {
  const t = timer
  timer = undefined
  t?.cancel()
}

/** Empties the registry and the beat: for tests, whose module outlives each test. */
export function resetPaint(): void {
  for (const site of sites.values()) for (const e of site.entries.values()) e.burst?.timer?.cancel()
  sites.clear()
  played.clear()
  cues.clear()
  cued.clear()
  beat = 0
}

// ---------- cues: a text look held for a short time (motion sketches 1, 4) ----------

/** The cues running now, by name: when each ends. */
const cues = new Map<string, number>()
/** The names that have had their cue (bounded, oldest first), so a cue never plays twice. */
const cued = new Set<string>()

/**
 * Starts a timed cue once per name: it is on from now for `ms`, then one
 * redraw draws it off. A draw asks `cueOn` and draws the cue while it is on.
 * The redraw is the only cost (no blit can change text). Resolves nothing;
 * never throws.
 */
export function cue($: EngineInterface, name: string, now: number, ms: number): void {
  if (cued.has(name)) return
  cued.add(name)
  while (cued.size > MAX_PLAYED) cued.delete(cued.values().next().value!)
  cues.set(name, now + ms)
  try {
    $.clock.after(ms, () => {
      cues.delete(name)
      redraw($)
    })
  } catch (err) {
    cues.delete(name)
    $.ui.log(`binnacle: cue ${name} failed: ${String(err)}`, { to: 'debug' })
  }
}

/** Whether a cue is on now. */
export function cueOn(name: string): boolean {
  return cues.has(name)
}

/** Whether a cue under this name has started (on or over). */
export function cueStarted(name: string): boolean {
  return cued.has(name)
}
