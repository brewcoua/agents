import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { showList } from "../lib/view.ts"
import { Spawner } from "./runtime.ts"

export default function (pi: ExtensionAPI) {
  const spawner = new Spawner(pi)
  for (const t of spawner.tools({ id: "main", depth: 0 })) pi.registerTool(t)

  pi.on("session_start", (_e, ctx) => {
    const { errors } = spawner.bind(ctx)
    if (errors.length) ctx.ui.notify(`agents: skipped\n${errors.join("\n")}`, "warning")
  })
  // Agents live in this process; they go with the session.
  pi.on("session_shutdown", () => spawner.shutdown())

  pi.registerCommand("agents", {
    description: "The agent types, their role and the file each comes from",
    handler: async (_args, ctx) => {
      const { errors } = spawner.reload()
      await showList(ctx, {
        title: "agent types",
        empty: "No agent types.",
        rows: () => [
          ...spawner.types().map((d) => ({
            label: `${d.name.padEnd(16)} ${d.role.padEnd(6)} ${d.description}`,
            detail: () => [d.path, `role ${d.role}, ${d.maxTurns} turns, isolation ${d.isolation}`, `tools ${d.tools?.join(", ") ?? "all"}`, ...(d.allowedAgents.length ? [`may start ${d.allowedAgents.join(", ")}`] : []), "", d.prompt].join("\n"),
          })),
          ...errors.map((e) => ({ label: `skipped: ${e}`, dim: true })),
        ],
      })
    },
  })
}
