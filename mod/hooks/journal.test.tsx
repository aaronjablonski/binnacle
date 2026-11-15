import { expect, mock, test } from 'claude-code/testing'
import type { EngineInterface, On } from 'claude-code'

import type { Timeline } from '../types'
import { MAX_TEXT, MIN_PRUNE_AGE_MS, bodyOf, loadSnapshot, prune, readBody, saveSnapshot, writeBody } from './journal'
import { empty } from './model/reduce'

const HOME = 'C:/home'
const ROOT = `${HOME}/.claude/mission-control`
const DAY = 24 * 60 * 60 * 1000
/** The clock prune reads: well past every mtime the tests' disks give, unless a test says otherwise. */
const NOW = 10 * DAY

type File = { text: string; mtimeMs: number }

const norm = (p: string): string => p.replace(/\\/g, '/')

// An in-memory disk: files in a map (folders implied by their paths), and
// the removals the platform's own command was asked for.
class Disk {
  files = new Map<string, File>()
  removed: string[] = []
  private clock = 1

  under(dir: string): string[] {
    return [...this.files.keys()].filter(k => k.startsWith(`${norm(dir)}/`))
  }
  write(path: string, text: string): void {
    this.files.set(norm(path), { text, mtimeMs: this.clock++ })
  }
  read(path: string): string {
    const f = this.files.get(norm(path))
    if (f === undefined) throw new Error(`ENOENT: ${path}`)
    return f.text
  }
  exists(path: string): boolean {
    return this.files.has(norm(path)) || this.under(path).length > 0
  }
  list(path: string) {
    const names = new Set<string>()
    for (const k of this.under(path)) names.add(k.slice(norm(path).length + 1).split('/')[0]!)
    return [...names].map(name => {
      const isFile = this.files.has(`${norm(path)}/${name}`)
      return { name, kind: isFile ? ('file' as const) : ('dir' as const), size: 0, mtimeMs: 0, isLink: false }
    })
  }
  stat(path: string) {
    const f = this.files.get(norm(path))
    if (f !== undefined) return { kind: 'file' as const, size: f.text.length, mtimeMs: f.mtimeMs, isLink: false }
    if (this.under(path).length > 0) return { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false }
    throw new Error(`ENOENT: ${path}`)
  }
  remove(argv: readonly string[]) {
    const path = norm(argv[argv.length - 1] ?? '')
    this.removed.push(path)
    for (const k of this.under(path)) this.files.delete(k)
    return { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
  }
}

// The test kit's `$` carries only the event nouns (no fs, env or process),
// so the journal's functions are handed an engine stand-in over the disk:
// exactly the calls journal.ts makes, each async as the engine's are.
function engineOver(d: Disk, env: Record<string, string> = { USERPROFILE: HOME, OS: 'Windows_NT' }, now = NOW): EngineInterface {
  const $ = {
    env: { get: async (name: string) => env[name] },
    clock: { now: async () => now },
    fs: {
      write: async (p: string, t: string) => d.write(p, t),
      read: async (p: string) => d.read(p),
      exists: async (p: string) => d.exists(p),
      list: async (p: string) => d.list(p),
      stat: async (p: string) => d.stat(p),
    },
    process: { run: async (argv: readonly string[]) => d.remove(argv) },
    ui: { log: () => undefined },
  }
  return $ as unknown as EngineInterface
}

test('bodyOf cuts text to MAX_TEXT and reports cut', () => {
  const body = bodyOf({ command: 'ls' }, { text: 'x'.repeat(30000) })
  expect(body.text.length).toBe(20000)
  expect(MAX_TEXT).toBe(20000)
  expect(body.cut).toBe(10000)
  expect(body.isError).toBe(false)
})

test('bodyOf tolerates a missing or non-string text', () => {
  expect(bodyOf({}, undefined).text).toBe('')
  expect(bodyOf({}, { text: 42 }).text).toBe('')
  expect(bodyOf({}, { text: 42, isError: true }).isError).toBe(true)
})

test('a 3 MB result writes one file under 64 KB', async () => {
  const d = new Disk()
  const $ = engineOver(d)
  await writeBody($, 's1', 'toolu_1', bodyOf({ command: 'cat big' }, { text: 'y'.repeat(3 * 1024 * 1024) }))

  const files = [...d.files.entries()]
  expect(files.length).toBe(1)
  expect(files[0]![0]).toBe(`${ROOT}/s1/steps/toolu_1.json`)
  expect(files[0]![1].text.length < 64 * 1024).toBe(true)
})

test('write then read round-trips', async () => {
  const $ = engineOver(new Disk())
  const body = bodyOf({ command: 'ls', n: 2 }, { text: 'a b', isError: true })
  await writeBody($, 's1', 'toolu_2', body)

  expect(await readBody($, 's1', 'toolu_2')).toEqual(body)
})

test('readBody of a missing file is undefined', async () => {
  const $ = engineOver(new Disk())
  expect(await readBody($, 's1', 'nope')).toBe(undefined)
})

test('snapshot round-trips', async () => {
  const $ = engineOver(new Disk())
  const t: Timeline = { ...empty, seq: 3, notes: [{ text: 'hi', agent: 'main', at: 5 }] }
  await saveSnapshot($, 's1', t)

  expect(await loadSnapshot($, 's1')).toEqual(t)
})

test('loadSnapshot of corrupt JSON is undefined', async () => {
  const d = new Disk()
  const $ = engineOver(d)
  d.files.set(`${ROOT}/s1/timeline.json`, { text: '{"seq": 1, "steps": [', mtimeMs: 1 })
  expect(await loadSnapshot($, 's1')).toBe(undefined)
  d.files.set(`${ROOT}/s1/timeline.json`, { text: '{"seq": 1}', mtimeMs: 1 })
  expect(await loadSnapshot($, 's1')).toBe(undefined)
})

test('prune keeps the newest 20', async () => {
  const d = new Disk()
  const $ = engineOver(d)
  for (let i = 0; i < 25; i++) {
    d.files.set(`${ROOT}/sess-${i}/timeline.json`, { text: '{}', mtimeMs: 100 + i })
  }

  await prune($, 20)

  expect(d.removed.sort()).toEqual([0, 1, 2, 3, 4].map(i => `${ROOT}/sess-${i}`).sort())
  const left = new Set([...d.files.keys()].map(k => k.split('/')[4]))
  expect(left.size).toBe(20)
})

test('prune spares the running session even when it is old', async () => {
  const d = new Disk()
  const $ = engineOver(d)
  for (let i = 0; i < 22; i++) {
    d.files.set(`${ROOT}/sess-${i}/timeline.json`, { text: '{}', mtimeMs: 100 + i })
  }

  await prune($, 20, 'sess-0')

  expect(d.removed).toEqual([`${ROOT}/sess-1`])
})

test("prune never runs cmd for a home folder cmd could misread (USERPROFILE='C:\\Users\\R&D')", async () => {
  const d = new Disk()
  const home = 'C:\\Users\\R&D'
  for (let i = 0; i < 25; i++) d.files.set(`C:/Users/R&D/.claude/mission-control/sess-${i}/timeline.json`, { text: '{}', mtimeMs: 100 + i })
  let ran = 0
  const $ = engineOver(d, { USERPROFILE: home, OS: 'Windows_NT' })
  ;($ as unknown as { process: { run: () => Promise<never> } }).process.run = async () => {
    ran++
    throw new Error('process.run must not be called')
  }

  await prune($, 20)

  expect(ran).toBe(0)
  expect(d.files.size).toBe(25)
})

test('prune runs cmd with the plain path when the home folder is safe, spaces included', async () => {
  const d = new Disk()
  for (let i = 0; i < 21; i++) d.files.set(`C:/Users/Tom Smith/.claude/mission-control/sess-${i}/timeline.json`, { text: '{}', mtimeMs: 100 + i })
  const argvs: (readonly string[])[] = []
  const $ = engineOver(d, { USERPROFILE: 'C:\\Users\\Tom Smith', OS: 'Windows_NT' })
  ;($ as unknown as { process: { run: (argv: readonly string[]) => unknown } }).process.run = async (argv: readonly string[]) => {
    argvs.push(argv)
    return d.remove(argv)
  }

  await prune($, 20)

  expect(argvs).toEqual([['cmd', '/d', '/c', 'rmdir', '/s', '/q', 'C:\\Users\\Tom Smith\\.claude\\mission-control\\sess-0']])
})

test('prune keeps a folder under 24 hours old', async () => {
  const d = new Disk()
  for (let i = 2; i < 22; i++) d.files.set(`${ROOT}/sess-${i}/timeline.json`, { text: '{}', mtimeMs: 100 + i })
  d.files.set(`${ROOT}/sess-0/timeline.json`, { text: '{}', mtimeMs: 10 })
  d.files.set(`${ROOT}/sess-1/timeline.json`, { text: '{}', mtimeMs: 50 })

  // Both oldest folders are under a day old by this clock: nothing goes.
  await prune(engineOver(d, undefined, 10 + DAY - 1), 20)
  expect(d.removed).toEqual([])

  // sess-0 is a day old, sess-1 a moment under: only sess-0 goes.
  await prune(engineOver(d, undefined, 50 + DAY - 1), 20)
  expect(d.removed).toEqual([`${ROOT}/sess-0`])
})

test('prune keeps a folder without timeline.json or steps', async () => {
  const d = new Disk()
  for (let i = 1; i < 22; i++) d.files.set(`${ROOT}/sess-${i}/timeline.json`, { text: '{}', mtimeMs: 100 + i })
  d.files.set(`${ROOT}/sess-0/notes.txt`, { text: 'not ours', mtimeMs: 1 })
  const $ = engineOver(d)
  // The folder's own time is known (and old), so only its contents keep it.
  ;($ as unknown as { fs: { stat: (p: string) => unknown } }).fs.stat = async (p: string) => {
    if (p.endsWith('/sess-0')) return { kind: 'dir', size: 0, mtimeMs: 1, isLink: false }
    return d.stat(p)
  }

  await prune($, 20)

  expect(d.removed).toEqual([`${ROOT}/sess-1`])
  expect(d.exists(`${ROOT}/sess-0`)).toBe(true)
})

test('prune removes a folder that holds only steps', async () => {
  const d = new Disk()
  for (let i = 1; i < 21; i++) d.files.set(`${ROOT}/sess-${i}/timeline.json`, { text: '{}', mtimeMs: 100 + i })
  d.files.set(`${ROOT}/sess-0/steps/toolu_1.json`, { text: '{}', mtimeMs: 1 })
  const $ = engineOver(d)
  ;($ as unknown as { fs: { stat: (p: string) => unknown } }).fs.stat = async (p: string) => {
    if (p.endsWith('/sess-0')) return { kind: 'dir', size: 0, mtimeMs: 1, isLink: false }
    return d.stat(p)
  }

  await prune($, 20)

  expect(d.removed).toEqual([`${ROOT}/sess-0`])
})

test('prune keeps a folder whose time is unknown', async () => {
  const d = new Disk()
  for (let i = 1; i < 22; i++) d.files.set(`${ROOT}/sess-${i}/timeline.json`, { text: '{}', mtimeMs: 100 + i })
  d.files.set(`${ROOT}/sess-0/timeline.json`, { text: '{}', mtimeMs: 0 })

  await prune(engineOver(d), 20)

  expect(d.removed).toEqual([`${ROOT}/sess-1`])
})

test('prune spares every folder it is given', async () => {
  const d = new Disk()
  for (let i = 0; i < 23; i++) d.files.set(`${ROOT}/sess-${i}/timeline.json`, { text: '{}', mtimeMs: 100 + i })

  await prune(engineOver(d), 20, ['sess-0', 'sess-1'])

  expect(d.removed).toEqual([`${ROOT}/sess-2`])
})

test('with no home folder the journal writes nothing', async () => {
  const d = new Disk()
  await writeBody(engineOver(d, {}), 's1', 'toolu_3', bodyOf({}, { text: 'x' }))
  expect(d.files.size).toBe(0)
})

// Through the mod itself: the disk answers the engine's fs calls beneath it.
// `box.sessionId` is what `$.session.id()` answers; a test may change it.
function world(on: On, d: Disk, sessionId: string): { timeline?: Timeline; sessionId: string } {
  const box: { timeline?: Timeline; sessionId: string } = { sessionId }
  mock.env(on, { USERPROFILE: HOME, OS: 'Windows_NT' })
  on('ui.log', () => ({ value: undefined }))
  on('session.id', () => ({ value: box.sessionId }))
  on('command.register', () => ({ value: { command: 'mc' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('classic.SessionStart', () => ({}))
  on('fs.read', (_, e) => ({ value: d.read(e.path) }))
  on('fs.write', (_, e) => ({ value: d.write(e.path, e.text) }))
  on('fs.exists', (_, e) => ({ value: d.exists(e.path) }))
  on('fs.list', (_, e) => ({ value: d.list(e.path) }))
  on('fs.stat', (_, e) => ({ value: d.stat(e.path) }))
  on('process.run', (_, e) => ({ value: d.remove(e.argv) }))
  on('state.set', async (_, e, next) => {
    const out = await next(e)
    if (e.key === 'timeline') box.timeline = (e.value as { value?: Timeline } | undefined)?.value
    return out
  })
  return box
}

const saved: Timeline = { ...empty, seq: 7, notes: [{ text: 'from before', agent: 'main', at: 9 }] }

test('a resumed session restores its snapshot', async ($, on) => {
  const d = new Disk()
  d.write(`${ROOT}/sess-r/timeline.json`, JSON.stringify(saved))
  const box = world(on, d, 'sess-new')

  await $.classic.SessionStart({ source: 'resume', session_id: 'sess-r' })

  expect(box.timeline).toEqual(saved)
})

test('session start prunes old folders and restores this session', async ($, on) => {
  const d = new Disk()
  for (let i = 0; i < 22; i++) d.write(`${ROOT}/old-${i}/timeline.json`, '{}')
  d.write(`${ROOT}/sess-s/timeline.json`, JSON.stringify(saved))
  const box = world(on, d, 'sess-s')
  mock.clock(on, { now: NOW })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect(box.timeline).toEqual(saved)
  expect(d.removed.length).toBe(3)
  expect(d.exists(`${ROOT}/sess-s`)).toBe(true)
})

test('a snapshot does not replace a timeline already under way', async ($, on) => {
  const d = new Disk()
  d.write(`${ROOT}/sess-r/timeline.json`, JSON.stringify(saved))
  const box = world(on, d, 'sess-r')
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  on('clock.now', () => ({ value: 1 }))

  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.classic.SessionStart({ source: 'resume', session_id: 'sess-r' })

  expect(box.timeline?.steps.length).toBe(1)
  expect(box.timeline?.seq).toBe(1)
})

test('a tool call writes its body to the journal', async ($, on) => {
  const d = new Disk()
  world(on, d, 'sess-b')
  on('tool.call', () => ({ result: {}, text: 'listing' }))
  const clock = mock.clock(on, { now: 1 })

  await $.tool.call({ tool: 'Bash', command: 'ls' })
  // The body is written after the hook returns: let that work settle.
  await clock.advance(1)

  const path = [...d.files.keys()].find(k => k.startsWith(`${ROOT}/sess-b/steps/`))
  expect(path === undefined).toBe(false)
  const body = JSON.parse(d.read(path!)) as { text: string; input: Record<string, unknown> }
  expect(body.text).toBe('listing')
  expect(body.input).toEqual({ command: 'ls' })
})

test('a main turn end saves a snapshot', async ($, on) => {
  const d = new Disk()
  world(on, d, 'sess-t')
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  const clock = mock.clock(on, { now: 1 })

  await $.turn.start({ text: 'hello', turnId: 't1' })
  await $.turn.complete({ answer: 'hi', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(1)

  const snap = JSON.parse(d.read(`${ROOT}/sess-t/timeline.json`)) as Timeline
  expect(snap.turns[0]?.id).toBe('t1')
  expect(snap.turns[0]?.endedAt).toBe(1)
})

test('a /clear keeps the timeline, and bodies and snapshots stay in its first journal folder', async ($, on) => {
  const d = new Disk()
  const box = world(on, d, 'sess-a')
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  const clock = mock.clock(on, { now: 1 })

  await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'toolu_a' } as never)
  await clock.advance(1)
  expect(box.timeline?.journal).toBe('sess-a')

  // /clear: the session goes on under a new id, with the state kept.
  box.sessionId = 'sess-b'
  d.write(`${ROOT}/sess-b/timeline.json`, JSON.stringify(saved))
  await $.classic.SessionStart({ source: 'clear', session_id: 'sess-b' })
  expect(box.timeline?.steps.map(s => s.id)).toEqual(['toolu_a'])
  expect(box.timeline?.journal).toBe('sess-a')

  await $.tool.call({ tool: 'Bash', command: 'pwd', tool_use_id: 'toolu_b' } as never)
  await $.turn.start({ text: 'hello', turnId: 't1' })
  await $.turn.complete({ answer: 'hi', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(1)

  expect(box.timeline?.steps.map(s => s.id)).toEqual(['toolu_a', 'toolu_b'])
  expect(d.exists(`${ROOT}/sess-a/steps/toolu_a.json`)).toBe(true)
  expect(d.exists(`${ROOT}/sess-a/steps/toolu_b.json`)).toBe(true)
  expect(d.under(`${ROOT}/sess-b`)).toEqual([`${ROOT}/sess-b/timeline.json`])
  const snap = JSON.parse(d.read(`${ROOT}/sess-a/timeline.json`)) as Timeline
  expect(snap.journal).toBe('sess-a')
  expect(snap.steps.map(s => s.id)).toEqual(['toolu_a', 'toolu_b'])
  expect(JSON.parse(d.read(`${ROOT}/sess-b/timeline.json`))).toEqual(saved)
})

test('a /clear with nothing in the state restores as before', async ($, on) => {
  const d = new Disk()
  d.write(`${ROOT}/sess-c/timeline.json`, JSON.stringify(saved))
  const box = world(on, d, 'sess-c')

  await $.classic.SessionStart({ source: 'clear', session_id: 'sess-c' })

  expect(box.timeline).toEqual(saved)
})

test("session start's prune spares the current timeline's journal folder", async ($, on) => {
  const d = new Disk()
  const box = world(on, d, 'sess-j')
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  const clock = mock.clock(on, { now: NOW })

  // A body under sess-j stamps it as the journal; it is the oldest folder.
  await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'toolu_j' } as never)
  await clock.advance(1)
  expect(box.timeline?.journal).toBe('sess-j')
  d.files.set(`${ROOT}/sess-j/timeline.json`, { text: JSON.stringify(box.timeline), mtimeMs: 1 })
  for (let i = 0; i < 22; i++) d.write(`${ROOT}/old-${i}/timeline.json`, '{}')

  // A reload under another id (as after /clear) runs session.start again.
  box.sessionId = 'sess-k'
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect(d.exists(`${ROOT}/sess-j/steps/toolu_j.json`)).toBe(true)
  // sess-j is the oldest of the three past the newest 20, and is spared.
  expect(d.removed.sort()).toEqual([`${ROOT}/old-0`, `${ROOT}/old-1`])
})

test('a timeline-1 value an earlier version stored reads as empty, and the snapshot is restored', async ($, on) => {
  const d = new Disk()
  d.write(`${ROOT}/sess-o/timeline.json`, JSON.stringify(saved))
  const box = world(on, d, 'sess-o')
  mock.clock(on, { now: NOW })
  const stale: Timeline = { ...empty, seq: 99, notes: [{ text: 'stale', agent: 'main', at: 1 }] }
  on('state.get', async (_, e, next) => (e.key === 'timeline' && box.timeline === undefined
    ? { value: { value: { shape: 'timeline-1', value: stale }, version: 0 } }
    : next(e)))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect(box.timeline).toEqual(saved)
})
