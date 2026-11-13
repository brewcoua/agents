// Pure part of the scout tool: no Pi imports, so node --test runs it.
import type { Def } from "../agents/defs.ts"
import type { Agent } from "../agents/fleet.ts"

export const MAX_SCOUTS = 6
export const SCOUT_TIMEOUT_MS = 180_000
export const SCOUT_MAX_CHARS = 8000

// A scout is an agent of the spawner, on the small role, with read-only tools; the question is its prompt.
export const SCOUT: Def = {
  name: "plan-scout",
  description: "Answers one question from the files of this project, for /plan",
  role: "small",
  tools: ["read", "grep", "find", "ls"],
  maxTurns: 30,
  isolation: "off",
  allowedAgents: [],
  prompt: "You are a read-only research scout. Answer the question you are given from the files of this project. Do not suggest changes. " +
    "Reply with findings only: paths with line numbers, short quotes, no preamble.",
  path: "extensions/tasks/scout.ts",
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[cut: ${text.length - max} more characters]`
}

export function formatScouts(questions: string[], scouts: Pick<Agent, "status" | "result" | "error">[]): string {
  return scouts
    .map((a, i) => {
      const head = `## Scout ${i + 1}: ${questions[i]}`
      if (a.status !== "done") return `${head}\nfailed: ${a.error ?? a.status}`
      return `${head}\n${clip(a.result?.trim() ?? "", SCOUT_MAX_CHARS) || "(no output)"}`
    })
    .join("\n\n")
}
