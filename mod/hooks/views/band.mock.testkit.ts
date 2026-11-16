// A test helper, not part of the mock: the boards of CockpitBand in
// .superpowers/sdd/2026-11-16-cockpit-critters/ref/gen-cockpit.js, dumped row by row
// (the generator models every board as terminal cells; ¤ marks a cell of a Raster, but a bar is written out as ━ and gaps: F I3).
// `work`, `ask` and `watch` are 104 columns, two rows; `idle` is 104 columns, one row;
// `c64` and `c40` are the one-row forms at 64 and 40 columns. Imported by band.fidelity.test.tsx only.
export const BAND_MOCK: Record<'work' | 'ask' | 'watch' | 'idle' | 'c64' | 'c40', string[]> = {
  work: [
    "¤¤¤¤  Working on   Wiring the limiter into the middleware chain                   context 62%   week 34%",
    "¤¤¤¤  ━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━━  9 of 14 done   ·   2 agents working   ·   nothing needs you      /mc",
  ],
  ask: [
    "¤¤¤¤  Needs you   Builder asks to run  Bash  npm run deploy -- --env staging              answer below ↓",
    "¤¤¤¤  ━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━━  9 of 14 done   ·   1 agent working, 1 waiting                    /mc",
  ],
  watch: [
    "¤¤¤¤  Working on   Wiring the limiter into the middleware chain                   context 62%   week 34%",
    "¤¤¤¤  ━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━━  9 of 14 done   ·   2 agents working   ·   2 to watch             /mc",
  ],
  idle: [
    "✓ All 14 done   ·   1 h 18 min   ·   6 files changed   ·   cache warm 2:51                           /mc",
  ],
  c64: [
    "9 of 14  ·  2 agents  ·  Wiring the limiter  ·  context 62%  /mc",
  ],
  c40: [
    "▲ 1 needs you   ·   9 of 14          /mc",
  ],
}
