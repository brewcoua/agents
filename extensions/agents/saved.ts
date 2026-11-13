// An agent's state as its session file keeps it, so agents outlive the Pi that ran them.

import type { Message } from "@earendil-works/pi-ai"
import type { Agent } from "./fleet.ts"

export const META = "agent" // custom entry written when the session is created
export const END = "agent-end" // written each time the agent ends; the last one counts

const META_KEYS = ["id", "handle", "type", "description", "parent", "depth", "cwd", "worktree", "branch"] as const
const END_KEYS = ["status", "error", "turns", "tokens", "cost"] as const
const pick = <K extends keyof Agent>(a: Agent, keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, a[k]])) as Pick<Agent, K>

export const meta = (a: Agent) => pick(a, META_KEYS)
export const end = (a: Agent) => pick(a, END_KEYS)

type Entry = { type: string; customType?: string; data?: unknown }
const custom = (entries: Entry[], type: string) => entries.filter((e) => e.type === "custom" && e.customType === type).map((e) => e.data)

// The ended agent a session file describes, or undefined when it is not an agent's.
export function restore(entries: Entry[], file: string, result: string): Agent | undefined {
  const m = custom(entries, META)[0] as ReturnType<typeof meta> | undefined
  if (!m) return undefined
  const e = custom(entries, END).at(-1) as ReturnType<typeof end> | undefined
  return {
    ...m,
    background: true,
    ...(e ?? { status: "stopped", error: "Pi exited while it ran", turns: 0, tokens: 0, cost: 0 }),
    result,
    sessionFile: file,
  }
}

// The sessions under `root`, each after its parent, from each file's header `parent`.
export function descendants(headers: { file: string; parent?: string }[], root: string): string[] {
  const out: string[] = []
  for (let q = [root]; q.length; ) {
    const children = headers.filter((h) => h.parent && q.includes(h.parent)).map((h) => h.file)
    out.push(...children)
    q = children
  }
  return out
}

// The parent's conversation as an agent starts from it: without the parent's system messages, which
// carry its tool loadout, and without the tool calls that have no result yet (its own `agent`
// call among them), since providers reject a call left unanswered.
export function inherited(messages: Message[]): Message[] {
  const answered = new Set(messages.flatMap((m) => (m.role === "toolResult" ? [m.toolCallId] : [])))
  return messages.flatMap((m): Message[] => {
    if (m.role === "system") return []
    if (m.role !== "assistant") return [m]
    const content = m.content.filter((c) => c.type !== "toolCall" || answered.has(c.id))
    return content.length ? [{ ...m, content }] : []
  })
}
