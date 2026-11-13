import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import {
  type AgentSession, type ExtensionAPI, type ExtensionContext, type ToolDefinition,
  DefaultResourceLoader, defineTool, SessionManager, SettingsManager, createAgentSession, getAgentDir,
} from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { USAGE_EVENT } from "../budget/limits.ts"
import { loadActive, loadProfiles, showModel, splitModel } from "../lib/profiles.ts"
import { GUARDRAILS, runtimeFor } from "../lib/session.ts"
import { type Def, defDirs, loadDefs } from "./defs.ts"
import { type Agent, GRACE_TURNS, MAX_DEPTH, WRAP_UP, find, live, newHandle, report, startable, subtree } from "./fleet.ts"

// Tools that come from one of our extensions, which an agent session then loads.
const TOOL_EXTENSIONS: Record<string, string> = {
  web_search: "web",
  web_fetch: "web",
  web_render: "web",
}
const extensionPath = (name: string) => new URL(`../${name}/index.ts`, import.meta.url).pathname

// Whether an extension file is one of this package's, wherever the package is installed.
const PACKAGE = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).name
const ours = (path: string) => {
  try {
    return JSON.parse(readFileSync(join(dirname(path), "../../package.json"), "utf8")).name === PACKAGE
  } catch {
    return false
  }
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} })

const lastText = (s: AgentSession) => {
  for (const m of [...s.messages].reverse()) {
    if (m.role !== "assistant") continue
    const t = m.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n").trim()
    if (t) return t
  }
  return ""
}

type Start = {
  type: string
  prompt: string
  description: string
  name?: string
  model?: string
  thinking?: string
  max_turns?: number
  background?: boolean
}

export class Spawner {
  agents: Agent[] = []
  sessions = new Map<string, AgentSession>()
  private defs = new Map<string, Def>()
  private prompts = new Map<string, Start>()
  private waiters = new Map<string, (() => void)[]>()
  private ctx?: ExtensionContext
  private closed = false

  constructor(private pi: ExtensionAPI) {}

  bind(ctx: ExtensionContext) {
    this.ctx = ctx
    return this.reload()
  }

  reload() {
    const { defs, errors } = loadDefs(defDirs(this.ctx?.cwd ?? process.cwd(), getAgentDir()))
    this.defs = defs
    return { defs, errors }
  }

  types = () => [...this.defs.values()]

  // Starts the agent, or queues it; the returned agent changes as it runs.
  start(p: Start, parent: { id: string; depth: number }): Agent | string {
    const def = this.defs.get(p.type)
    if (!def) return `No agent type ${p.type}. Types: ${[...this.defs.keys()].join(", ") || "none"}.`
    if (parent.depth >= MAX_DEPTH) return `Agents nest ${MAX_DEPTH} deep at most.`
    if (parent.id !== "main") {
      const owner = this.defs.get(find(this.agents, parent.id)?.type ?? "")
      if (!owner?.allowedAgents.includes(p.type)) return `This agent may not start ${p.type} agents.`
    }
    const handle = newHandle(this.agents, p.type, p.name)
    if (typeof handle !== "string") return handle.error
    const a: Agent = {
      id: randomUUID().slice(0, 8), handle, type: p.type, description: p.description, parent: parent.id, depth: parent.depth + 1,
      // Print mode exits after its turn, so a background result would have no one to reach.
      background: (p.background ?? true) && this.ctx?.mode !== "print", status: "queued", turns: 0, tokens: 0, cost: 0,
    }
    this.agents.push(a)
    this.prompts.set(a.id, p)
    this.pump()
    return a
  }

  private pump() {
    if (this.closed) return
    for (const a of startable(this.agents, loadProfiles().maxConcurrent)) {
      a.status = "running"
      a.startedAt = Date.now()
      void this.run(a)
    }
  }

  private async run(a: Agent) {
    const p = this.prompts.get(a.id) as Start
    const def = this.defs.get(a.type) as Def
    const ctx = this.ctx as ExtensionContext
    try {
      const ref = p.model ? splitModel(p.model) : loadActive(getAgentDir()).roles[def.role]
      const model = ctx.modelRegistry.find(ref.provider, ref.id)
      if (!model) throw new Error(`model ${showModel(ref)} is unknown`)
      const session = await this.open(a, def, model, ctx)
      this.sessions.set(a.id, session)
      a.sessionFile = session.sessionFile
      if (a.status !== "running") throw new Error("stopped") // while it opened; finish disposes it
      this.follow(a, session, p.max_turns ?? def.maxTurns)
      await session.prompt(p.prompt)
      const last = session.messages.at(-1) as { stopReason?: string; errorMessage?: string } | undefined
      a.result = lastText(session)
      if (a.status === "running") {
        if (last?.stopReason === "error") {
          a.status = "failed"
          a.error = last.errorMessage
        } else a.status = "done"
      }
    } catch (e) {
      if (a.status === "running") a.status = "failed"
      a.error = e instanceof Error ? e.message : String(e)
    }
    this.finish(a)
  }

  private async open(a: Agent, def: Def, model: NonNullable<ExtensionContext["model"]>, ctx: ExtensionContext) {
    const settingsManager = SettingsManager.create(ctx.cwd, getAgentDir())
    const extensions = [GUARDRAILS, ...new Set((def.tools ?? []).flatMap((t) => (TOOL_EXTENSIONS[t] ? [extensionPath(TOOL_EXTENSIONS[t])] : [])))]
    const resourceLoader = new DefaultResourceLoader({
      cwd: ctx.cwd,
      agentDir: getAgentDir(),
      settingsManager,
      additionalExtensionPaths: extensions,
      // Other packages' extensions stay: claude-bridge must see the agent's prompt to serve it.
      // Of ours, only guardrails and the tools the type names; no UI, commands or nested hooks.
      extensionsOverride: (base) => ({ ...base, extensions: base.extensions.filter((e) => !ours(e.resolvedPath) || extensions.includes(e.resolvedPath)) }),
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      appendSystemPrompt: [def.prompt],
    })
    await resourceLoader.reload()
    // Saved next to the parent's session, linked to it, so it can be read and resumed later.
    const parentFile = a.parent === "main" ? ctx.sessionManager.getSessionFile() : this.sessions.get(a.parent)?.sessionFile
    const sessionManager = parentFile
      ? SessionManager.create(ctx.cwd, dirname(parentFile), { parentSession: parentFile })
      : SessionManager.inMemory(ctx.cwd)
    const nested = def.allowedAgents.length && a.depth < MAX_DEPTH ? this.tools({ id: a.id, depth: a.depth }) : []
    const thinking = this.prompts.get(a.id)?.thinking
    const { session } = await createAgentSession({
      cwd: ctx.cwd,
      model,
      ...(thinking ? { thinkingLevel: thinking as never } : {}),
      modelRuntime: await runtimeFor(ctx, model),
      resourceLoader,
      settingsManager,
      sessionManager,
      ...(def.tools ? { tools: def.tools } : {}),
      customTools: nested,
    })
    await session.bindExtensions({})
    return session
  }

  private follow(a: Agent, s: AgentSession, maxTurns: number) {
    s.subscribe((e) => {
      if (e.type === "tool_execution_start") a.tool = e.toolName
      else if (e.type === "tool_execution_end") a.tool = undefined
      else if (e.type === "message_end" && e.message.role === "assistant" && e.message.usage) {
        const u = e.message.usage
        a.tokens += u.input + u.output
        a.cost += u.cost.total
        a.context = s.getContextUsage()?.percent ?? undefined
        this.pi.events.emit(USAGE_EVENT, { source: `agent:${a.type}`, cost: u.cost.total, tokens: u.input + u.output })
      } else if (e.type === "turn_end") {
        a.turns++
        if (a.turns === maxTurns) void s.steer(WRAP_UP)
        if (a.turns >= maxTurns + GRACE_TURNS && a.status === "running") {
          a.status = "stopped"
          a.error = "turn limit"
          void s.abort()
        }
      }
    })
  }

  private finish(a: Agent) {
    a.endedAt = Date.now()
    a.tool = undefined
    this.sessions.get(a.id)?.dispose()
    this.sessions.delete(a.id)
    for (const w of this.waiters.get(a.id) ?? []) w()
    this.waiters.delete(a.id)
    if (a.background) this.deliver(a)
    this.pump()
  }

  // A background agent's result goes to its parent's next turn: main gets a message that starts
  // one; an agent parent gets it only while it still runs, else it reads it with agent_result.
  private deliver(a: Agent) {
    if (this.closed) return
    if (a.parent === "main") {
      this.pi.sendMessage({ customType: "agent-result", content: report(a), display: true, details: { id: a.id } }, { triggerTurn: true, deliverAs: "followUp" })
      return
    }
    const parent = this.sessions.get(a.parent)
    if (parent?.isStreaming) void parent.followUp(report(a))
  }

  wait(a: Agent, signal?: AbortSignal): Promise<void> {
    if (!live(a)) return Promise.resolve()
    return new Promise((resolve) => {
      this.waiters.set(a.id, [...(this.waiters.get(a.id) ?? []), resolve])
      signal?.addEventListener("abort", () => resolve(), { once: true })
    })
  }

  stop(id: string) {
    for (const a of subtree(this.agents, id).reverse()) {
      if (!live(a)) continue
      const wasQueued = a.status === "queued"
      a.status = "stopped"
      a.error ??= "stopped"
      const s = this.sessions.get(a.id)
      if (s) void s.abort()
      else if (wasQueued) this.finish(a)
    }
  }

  // The session is going: its agents stop, and nothing starts or reports after.
  shutdown() {
    this.closed = true
    for (const a of this.agents.filter((x) => x.parent === "main")) this.stop(a.id)
  }

  steer(a: Agent, message: string): string {
    const s = this.sessions.get(a.id)
    if (a.status !== "running" || !s) return `Agent ${a.handle} is ${a.status}; only a running agent can be steered.`
    void s.steer(message)
    return `Sent to ${a.handle}; it reads it after its current tool call.`
  }

  // The tools, for main (parent "main", depth 0) or for an agent that may start others.
  tools(parent: { id: string; depth: number }): ToolDefinition<any, any>[] {
    const types = () => this.types().map((d) => `- ${d.name} (${d.role}): ${d.description}`).join("\n")
    return [
      defineTool({
        name: "agent",
        label: "Agent",
        description:
          "Start a subagent: a separate session with its own context, tools and model, which works on the prompt and returns its final answer. Background by default: the id comes back at once and the result arrives as a message at your next turn; set background false to wait for it. The types are listed in the guidelines.",
        promptSnippet: "Start a subagent to research, locate code, review or implement in its own context",
        promptGuidelines: [`Agent types for the \`agent\` tool:\n${types()}`, "Give an agent a self-contained prompt: it does not see this conversation."],
        parameters: Type.Object({
          type: Type.String({ description: "The agent type" }),
          prompt: Type.String({ description: "The task, self-contained" }),
          description: Type.String({ description: "3 to 5 words for the fleet view" }),
          name: Type.Optional(Type.String({ description: "A handle to refer to it by, unique" })),
          model: Type.Optional(Type.String({ description: "provider/model instead of the type's role" })),
          thinking: Type.Optional(Type.String({ description: "Thinking level: off, minimal, low, medium, high" })),
          max_turns: Type.Optional(Type.Integer({ minimum: 1 })),
          background: Type.Optional(Type.Boolean({ default: true })),
        }),
        execute: async (_id, params, signal, onUpdate) => {
          const a = this.start(params, parent)
          if (typeof a === "string") return text(a)
          if (a.background) return text(`Started ${a.handle} (id ${a.id})${a.status === "queued" ? ", queued" : ""}. Its result arrives at your next turn.`)
          const tick = setInterval(() => onUpdate?.(text(report(a))), 1000)
          signal?.addEventListener("abort", () => this.stop(a.id), { once: true })
          await this.wait(a, signal)
          clearInterval(tick)
          return text(report(a))
        },
      }),
      defineTool({
        name: "agent_result",
        label: "Agent result",
        description: "An agent's state, or its result once it ended. With wait, blocks until it ends.",
        parameters: Type.Object({
          agent: Type.String({ description: "Id or handle" }),
          wait: Type.Optional(Type.Boolean({ default: false })),
        }),
        execute: async (_id, params, signal) => {
          const a = find(this.agents, params.agent)
          if (!a) return text(`No agent ${params.agent}.`)
          if (params.wait) await this.wait(a, signal)
          return text(report(a))
        },
      }),
      defineTool({
        name: "agent_steer",
        label: "Agent steer",
        description: "Send a message to a running agent; it reads it after its current tool call.",
        parameters: Type.Object({
          agent: Type.String({ description: "Id or handle" }),
          message: Type.String(),
        }),
        execute: async (_id, params) => {
          const a = find(this.agents, params.agent)
          return text(a ? this.steer(a, params.message) : `No agent ${params.agent}.`)
        },
      }),
    ]
  }
}
