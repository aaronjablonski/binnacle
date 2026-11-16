import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'

// The manifest's userConfig is what the person can set in /config and what
// the Options card writes through `$.config.set`.
const manifest = JSON.parse(readFileSync(new URL('../mod/.claude-plugin/plugin.json', import.meta.url), 'utf8')) as {
  userConfig: Record<string, { type: string; options?: string[]; default?: unknown; description?: string }>
}

// BEHAVIOUR CHANGE (task C3b, R21): was rich or text, rich by default; auto joins them and is the default (rich, except text on ANSI or daltonized themes).
test('look is declared: auto, rich or text, auto by default, so the text form can be chosen', () => {
  const look = manifest.userConfig.look
  expect(look).toBeDefined()
  expect(look?.type).toBe('string')
  expect(look?.options).toEqual(['auto', 'rich', 'text'])
  expect(look?.default).toBe('auto')
})
