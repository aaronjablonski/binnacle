// What the band says, read once from the Timeline (cockpit spec "CockpitBand",
// rulings R1 to R5, R8, R9, R25, R29). Pure: the terminal band (band.tsx) and
// the desktop Svg (svg.ts) draw the same model, so they say the same words.
//
// One critter (R25): the lead, or the asker while an ask is up. Amber only
// while a dialog is up (R9); Watch adds a dim count and nothing else. The
// band has no `isPromptCovered`: it reads what the pane saw (`covered`,
// `watching`). With no pane watching nothing can see a permission answered,
// so it is amber only for its first NOTIFY_ASK_MS, then a dim "asked to run
// a command · running"; an auto-mode one is "Checking a permission" for
// ASK_MS, then the same (C-1, I-1, R2 amendment). No Button, no blink, no
// clamp, no pill.

import type { Timeline, TurnRow, UiState } from '../../types'
import { askedVerb, CHECKING_TEXT, headerState, needs, watch } from '../model/alerts'
import type { Need } from '../model/alerts'
import type { RunLimits } from '../model/meter'
import { cacheLine, thisTurn } from '../model/meter'
import { summary } from '../model/select'
import { todoBlock } from '../model/todo'
import { span, toolName, warmWords, wordFit } from './fit'
import { crewRole } from './style'
import type { PodState } from './style'
import type { CritterRole } from './raster'

/** Which band: two rows or one working, asked, stopped (R8), or one dim idle line. */
export type BandForm = 'working' | 'asked' | 'stopped' | 'idle'

/** The first ask, in the words the band uses. */
export type BandAsk = {
  /** The asker's name ("Builder"), or "An agent" when two steps share the call (R4). */
  who: string
  /** "Builder asks to run a command" (R1). */
  sentence: string
  /** What is asked for, short: the tool ("Bash"), or "question", "plan"; an MCP server for an input request. */
  tool: string
  /** The command, file or question on one line; '' when it has none. */
  command: string
  /** Asks beyond the first. */
  more: number
  since: number
}

export type BandModel = {
  form: BandForm
  /** True while the session has nothing to say yet (no steps, no list, no focus): the band draws no row unless the strip asks for it. */
  nothing: boolean
  /** The one critter (R25): the lead, or the asker while an ask is up. */
  critter: { role: CritterRole; state: PodState; id: string }
  /** The row-1 lead-in: "Working on", "Needs you", "Stopped". */
  kicker: string
  /** The request's goal (working); the reason (stopped); the ask's words are in `ask`. */
  focus: string
  ask?: BandAsk
  /** The lead's list (R11): done, total and tasks in progress. */
  done: number
  total: number
  current: number
  /** Subagents running and not waiting; agents with an ask up. */
  working: number
  waiting: number
  /** Watch rows standing (dim, never coloured). */
  watch: number
  /** An auto-mode permission is still being checked (R2, F I1): the band says so, as the pane does, and never "nothing needs you". */
  checking: boolean
  /** With no pane watching, the oldest permission past its first minute, in the past tense and dim: "asked to run a command" (I-1). */
  asked?: string
  context?: number
  week?: number
  /** Idle line: the head ("All 14 done", "Finished"), whether it takes the tick, and the facts after it. */
  rest?: { head: string; tick: boolean; facts: string[] }
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** The words the headline falls back to when the request names no goal and no task (I3). */
export const IDLE_HEADLINE = 'Idle. Nothing running yet.'

/**
 * The headline of Now and of slim (R14, I3): it belongs to the current
 * request. Claude's focus while it was sent during the newest main turn
 * (`isPast` once that turn has ended: between requests the last request's
 * goal stands, for the views to dim); else the lead's current task; else,
 * while the request runs, its prompt (first sentence, cut at a word); else
 * the idle words. Never a step's label, and never a focus an earlier request set.
 */
export function headline(t: Timeline): { text: string; isIdle: boolean; at?: number; isPast?: true } {
  let lead: TurnRow | undefined
  for (const x of t.turns) if (x.agent === 'main' && (lead === undefined || x.startedAt >= lead.startedAt)) lead = x
  const past = lead !== undefined && lead.endedAt !== undefined ? { isPast: true as const } : {}
  const focus = oneLine(t.now?.focus ?? '')
  if (t.now !== undefined && focus !== '' && (lead === undefined || t.now.at >= lead.startedAt)) return { text: focus, isIdle: false, at: t.now.at, ...past }
  const current = todoBlock(t).current
  if (current !== undefined) return { text: oneLine(current.activeForm ?? current.subject), isIdle: false, ...past }
  // A request running with no goal and no task yet: its own prompt, never the idle words under WORKING.
  if (lead !== undefined && lead.endedAt === undefined) {
    const said = promptHeadline(lead.prompt)
    if (said !== '') return { text: said, isIdle: false }
  }
  return { text: IDLE_HEADLINE, isIdle: true }
}

/** The most a prompt headline holds before it is cut at a word. */
const PROMPT_HEADLINE_MAX = 80

/** A prompt as a headline: its first sentence, cut at a word to PROMPT_HEADLINE_MAX. */
export function promptHeadline(prompt: string): string {
  const text = oneLine(prompt)
  const end = /[.!?](\s|$)/.exec(text)
  const first = end !== null ? text.slice(0, end.index + 1) : text
  return wordFit(first, PROMPT_HEADLINE_MAX)
}

/** The request's goal: Now's headline (R14, M15), '' while idle. */
function goalOf(t: Timeline): string {
  const h = headline(t)
  return h.isIdle ? '' : oneLine(h.text)
}

/** What an ask is for, in a word: the tool, a question, a plan, the server's name. */
export function askWord(n: Need): string {
  if (n.kind === 'question') return 'question'
  if (n.kind === 'plan') return 'plan'
  if (n.kind === 'input') return n.asker
  return n.tool !== undefined ? toolName(n.tool, 12) : n.asker
}

function askOf(items: Need[]): BandAsk {
  const n = items[0]!
  return {
    who: n.who,
    sentence: n.sentence,
    tool: askWord(n),
    command: n.kind === 'input' ? oneLine(n.message ?? '') : oneLine(n.command ?? ''),
    more: items.length - 1,
    since: n.since,
  }
}

/** `n file changed` / `n files changed`. */
const files = (n: number): string => `${n} ${n === 1 ? 'file' : 'files'} changed`

/**
 * The band's model. `limits` are the run limits in force (Watch's count);
 * absent, the defaults. `covered` is the pane's observed cover (`paneCovered`): a dialog holds the
 * prompt, so an ask shows at once as the pane shows it, not as "Checking a permission". `watching`
 * is whether the pane watches the prompt at all (`paneWatching`; true when covered): without it a
 * permission is amber only for its first NOTIFY_ASK_MS (`needs`' `watching: false`).
 */
export function bandModel(t: Timeline, u: Pick<UiState, 'dismissed'>, now: number, limits?: RunLimits, covered = false, watching = covered): BandModel {
  const view = needs(t, now, { covered, watching: watching || covered })
  const hs = headerState(t, now, view)
  const todo = todoBlock(t, view.items.map(n => n.agent))
  const s = summary(t)
  const form: BandForm = hs.state === 'waiting' ? 'asked' : hs.state === 'working' ? 'working' : hs.state === 'stopped' ? 'stopped' : 'idle'

  const subs = Object.values(t.agents).filter(a => a.id !== 'main' && a.status === 'running')
  const askers = new Set(view.items.map(n => n.agent))
  const waiting = askers.size
  const working = subs.filter(a => !askers.has(a.id)).length

  // R25: the asker while an ask is up, else the lead.
  let critter: BandModel['critter'] = { role: 'lead', state: form === 'working' ? 'working' : form === 'stopped' ? 'failed' : 'done', id: 'main' }
  if (form === 'asked') {
    const first = view.items[0]!
    const a = t.agents[first.agent]
    critter = {
      role: a === undefined || first.agent === 'main' ? 'lead' : crewRole(a.id, a.type),
      state: 'waiting',
      id: first.agent,
    }
  }

  const win = (name: string): number | undefined => t.budget?.windows.find(w => w.name === name)?.pct
  const model: BandModel = {
    form,
    nothing: form === 'idle' && todo.empty && s.focus === undefined && t.steps.length === 0,
    critter,
    kicker: form === 'asked' ? 'Needs you' : form === 'stopped' ? 'Stopped' : 'Working on',
    focus: form === 'stopped' ? (hs.reason ?? 'An error ended the turn') : goalOf(t),
    done: todo.done,
    total: todo.total,
    current: todo.items.filter(x => x.status === 'in_progress').length,
    working,
    waiting,
    watch: watch(t, now, u.dismissed, limits).length,
    checking: view.checking,
  }
  const asked = view.asked?.[0]
  if (asked !== undefined && form !== 'asked') model.asked = askedVerb(asked)
  if (form === 'asked') model.ask = askOf(view.items)
  if (t.budget?.contextPct !== undefined) model.context = Math.max(0, Math.min(999, Math.round(t.budget.contextPct)))
  const week = win('seven_day')
  if (week !== undefined) model.week = Math.max(0, Math.min(999, Math.round(week)))

  if (form === 'idle') {
    const turn = thisTurn(t)
    const facts: string[] = []
    if (turn?.ms !== undefined && turn.ms >= 1000) facts.push(span(turn.ms))
    if (turn !== undefined && turn.files > 0) facts.push(files(turn.files))
    const warm = cacheLine(t).warmUntil
    if (warm !== undefined && warm > now) facts.push(`cache warm ${warmWords(warm - now)}`)
    const allDone = hs.state === 'all-done'
    model.rest = {
      head: allDone ? `All ${todo.total} done` : hs.state === 'idle-open' ? `Stopped with ${hs.open} to do open` : turn?.turn.endedAt !== undefined ? 'Finished' : 'Ready',
      tick: allDone,
      facts,
    }
  }
  return model
}

/** How many agents the model's second row names: "2 agents working". */
export function agentsWords(m: Pick<BandModel, 'working'>): string {
  return `${m.working} ${m.working === 1 ? 'agent' : 'agents'} working`
}

/**
 * The band's word on needs while nothing is asked: "Checking a permission"
 * while an auto-mode ask is settled (F I1: the pane says the same), else a
 * permission nothing can see answered, dim ("asked to run a command ·
 * running", I-1), else the Watch count, else "nothing needs you".
 */
export function needsPiece(m: Pick<BandModel, 'watch' | 'checking'> & Partial<Pick<BandModel, 'asked'>>): string {
  if (m.checking) return CHECKING_TEXT
  if (m.asked !== undefined) return `${m.asked} · running`
  return m.watch > 0 ? `${m.watch} to watch` : 'nothing needs you'
}

/** The model in words, for the Svg's alt. */
export function bandWords(m: BandModel): string {
  if (m.form === 'asked' && m.ask !== undefined) {
    return `Needs you: ${m.ask.sentence}${m.ask.command !== '' ? `, ${m.ask.tool} ${m.ask.command}` : `, ${m.ask.tool}`}. Answer below.`
  }
  if (m.form === 'stopped') return `Stopped: ${m.focus}.${m.total > 0 ? ` ${m.done} of ${m.total} done.` : ''}`
  if (m.form === 'idle' && m.rest !== undefined) return `${m.rest.head}${m.rest.facts.length > 0 ? `. ${m.rest.facts.join(', ')}` : ''}.`
  const parts = [`Working on ${m.focus}.`]
  if (m.total > 0) parts.push(`${m.done} of ${m.total} done.`)
  if (m.working > 0) parts.push(`${agentsWords(m)}.`)
  const piece = needsPiece(m)
  parts.push(`${piece.charAt(0).toUpperCase()}${piece.slice(1)}.`)
  if (m.context !== undefined) parts.push(`Context ${m.context}%.`)
  if (m.week !== undefined) parts.push(`Week ${m.week}%.`)
  return parts.join(' ')
}
