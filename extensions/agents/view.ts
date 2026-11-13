import type { Message } from "@earendil-works/pi-ai"
import { truncateToWidth } from "@earendil-works/pi-tui"
import { short } from "../budget/limits.ts"
import { tint } from "../ui/ui.ts"
import type { Agent, Status } from "./fleet.ts"

export const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"

export type Fg = (color: string, s: string) => string

// The widget above the editor: one line per running agent.
export function widget(agents: Agent[], frame: number, width: number, fg: Fg): string[] {
  return agents
    .filter((a) => a.status === "running")
    .map((a) => {
      const parts = [
        `${fg("accent", SPINNER[frame % SPINNER.length])} ${a.handle}`,
        fg("muted", a.tool ?? "thinking"),
        fg("dim", `${short(a.tokens)} tok`),
        ...(a.context === undefined ? [] : [tint(`ctx ${Math.round(a.context)}%`, fg)]),
      ]
      return truncateToWidth(parts.join(fg("borderMuted", " · ")), width, "…")
    })
}

// Each agent after its parent, children in start order.
export function tree(agents: Agent[], parent = "main"): Agent[] {
  return agents.filter((a) => a.parent === parent).flatMap((a) => [a, ...tree(agents, a.id)])
}

const STATUS_COLOR: Record<Status, string> = { queued: "dim", running: "accent", done: "success", failed: "error", stopped: "warning" }

// The fleet below the editor: main, then every agent of the session, nested ones indented.
// `selected` is a row index (0 is main) while the fleet has the keyboard.
export function fleet(agents: Agent[], selected: number | undefined, width: number, fg: Fg): string[] {
  const rows = [
    fg("muted", "main"),
    ...tree(agents).map((a) => {
      const fore = a.status === "running" && !a.background ? fg("dim", " foreground") : ""
      return `${"  ".repeat(a.depth)}${a.handle} ${fg("dim", a.type)}  ${a.description}  ${fg(STATUS_COLOR[a.status], a.status)}${fore}${fg("dim", ` ${a.turns} turns`)}`
    }),
  ]
  const hint = selected === undefined ? "↓ on an empty prompt to select" : "enter transcript · x x stop · b background · esc back"
  return [
    ...rows.map((r, i) => truncateToWidth(`${i === selected ? fg("accent", "› ") : "  "}${r}`, width, "…")),
    truncateToWidth(fg("dim", `  ${hint}`), width, "…"),
  ]
}

const text = (c: Message["content"]) =>
  (typeof c === "string" ? c : c.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n")).trim()

// An agent's conversation as markdown: the prompt, its text, and one line per tool call.
// Tool results are left out; the agent's text says what it made of them.
export function conversation(messages: Message[]): string {
  const out: string[] = []
  for (const m of messages) {
    if (m.role === "user") out.push(text(m.content).replace(/^/gm, "> "))
    else if (m.role === "assistant") {
      const t = text(m.content)
      if (t) out.push(t)
      for (const p of m.content) if (p.type === "toolCall") out.push(`\`${p.name}\` ${truncateToWidth(JSON.stringify(p.arguments), 100, "…")}`)
    } else if (m.role === "toolResult" && m.isError) out.push(`\`${m.toolName}\` failed: ${truncateToWidth(text(m.content), 200, "…")}`)
  }
  return out.join("\n\n")
}
