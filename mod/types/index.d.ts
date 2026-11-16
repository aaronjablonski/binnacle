// Mission Control's state contract: the values it keeps in $.state, and the
// model types its hooks and views share. Self-contained on purpose: no import
// or reference, types only.

export type AgentKey = string            // 'main' or an agentId
export type StepStatus = 'running' | 'done' | 'error' | 'denied' | 'interrupted'
export type Step = {
  id: string; seq: number; agent: AgentKey; turnId?: string
  tool: string; label: string; status: StepStatus
  startedAt: number; endedAt?: number
  pin?: string                           // the note; '' when pinned without one
  pending?: Record<string, unknown>      // input kept between start and end; cleared at step.end
  asking?: number                        // set when a permission prompt was raised for this step; cleared when it ends, or when an agent it spawned shows it went ahead
  sig?: string                           // its call signature: a hash of the tool and its normalised input (≤ 16); absent on steps an earlier version stored
}
export type AgentRow = {
  id: AgentKey; parent: AgentKey; type: string; description: string
  runId?: string; agentIndex?: number    // workflow agents only
  status: 'running' | 'done' | 'error'
  startedAt: number; endedAt?: number
  doing: string; stepCount: number
  taskId?: string                        // the task in progress when it spawned
  model?: string                         // the model it runs on: agent.spawn's, then each turn's usage (≤ 64)
  tokensIn?: number; tokensOut?: number  // summed over its turns' usage; input counts cache reads and writes
  result?: string                        // a workflow agent's StructuredOutput input on one line (≤ 200)
  lastStepAt?: number                    // when it last started a step
  spawnStep?: string                     // the tool_use_id of the Agent or Workflow call that spawned it (≤ 64)
  cacheRead?: number; cacheWrite?: number // of tokensIn, summed over its turns: input read from and written to the prompt cache; absent on rows an earlier version stored
  ms?: number                            // its turns' wall-clock length, summed (turn.complete's durationMs)
}
export type Run = { runId: string; name: string; parent: AgentKey; startedAt: number }
export type TaskItem = {
  id: string; subject: string; activeForm?: string
  status: 'pending' | 'in_progress' | 'completed'
  owner: AgentKey; updatedAt: number
  tokens?: number; ms?: number           // the main loop's turns attributed to it (tokens in + out, wall-clock ms): each goes to the task in progress at the turn's end; its agents' own are on their rows
}
export type TurnRow = {
  id: string; agent: AgentKey; prompt: string; startedAt: number; endedAt?: number
  failed?: true                          // it ended with an error or a refusal
  aborted?: true                         // the person interrupted it
}
export type Now = { focus: string; next?: string; at: number }
export type Note = { text: string; agent: AgentKey; at: number }
export type ArtifactKind = 'page' | 'document' | 'result' | 'link'
export type ArtifactRow = {
  id: string; kind: ArtifactKind; title: string
  ref?: string; summary?: string; stepId?: string
  agent: AgentKey; count: number; updatedAt: number
}
export type BudgetWindow = { name: string; pct: number; resetsAt?: number }   // name: the window's kind (≤ 40); resetsAt in ms
export type Budget = { contextPct?: number; contextTokens?: number; windows: BudgetWindow[]; costUsd?: number; at: number }   // windows ≤ 8
/** One measurement kept for pace: the context fill and each window's pct, `w[i]` for `Samples.names[i]` (null: not reported then). */
export type Sample = { at: number; ctx?: number; w: (number | null)[] }
/** The pace ring: at most 30 samples, consecutive ones at least a minute apart (the newest replaces the last while it is not). */
export type Samples = { names: string[]; list: Sample[] }   // names ≤ 8, each ≤ 40
/** The cache clock: the last main-loop reply, and whether the cache was seen to outlive 5 minutes this session. */
export type CacheClock = { at: number; hour?: true }
/** The cost of the newest main turn: the session's cost at its start, and at its end (or the latest measure while it runs). */
export type TurnCost = { turnId: string; from: number; to?: number }
/** An MCP server's request for the person's input (an elicitation dialog), open until its result comes. */
export type InputAsk = { id: string; agent: AgentKey; server: string; message: string; at: number }   // id ≤ 64, server ≤ 64, message ≤ 200
/** Why the newest failed main turn stopped, for the header's STOPPED line. */
export type TurnFailure = { turnId: string; reason: string }   // reason ≤ 120
/** What `/mc export` wrote last. */
export type LastExport = { at: number; path: string }  // path ≤ 1000
export type Timeline = {
  seq: number; turns: TurnRow[]; steps: Step[]
  agents: Record<AgentKey, AgentRow>; runs: Record<string, Run>
  tasks: TaskItem[]; now?: Now; notes: Note[]
  artifacts: ArtifactRow[]; changed: string[]   // distinct code paths written or edited
  journal?: string                       // the session id whose journal folder holds this timeline's bodies and snapshot; set at the first write, kept across /clear
  budget?: Budget                        // the last session.measure
  samples?: Samples                      // the measure ring pace reads
  cache?: CacheClock
  turnCost?: TurnCost
  lastExport?: LastExport
  autoAsk?: true                         // the newest permission request came in auto mode (its ask may settle without the person)
  asks?: InputAsk[]                      // open MCP input requests (≤ 4)
  failure?: TurnFailure                  // the newest failed main turn's reason
  listFrom?: number                      // when the lead's current list began: a main prompt that started with every lead task complete folds the older ones away ("Earlier")
}
/** One item of the update tool's `tasks` list: the whole list is sent each time. */
export type ListItem = { title: string; state: 'todo' | 'doing' | 'done' }
export type Update = {
  focus?: string; next?: string; note?: string
  artifact?: { title: string; kind: 'result' | 'link'; ref?: string; summary?: string }
  tasks?: ListItem[]
}
export type Ev =
  | { kind: 'turn.start'; at: number; turnId: string; agent: AgentKey; prompt: string }
  | { kind: 'turn.end'; at: number; turnId: string; agent: AgentKey; answer: string; failed: boolean; aborted?: boolean; reason?: string }
  | { kind: 'step.start'; at: number; id: string; agent: AgentKey; tool: string; input: Record<string, unknown> }
  | { kind: 'step.end'; at: number; id: string; status: 'done' | 'error' | 'denied'; result?: unknown }
  | { kind: 'agent.start'; at: number; id: AgentKey; parent: AgentKey; type: string; description: string; runId?: string; agentIndex?: number; spawnStep?: string }
  | { kind: 'update'; at: number; agent: AgentKey; update: Update }
  | { kind: 'pin'; id: string; note: string }
  | { kind: 'unpin'; id: string }
  | { kind: 'step.ask'; at: number; id: string; auto?: boolean }
  | { kind: 'input.ask'; at: number; id: string; agent: AgentKey; server: string; message: string }
  | { kind: 'input.done'; id?: string; server: string }
  | { kind: 'turn.fail'; agent: AgentKey; reason: string }
  | { kind: 'step.unask'; id: string }
  | { kind: 'usage'; at: number; agent: AgentKey; model?: string; tokensIn?: number; tokensOut?: number; cacheRead?: number; cacheWrite?: number; ms?: number; turnId?: string }
  | { kind: 'measure'; at: number; budget: Budget }
  | { kind: 'agent.model'; id: AgentKey; model: string }
  | { kind: 'export'; at: number; path: string }
/** When to raise a native notification: never; on waits; on waits and long turns that finished; on those and failed turns too. */
export type NotifyMode = 'off' | 'waits' | 'done' | 'all'
/** One session's row in the ledger (`$.store`, at most 400): its local day (YYYY-MM-DD, of its first write), tokens in + out by model (≤ 6 models), and cost when the host reports one. */
export type LedgerRow = { day: string; session: string; tokens: Record<string, number>; usd?: number; at: number }
export type StepFilter = { kind: 'all' } | { kind: 'pinned' } | { kind: 'errors' } | { kind: 'agent'; id: AgentKey }
export type StepBody = { input: Record<string, unknown>; text: string; cut: number; isError: boolean }
export type Tab = 'overview' | 'tasks' | 'agents' | 'timeline' | 'artifacts'
/** The kinds of page (`UiState.page`): the four detail pages, and Options (its id the field opened under its row, '' for none). */
export type PageKind = 'task' | 'agent' | 'step' | 'artifact' | 'options'
export type UiState = {
  tab: Tab; filter: StepFilter
  agentsMode: 'list' | 'tree'; folded: string[]        // folded tree node keys
  openTurns: string[]                                  // older timeline turns the person opened (the newest is always open)
  detail?: { stepId: string; body?: StepBody; missing?: true }
  dismissed: string[]                                  // dismissKey of each problem the person dismissed (≤ 200, newest last)
  query: string                                        // the Timeline's find text (≤ 200)
  hits?: string[]                                      // step ids whose stored result holds the query (deep search, ≤ 200, newest first); cleared when the query changes
  run?: string                                         // the workflow run whose board the Agents tab shows
  runningOnly: boolean                                 // the agent tree hides finished branches
  notified: string[]                                   // ids already raised as a notification (≤ 200, newest last)
  toasted: string[]                                    // markers of toasts already raised (≤ 50, newest last)
  agentOpen?: string                                   // the agent row opened in place on the Agents tab (its AgentKey)
  stepOpen?: string                                    // the step opened in place on the Steps tab (its id); the full step is `detail`
  taskOpen?: string                                    // the active task opened in place on the Tasks tab (its `<owner>:<id>`)
  doneAll?: boolean                                    // the Tasks tab lists every done task, not the newest 3
  artifactOpen?: string                                // the artifact row opened in place (its id); absent, the newest is open; "" closes it
  slim: boolean                                        // `/mc slim` asked for the 28-column pane; the layout itself reads only bodyColumns
  paneOpen?: boolean                                   // the pane is open (set by /mc open, 1-5, slim and close, and by ui.close for the person's own close); the band is compact while true. Optional so a value an earlier version stored, and test fixtures, still type; readUi always answers a boolean
  strip?: boolean                                      // `/mc strip` asked for the strip in the band in place of the pane; set false by /mc, /mc 1-5, /mc slim and a press in the strip. Optional as paneOpen is: readUi always answers a boolean
  page?: { kind: PageKind; id: string; from?: string } // the detail page that replaces the open tab's list (id ≤ 200; a task's is `<owner>:<id>`); `from` is the key of the row it was opened from (≤ 200), which `b` focuses again; cleared by b, a tab switch and /mc 1-5. Optional: a value stored before it existed reads as no page
}

declare module 'claude-code' {
  interface PluginState {
    'mission-control': {
      timeline: Shaped<Timeline>
      ui: Shaped<UiState>
    }
  }
}
