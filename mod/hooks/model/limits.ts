// Bounds that keep the Timeline well under $.state's 4,194,304-character limit.
export const MAX_STEPS = 2000
export const MAX_TURNS = 200
export const MAX_NOTES = 50
export const MAX_ARTIFACTS = 200
export const MAX_CHANGED = 1000
export const MAX_TASKS = 500           // past it, completed tasks go first, then the oldest
export const MAX_AGENTS = 500          // past it, finished agents go first; `main` is never dropped
export const MAX_RUNS = 100            // past it, the oldest run goes
export const MAX_LINE = 200            // focus, next, note, artifact title and summary are cut to this
export const MAX_PENDING = 500         // each string a step keeps in `pending` is cut to this
export const MAX_PENDING_STEPS = 100   // only the newest this many steps keep their `pending`
export const MAX_REF = 1000            // an artifact's ref is cut to this
export const DOC_EXT = ['.md', '.mdx', '.html', '.pdf', '.docx', '.pptx', '.xlsx', '.csv', '.png', '.jpg', '.jpeg', '.svg']
