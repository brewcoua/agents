// The agents of this Pi and what they are doing; no sessions here, only their state.

export type Status = "queued" | "running" | "done" | "failed" | "stopped"

export type Agent = {
  id: string
  handle: string // `name` from the call, or `<type>-<n>`
  type: string
  description: string
  parent: string // "main" or an agent id
  depth: number // 1 for an agent started by main
  background: boolean
  owner?: string // the extension that started it and waits for it (Spawner.spawn)
  status: Status
  startedAt?: number
  endedAt?: number
  turns: number
  tokens: number
  cost: number
  tool?: string // the tool running now
  context?: number // percent of the context window
  result?: string
  error?: string
  sessionFile?: string
  cwd?: string // where it works: its worktree, else its parent's directory
  worktree?: string // with isolation worktree, its branch is `branch`
  branch?: string
}

export const MAX_DEPTH = 2
export const GRACE_TURNS = 3

export const live = (a: Agent) => a.status === "queued" || a.status === "running"

export function newHandle(agents: Agent[], type: string, name?: string): string | { error: string } {
  if (name) return agents.some((a) => a.handle === name) ? { error: `an agent is already called ${name}` } : name
  let n = 1
  while (agents.some((a) => a.handle === `${type}-${n}`)) n++
  return `${type}-${n}`
}

export const find = (agents: Agent[], ref: string) => agents.find((a) => a.id === ref || a.handle === ref)

// The limit holds per depth, so an agent waiting on its own children never holds the slot they need.
export const canStart = (agents: Agent[], a: Agent, max: number) => agents.filter((x) => x.status === "running" && x.depth === a.depth).length < max

// The queued agents that may start now, oldest first.
export function startable(agents: Agent[], max: number): Agent[] {
  const out: Agent[] = []
  const view = agents.map((a) => ({ ...a }))
  for (const a of view) {
    if (a.status !== "queued" || !canStart(view, a, max)) continue
    a.status = "running"
    out.push(agents.find((x) => x.id === a.id) as Agent)
  }
  return out
}

// The agent and every agent under it.
export function subtree(agents: Agent[], id: string): Agent[] {
  const out = agents.filter((a) => a.id === id)
  for (let i = 0; i < out.length; i++) out.push(...agents.filter((a) => a.parent === out[i].id))
  return out
}

export function report(a: Agent): string {
  const head = `Agent ${a.handle} (${a.type}, id ${a.id})`
  if (a.status === "queued") return `${head} is queued.`
  if (a.status === "running") return `${head} is running: ${a.turns} turns so far${a.tool ? `, now ${a.tool}` : ""}.`
  if (a.status === "failed") return `${head} failed: ${a.error ?? "unknown error"}`
  const stopped = a.status === "stopped" ? " was stopped" : " finished"
  const where = a.branch ? `\n\nIts changes are committed on branch ${a.branch}, in ${a.worktree}.` : ""
  return `${head}${stopped}${a.error ? ` (${a.error})` : ""}:\n\n${a.result || "(no text)"}${where}`
}

export const WRAP_UP = "You have reached your turn limit. Do not call more tools: give your final answer now, with what you have."

// `@name message` at the start of a prompt; whether `name` is an agent is the caller's to check.
export function mention(text: string): { ref: string; message: string } | undefined {
  const m = /^@([\w.-]+)\s+(\S[\s\S]*)$/.exec(text.trim())
  return m ? { ref: m[1], message: m[2].trim() } : undefined
}
