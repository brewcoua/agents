import { truncateToWidth } from "@earendil-works/pi-tui"
import { short } from "../budget/limits.ts"
import { tint } from "../ui/ui.ts"
import type { Agent } from "./fleet.ts"

export const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"

type Fg = (color: string, s: string) => string

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
