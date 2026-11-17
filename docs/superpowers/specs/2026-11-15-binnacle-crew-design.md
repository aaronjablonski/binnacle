# Crew characters and space use: mock round

Mock only. Nothing in `mod/`, `test/` or `docs/` changed.

- Generator: a scratch script, `gen-crew.js` (`node gen-crew.js`), not kept in the repository
- Boards: `scratchpad/mcstyles/project/Crew*.dc.html`
- Plain previews and check sheets (PNG): `scratchpad/crew-preview/`

## What the feedback asked for

1. The characters did not tell their role, and were not in the Claude Code mascot's spirit.
2. They were too big (about 8 × 4 cells) in the deck and on the map.
3. The map was hard to read and wasted the right-hand side.

## Sizes

A character is drawn in quadrant blocks: 2 × 2 sub-pixels to a cell.

| Form | Cells (rows × cols) | Sub-pixels | Used in |
|---|---|---|---|
| small (default) | 3 × 5 | 10 × 6 | lists, the deck, map nodes |
| micro | 2 × 4 | 8 × 4 | crew strips, slim mode, the band, short panes |
| hero | 4 × 7 | 14 × 8 | the agent's page and the Now hero only |

The state badge is one extra cell to the right of the top row, so a small character with a badge is 6 columns.

## Role hues (the same in every family)

| Role | Hue | Why |
|---|---|---|
| lead | ember `#e07b53` | the mascot's orange |
| scout | teal `#3fbdb4` | radar green-blue |
| build | iris `#8a9bff` | blueprint blue (the current builder is blue) |
| check | orchid `#b48cf2` | not used by any state |

Amber, red, grey and mint are kept for states, so a role hue never reads as a state.

## States

The shape is one grid per role and size; a state only recolours it.

| State | Body | Eyes | Lamp | Badge |
|---|---|---|---|---|
| queued | role hue, 62 % towards the ground | shut | off | none |
| working | role hue | open; frame 2 shuts them (blink) | white; frame 2 tints it | none |
| waiting | role hue | open | amber | `?` on amber |
| stalled | role hue, 42 % towards the ground | shut | off | `z` on amber |
| failed | role hue, 50 % towards the ground | red | red | `!` on red |
| done | grey with a trace of the hue | shut | mint | none |

Families B and D have lit eyes instead of a belly lamp, so their eyes carry the lamp colour.

## The four families

All four: flat colour, a wide low body, simple eyes, one prop per role. Props are a pale tint of the role hue on the night ground and a darker shade on the day ground.

### A. Critters (recommended)

The mascot's siblings: a slab body, two square eyes, stub arms, four legs, and a glowing core on the belly (the lamp).

- lead: a crown. It gives the orders.
- scout: a radar dish and pale goggles. It goes ahead and looks.
- build: a hard hat with a wide brim. It is on site, making the change.
- check: a magnifier held over one eye, handle up. It inspects.

### B. Visor pups

Robot pups: a rounded head with two ears, a dark visor with two lit eyes, two chunky feet. The face shows the state.

- lead: a comms mast with a beacon between the ears.
- scout: big radar ears, pricked up.
- build: a hard hat pulled over the ears.
- check: one eye is a rimmed lens.

### C. Space crabs

A shell, two raised claws, four legs, a core lamp. The right claw is the tool.

- lead: a crown between the claws.
- scout: two periscope eyes on stalks, claws tucked in.
- build: a spanner-jaw claw.
- check: a claw holding up a lens.

### D. Hover pods

Saucer drones: no legs, one lit camera eye in a dark socket, two thrusters that burn while live and go out when it lands.

- lead: a halo ring floating above it.
- scout: a dish and one wide-open eye.
- build: a hard hat and two grabber arms hanging down.
- check: a pale magnifier ring around the eye, with a handle.

## Recommendation

**A, Critters.** It is closest to the mascot (slab, square eyes, legs), its four hats are the most readable props at 3 × 5, and its micro form still shows the crown and the hard hat. The glowing core and the scout's goggles and dish give it the futuristic touch.

Weaknesses seen in the check sheets:

- A: the scout's dish reads as a forked antenna at 3 × 5. It is still unique in the crew.
- B: the micro form loses the feet, and the check's lens is the weakest prop of the family.
- C: the strongest tool story (the periscope scout and the spanner claw are the best single props of the round), but the claws make every silhouette busier and the lead's crown gets lost between them.
- D: the check is weak, and the build's hanging arms read as a jellyfish.

If A feels too close to the mascot, C is the second choice. C's periscope scout could also be borrowed into A.

## Cell rules the generator asserts

- Every character is exactly its size: 10 × 6, 8 × 4 or 14 × 8 sub-pixels.
- Every cell needs at most two colours, the ground counting as one. Checked for all 4 families × 4 roles × 3 sizes × 6 states × 2 grounds × 2 frames.
- On a pane, no two things share a cell and nothing leaves the pane's width.
- Every `div` and `span` is closed, and there is no emoji.

Each cell also resolves to one quadrant glyph with a foreground and a background (`cellsOf` returns it), so a Raster can draw it as is.

## CREW deck (`CrewDeckSmall`)

The old deck cost 6 rows for the crew alone. The new forms put the facts beside the character.

1. **Small, 3 rows (default).** A card is 13 columns: the character, the badge cell, then name, tokens and time stacked. Four cards and a done chip fit 62 columns.
2. **Micro, 2 rows.** The same cards with two facts, for panes under 30 rows.
3. **Long session.** Only main and live agents are drawn. Done agents fold into one `+ n done` chip with a pip per agent in its role hue. 35 agents cost the same rows as 2.
4. **Slim, 24 columns.** Micro characters in a row, the counts in words under them.
5. **Band.** The micro crew stands between the state pill and the focus; the band stays 2 rows.

## Crew map rules (`CrewMapClear`)

35 agents (1 live, 34 done) fit 33 rows at 62 columns.

1. **Only live agents get a character.** Main and each live agent are drawn small with name, role and model, and the current step. Three rows each.
2. **Done agents fold.** A done agent is a pip in its role hue. A task's done agents are one `+ n done` chip. A done task is one row.
3. **Three bands, top-down:** NOW (tasks with a live agent, open), DONE (newest first, one row each), NEXT (queued tasks, then agents with no task).
4. **One indent per level.** Trunk at column 4, task names at column 9, agent tethers at column 7, agent names at column 17.
5. **The right side is a table.** STATE at column 41, TOKENS right-aligned to column 54, TIME right-aligned to column 61, on every row. A task row shows its sum. Pips end at column 39. A TOTAL row closes the map.
6. **Flags climb.** A waiting or failed agent is never folded: it stays drawn with its badge, its task moves to NOW, and `?` or `!` shows in the gutter. (Stated on the board, not drawn: the mock session has no flagged agent.)
7. **Unfold on demand.** `d` on a chip or a done task lists its agents one row each: pip, role, name and the three columns. Still no characters.

## Open points for the owner

- Pick a family (or a mix, such as A with C's periscope scout).
- Whether done should keep more of the role hue than the current grey.
- Whether the lead should be drawn one size up in the deck. It is the same size as the others in these mocks.
