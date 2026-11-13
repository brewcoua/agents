import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent"
import {
  type Model, ROLES, isQuotaError, loadActive, loadProfiles, nextProfile, showModel, switchTo, writeActive,
} from "../lib/profiles.ts"

export default function (pi: ExtensionAPI) {
  const find = (ctx: ExtensionContext, m: Model) => ctx.modelRegistry.find(m.provider, m.id)

  function show(ctx: ExtensionContext) {
    const { profile, roles } = loadActive(getAgentDir())
    const lines = ROLES.map((role) => {
      const model = find(ctx, roles[role])
      const state = !model ? "unknown" : ctx.modelRegistry.hasConfiguredAuth(model) ? "credentials" : "no credentials"
      return `${role.padEnd(6)}${showModel(roles[role])} (${state})`
    })
    ctx.ui.notify([`profile ${profile}`, ...lines].join("\n"), "info")
  }

  // The session moves to the profile's top model, and the roles are stored for tasks and scouts.
  async function use(name: string, ctx: ExtensionContext) {
    const profiles = loadProfiles()
    if (!profiles.profiles[name]) return ctx.ui.notify(`/provider: no profile ${name} (${profiles.order.join(", ")})`, "error")
    const from = loadActive(getAgentDir(), profiles)
    const { active, unknown } = switchTo(profiles, name, from, (m) => !!find(ctx, m))
    const top = find(ctx, active.roles.top)
    if (!top || !(await pi.setModel(top))) return ctx.ui.notify(`/provider: no credentials for ${showModel(active.roles.top)}`, "error")
    writeActive(getAgentDir(), active)
    const notes = unknown.map((role) => {
      const m = profiles.profiles[name][role]
      const pull = m.provider === "ollama" ? `; ollama pull ${m.id}` : ""
      return `${role}: ${showModel(m)} is unknown, keeps ${showModel(active.roles[role])}${pull}`
    })
    ctx.ui.notify([`profile ${name}: ${showModel(active.roles.top)}`, ...notes].join("\n"), notes.length ? "warning" : "info")
  }

  pi.registerCommand("provider", {
    description: "Switch every model to a provider profile: /provider <name>; /provider alone shows the active one",
    getArgumentCompletions: (prefix) =>
      loadProfiles().order.filter((n) => n.startsWith(prefix)).map((n) => ({ value: n, label: n })),
    handler: async (args, ctx) => {
      const name = args.trim()
      return name ? use(name, ctx) : show(ctx)
    },
  })

  // A run that ended on a quota error offers the next profile in order; nothing switches without a yes.
  pi.on("agent_end", async (event, ctx) => {
    if (!ctx.hasUI) return
    const last = event.messages.at(-1) as { role?: string; stopReason?: string; errorMessage?: string } | undefined
    if (last?.role !== "assistant" || last.stopReason !== "error" || !isQuotaError(last.errorMessage)) return
    const profiles = loadProfiles()
    const next = nextProfile(profiles, loadActive(getAgentDir(), profiles).profile)
    if (!next) return ctx.ui.notify(`${last.errorMessage}\nNo profile left to switch to.`, "error")
    if (await ctx.ui.confirm("Quota", `${last.errorMessage}\nSwitch to the ${next} profile?`)) await use(next, ctx)
  })
}
