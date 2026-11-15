import type { Hint } from './parts'

const width = (h: Hint): number => ('hotkey' in h ? h.hotkey.length + 2 + h.label.length : h.text.length)

/**
 * The hints that fit a footer of `cols`: it draws from column 2 with 3 columns
 * between them. A narrow pane gives up the engine-key text (`↵ open`) first,
 * then hints from the end, so the armed hotkeys stay as long as they can.
 */
export function fitHints(hints: Hint[], cols: number): Hint[] {
  const kept = hints.slice(0, 3)
  const total = (): number => 2 + kept.reduce((n, h) => n + width(h), 0) + 3 * Math.max(0, kept.length - 1)
  while (kept.length > 1 && total() > cols) {
    const text = kept.findIndex(h => !('hotkey' in h))
    kept.splice(text >= 0 ? text : kept.length - 1, 1)
  }
  return kept
}
