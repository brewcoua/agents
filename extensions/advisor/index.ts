import { cleanupSessionResources } from "@earendil-works/pi-ai"
import { type ExtensionAPI, type ExtensionContext, buildSessionContext, convertToLlm, getAgentDir } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { USAGE_EVENT } from "../budget/limits.ts"
import { loadActive, showModel } from "../lib/profiles.ts"
import { NAME, PROMPT, handoff, textOf } from "./advisor.ts"

const DESCRIPTION =
  "Escalate to a stronger reviewer model for guidance. When you need stronger judgment — a complex decision, an ambiguous failure, a problem you're circling without progress — escalate to the advisor model for guidance, then resume. Takes NO parameters — when you call advisor(), your entire conversation history is automatically forwarded. The advisor sees the task, every tool call you've made, every result you've seen."

const GUIDELINES = [
  "Call `advisor` BEFORE substantive work — before writing, before committing to an interpretation, before building on an assumption. Orientation (finding files, fetching a source, seeing what's there) is not substantive work; writing, editing, and declaring an answer are.",
  "Also call `advisor` when you believe the task is complete. BEFORE this call, make your deliverable durable: write the file, save the result, commit the change.",
  "Also call `advisor` when stuck — errors recurring, approach not converging, results that don't fit — or when considering a change of approach.",
  "Give the advisor's advice serious weight. If you follow a step and it fails empirically, or you have primary-source evidence that contradicts a specific claim, adapt. If your evidence points one way and the advisor another, surface the conflict in one more `advisor` call instead of switching silently.",
  "After each `advisor` result, put the advisor's key guidance into your next visible reply to the user before continuing. The user often cannot see collapsed tool results.",
]

// Stable per session, so consecutive calls share a prompt cache, and distinct from the session's
// own id, so the advisor never shares its cache key or a Codex websocket.
const sessionId = (ctx: ExtensionContext) => `advisor-${ctx.sessionManager.getSessionId()}`
const reply = (text: string, details: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text }], details })

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: NAME,
    label: "Advisor",
    description: DESCRIPTION,
    promptSnippet: "Escalate to a stronger reviewer model for guidance when stuck, before substantive work, or before declaring done",
    promptGuidelines: GUIDELINES,
    parameters: Type.Object({}),
    async execute(_id, _params, signal, onUpdate, ctx) {
      const top = loadActive(getAgentDir()).roles.top
      const label = showModel(top)
      const model = ctx.modelRegistry.find(top.provider, top.id)
      if (!model) return reply(`Advisor (${label}) is not a known model; /provider shows the roles.`)
      if (!ctx.modelRegistry.hasConfiguredAuth(model)) return reply(`Advisor (${label}) has no credentials.`)
      const { messages } = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId())
      onUpdate?.(reply(`Consulting ${label}…`))
      try {
        // complete() applies the provider's auth at request time, OAuth and Copilot's baseUrl
        // included; an API key or headers passed here would bypass that.
        const r = await ctx.modelRegistry.complete(model, { systemPrompt: PROMPT, messages: handoff(convertToLlm(messages)), tools: [] }, { signal, sessionId: sessionId(ctx) })
        pi.events.emit(USAGE_EVENT, { source: NAME, cost: r.usage.cost.total, tokens: r.usage.input + r.usage.output })
        const details = { model: label, usage: r.usage }
        if (r.stopReason === "aborted") return reply("Advisor call was cancelled before it completed.", details)
        if (r.stopReason === "error") return reply(`Advisor call failed: ${r.errorMessage ?? "unknown error"}`, details)
        return reply(textOf(r) || "Advisor returned no text content.", details)
      } catch (e) {
        return reply(`Advisor call threw: ${e instanceof Error ? e.message : e}`)
      }
    },
  })

  // Advice from the model already running the session adds nothing, so it is not offered then.
  const reconcile = (_e: unknown, ctx: ExtensionContext) => {
    const top = loadActive(getAgentDir()).roles.top
    const same = ctx.model?.provider === top.provider && ctx.model?.id === top.id
    const active = pi.getActiveTools()
    if (same && active.includes(NAME)) pi.setActiveTools(active.filter((t) => t !== NAME))
    else if (!same && !active.includes(NAME)) pi.setActiveTools([...active, NAME])
  }
  pi.on("session_start", reconcile)
  pi.on("model_select", reconcile)
  pi.on("before_agent_start", reconcile)

  // Pi releases provider resources only under the session's own id; a pooled Codex websocket
  // under the advisor's would keep `pi -p` alive.
  pi.on("session_shutdown", (_e, ctx) => cleanupSessionResources(sessionId(ctx)))
}
