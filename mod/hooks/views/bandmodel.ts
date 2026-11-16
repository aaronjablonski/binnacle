// What the band says, read once from the Timeline (cockpit spec "CockpitBand",
// rulings R1 to R5, R8, R9, R25, R29). Pure: the terminal band (band.tsx) and
// the desktop Svg (svg.ts) draw the same model, so they say the same words.
//
// One critter (R25): the lead, or the asker while an ask is up. Amber only
// while a dialog is up (R9); Watch adds a dim count and nothing else (R2 on
// the alert model: the band has no `isPromptCovered`, so an ask in auto mode
// shows after its 20 s). No Button, no blink, no clamp, no pill.

import type { Timeline, UiState } from '../../types'
import { CHECKING_TEXT, headerState, needs, watch } from '../model/alerts'
import type { Need } from '../model/alerts'
import type { RunLimits } from '../model/meter'
import { cacheLine, thisTurn } from '../model/meter'
import { summary } from '../model/select'
import { todoBlock } from '../model/todo'
import { shortPaths, span, toolName, warmWords } from './fit'
import { crewRole } from './style'
import type { PodState, Role } from './style'

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
  critter: { role: Role; state: PodState; id: string }
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
  context?: number
  week?: number
  /** Idle line: the head ("All 14 done", "Finished"), whether it takes the tick, and the facts after it. */
  rest?: { head: string; tick: boolean; facts: string[] }
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** The request's goal: Claude's focus, else the task, else the step in flight or the newest (as Now's headline). */
function goalOf(t: Timeline): string {
  const s = summary(t)
  if (s.focus !== undefined) return oneLine(s.focus)
  const bySeq = [...t.steps].sort((a, b) => b.seq - a.seq)
  const step = bySeq.find(x => x.status === 'running') ?? bySeq[0]
  return step !== undefined ? shortPaths(oneLine(step.label)) : ''
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
 * absent, the defaults.
 */
export function bandModel(t: Timeline, u: Pick<UiState, 'dismissed'>, now: number, limits?: RunLimits): BandModel {
  const view = needs(t, now)
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
 * while an auto-mode ask is settled (F I1: the pane says the same), else the
 * Watch count, else "nothing needs you".
 */
export function needsPiece(m: Pick<BandModel, 'watch' | 'checking'>): string {
  if (m.checking) return CHECKING_TEXT
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
