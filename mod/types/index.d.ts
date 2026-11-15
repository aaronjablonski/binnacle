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
  asking?: number                        // when tool.check resolved 'ask' for it; cleared when it ends
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
}
export type Run = { runId: string; name: string; parent: AgentKey; startedAt: number }
export type TaskItem = {
  id: string; subject: string; activeForm?: string
  status: 'pending' | 'in_progress' | 'completed'
  owner: AgentKey; updatedAt: number
}
export type TurnRow = {
  id: string; agent: AgentKey; prompt: string; startedAt: number; endedAt?: number
  failed?: true                          // it ended with an error or a refusal
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
export type Budget = { contextPct?: number; windows: BudgetWindow[]; costUsd?: number; at: number }   // windows ≤ 8
export type Timeline = {
  seq: number; turns: TurnRow[]; steps: Step[]
  agents: Record<AgentKey, AgentRow>; runs: Record<string, Run>
  tasks: TaskItem[]; now?: Now; notes: Note[]
  artifacts: ArtifactRow[]; changed: string[]   // distinct code paths written or edited
  journal?: string                       // the session id whose journal folder holds this timeline's bodies and snapshot; set at the first write, kept across /clear
  budget?: Budget                        // the last session.measure
}
export type Update = {
  focus?: string; next?: string; note?: string
  artifact?: { title: string; kind: 'result' | 'link'; ref?: string; summary?: string }
}
export type Ev =
  | { kind: 'turn.start'; at: number; turnId: string; agent: AgentKey; prompt: string }
  | { kind: 'turn.end'; at: number; turnId: string; agent: AgentKey; answer: string; failed: boolean }
  | { kind: 'step.start'; at: number; id: string; agent: AgentKey; tool: string; input: Record<string, unknown> }
  | { kind: 'step.end'; at: number; id: string; status: 'done' | 'error' | 'denied'; result?: unknown }
  | { kind: 'agent.start'; at: number; id: AgentKey; parent: AgentKey; type: string; description: string; runId?: string; agentIndex?: number }
  | { kind: 'update'; at: number; agent: AgentKey; update: Update }
  | { kind: 'pin'; id: string; note: string }
  | { kind: 'unpin'; id: string }
  | { kind: 'step.ask'; at: number; id: string }
  | { kind: 'usage'; at: number; agent: AgentKey; model?: string; tokensIn: number; tokensOut: number }
  | { kind: 'measure'; at: number; budget: Budget }
  | { kind: 'agent.model'; id: AgentKey; model: string }
export type StepFilter = { kind: 'all' } | { kind: 'pinned' } | { kind: 'errors' } | { kind: 'agent'; id: AgentKey }
export type StepBody = { input: Record<string, unknown>; text: string; cut: number; isError: boolean }
export type Tab = 'overview' | 'tasks' | 'agents' | 'timeline' | 'artifacts'
export type UiState = {
  tab: Tab; filter: StepFilter
  agentsMode: 'list' | 'tree'; folded: string[]        // folded tree node keys
  openTurns: string[]                                  // older timeline turns the person opened (the newest is always open)
  detail?: { stepId: string; body?: StepBody; missing?: true }
  dismissed: string[]                                  // dismissKey of each problem the person dismissed (≤ 200, newest last)
  query: string                                        // the Timeline's find text (≤ 200)
  run?: string                                         // the workflow run whose board the Agents tab shows
  runningOnly: boolean                                 // the agent tree hides finished branches
  notified: string[]                                   // ids already raised as a notification (≤ 200, newest last)
  toasted: string[]                                    // markers of toasts already raised (≤ 50, newest last)
}

declare module 'claude-code' {
  interface PluginState {
    'mission-control': {
      timeline: Shaped<Timeline>
      ui: Shaped<UiState>
    }
  }
}
