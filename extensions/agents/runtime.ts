import { randomUUID } from "node:crypto"
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import type { Message } from "@earendil-works/pi-ai"
import {
  type AgentSession, type ExtensionAPI, type ExtensionContext, type ToolDefinition,
  DefaultResourceLoader, defineTool, SessionManager, SettingsManager, buildSessionContext, convertToLlm, createAgentSession, createBashToolDefinition, getAgentDir,
} from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { USAGE_EVENT } from "../budget/limits.ts"
import { loadActive, loadProfiles, showModel, splitModel } from "../lib/profiles.ts"
import { guardrails } from "../guardrails/index.ts"
import { runtimeFor } from "../lib/session.ts"
import { WORKTREES_DIR, git, kill, treeOf } from "../tasks/git.ts"
import { type Def, defDirs, loadDefs } from "./defs.ts"
import { type Agent, GRACE_TURNS, MAX_DEPTH, WRAP_UP, find, live, newHandle, report, startable, subtree } from "./fleet.ts"
import { END, META, descendants, end, inherited, meta, restore } from "./saved.ts"

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

const lastText = (messages: AgentSession["messages"]) => {
  for (const m of [...messages].reverse()) {
    if (m.role !== "assistant") continue
    const t = m.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n").trim()
    if (t) return t
  }
  return ""
}

// The `parentSession` of a session file's header, read from its first line only.
function parentOf(file: string): string | undefined {
  const fd = openSync(file, "r")
  try {
    const buf = Buffer.alloc(4096)
    const line = buf.subarray(0, readSync(fd, buf)).toString("utf8").split("\n")[0]
    return JSON.parse(line).parentSession
  } catch {
    return undefined
  } finally {
    closeSync(fd)
  }
}

const dirty = async (dir: string) => (await git(dir, "status", "--porcelain")).trim() !== ""

type Start = {
  type?: string
  prompt: string
  description: string
  name?: string
  model?: string
  thinking?: string
  max_turns?: number
  background?: boolean
  resume?: string
  inherit_context?: boolean
  isolation?: "off" | "worktree"
}

export class Spawner {
  agents: Agent[] = []
  sessions = new Map<string, AgentSession>()
  private defs = new Map<string, Def>()
  private prompts = new Map<string, Start>()
  private transcripts = new Map<string, AgentSession["messages"]>() // of ended agents
  private waiters = new Map<string, (() => void)[]>()
  private pending = new Map<string, Agent[]>() // children's results a parent agent gets as its next prompt
  private claimed = new Set<string>() // agents an agent_result call waits on: their result goes there only
  private ctx?: ExtensionContext
  private closed = false
  onRunning = () => {} // the set of running agents changed

  constructor(private pi: ExtensionAPI) {}

  bind(ctx: ExtensionContext) {
    this.ctx = ctx
    this.restore(ctx)
    return this.reload()
  }

  // The agents an earlier Pi ran under this session, ended, so they can be read and resumed.
  private restore(ctx: ExtensionContext) {
    const root = ctx.sessionManager.getSessionFile()
    if (!root) return
    const dir = dirname(root)
    const headers = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => {
      const parent = parentOf(join(dir, f))
      return { file: resolve(dir, f), parent: parent && resolve(parent) }
    })
    for (const file of descendants(headers, resolve(root))) {
      const sm = SessionManager.open(file)
      const messages = buildSessionContext(sm.getEntries(), sm.getLeafId()).messages
      const a = restore(sm.getEntries(), file, lastText(messages))
      if (!a || find(this.agents, a.id)) continue
      this.agents.push(a)
      this.transcripts.set(a.id, messages)
    }
  }

  reload() {
    const { defs, errors } = loadDefs(defDirs(this.ctx?.cwd ?? process.cwd(), getAgentDir()))
    this.defs = defs
    return { defs, errors }
  }

  types = () => [...this.defs.values()]

  // Starts the agent, or queues it; the returned agent changes as it runs.
  async start(p: Start, parent: { id: string; depth: number }): Promise<Agent | string> {
    if (p.resume) return this.resume(p)
    if (!p.type) return "Give the agent's type, or resume with an agent id."
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

  // Reopens an ended agent's session with a new prompt; its turns, tokens and handle carry on.
  private async resume(p: Start): Promise<Agent | string> {
    const a = find(this.agents, p.resume as string)
    if (!a) return `No agent ${p.resume}.`
    if (live(a)) return `Agent ${a.handle} is ${a.status}; steer it with agent_steer instead.`
    if (!a.sessionFile || !existsSync(a.sessionFile)) return `Agent ${a.handle} has no saved session to resume.`
    if (!this.defs.has(a.type)) return `Agent type ${a.type} no longer exists.`
    if (a.worktree) {
      if (!existsSync(a.worktree)) return `Agent ${a.handle}'s worktree ${a.worktree} is gone.`
      if (await dirty(a.worktree)) return `Agent ${a.handle}'s worktree ${a.worktree} has uncommitted changes; commit or discard them first.`
    }
    Object.assign(a, { status: "queued", result: undefined, error: undefined, endedAt: undefined })
    a.background = (p.background ?? true) && this.ctx?.mode !== "print"
    this.prompts.set(a.id, { ...p, type: a.type })
    this.transcripts.delete(a.id)
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
    this.onRunning()
  }

  private async run(a: Agent) {
    const p = this.prompts.get(a.id) as Start
    const def = this.defs.get(a.type) as Def
    const ctx = this.ctx as ExtensionContext
    try {
      const ref = p.model ? splitModel(p.model) : loadActive(getAgentDir()).roles[def.role]
      const model = ctx.modelRegistry.find(ref.provider, ref.id)
      if (!model) throw new Error(`model ${showModel(ref)} is unknown`)
      if (!p.resume) await this.place(a, p.isolation ?? def.isolation, ctx)
      const session = await this.open(a, def, model, ctx)
      this.sessions.set(a.id, session)
      a.sessionFile = session.sessionFile
      if (a.status !== "running") throw new Error("stopped") // while it opened; finish disposes it
      this.follow(a, session, a.turns + (p.max_turns ?? def.maxTurns))
      await session.prompt(p.prompt)
      // An agent does not end before its children: their results become its next prompt.
      for (;;) {
        if (a.status !== "running") break
        const results = this.pending.get(a.id) ?? []
        this.pending.delete(a.id)
        if (results.length) await session.prompt(results.map(report).join("\n\n"))
        else {
          const kids = this.agents.filter((x) => x.parent === a.id && x.background && live(x))
          if (!kids.length) break
          await Promise.race(kids.map((k) => this.wait(k)))
        }
      }
      const last = session.messages.at(-1) as { stopReason?: string; errorMessage?: string } | undefined
      a.result = lastText(session.messages)
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
    if (a.worktree) await this.commit(a)
    this.finish(a)
  }

  // Where the agent works: its parent's directory, or a new worktree of it on its own branch.
  private async place(a: Agent, isolation: "off" | "worktree", ctx: ExtensionContext) {
    const base = a.parent === "main" ? ctx.cwd : (find(this.agents, a.parent)?.cwd ?? ctx.cwd)
    a.cwd = base
    if (isolation !== "worktree") return
    const dir = join(ctx.cwd, WORKTREES_DIR, `agent-${a.id}`)
    await git(base, "worktree", "add", dir, "-B", `agent-${a.id}`)
    Object.assign(a, { cwd: dir, worktree: dir, branch: `agent-${a.id}` })
  }

  private async commit(a: Agent) {
    const dir = a.worktree as string
    try {
      if (!(await dirty(dir))) return
      await git(dir, "add", "-A")
      await git(dir, "commit", "-q", "-m", `${a.handle}: ${a.description}`)
    } catch (e) {
      a.error = `${a.error ? `${a.error}; ` : ""}commit failed: ${e instanceof Error ? e.message : e}`
    }
  }

  private async open(a: Agent, def: Def, model: NonNullable<ExtensionContext["model"]>, ctx: ExtensionContext) {
    const p = this.prompts.get(a.id) as Start
    const cwd = a.cwd ?? ctx.cwd
    const settingsManager = SettingsManager.create(cwd, getAgentDir())
    const extensions = [...new Set((def.tools ?? []).flatMap((t) => (TOOL_EXTENSIONS[t] ? [extensionPath(TOOL_EXTENSIONS[t])] : [])))]
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: getAgentDir(),
      settingsManager,
      additionalExtensionPaths: extensions,
      // Its own guardrails, with the type's commands: agents share this process's environment.
      extensionFactories: [guardrails({ bash: def.bash })],
      // Other packages' extensions stay: claude-bridge must see the agent's prompt to serve it.
      // Of ours, only the tools the type names; no UI, commands or nested hooks.
      extensionsOverride: (base) => ({ ...base, extensions: base.extensions.filter((e) => !ours(e.resolvedPath) || extensions.includes(e.resolvedPath)) }),
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      appendSystemPrompt: [def.prompt],
    })
    await resourceLoader.reload()
    // Saved next to the parent's session, linked to it, so it can be read and resumed later.
    const parentFile = a.parent === "main" ? ctx.sessionManager.getSessionFile() : this.sessions.get(a.parent)?.sessionFile
    const sessionManager = p.resume
      ? SessionManager.open(a.sessionFile as string, undefined, cwd)
      : parentFile
        ? SessionManager.create(cwd, dirname(parentFile), { parentSession: parentFile })
        : SessionManager.inMemory(cwd)
    if (!p.resume) {
      sessionManager.appendCustomEntry(META, meta(a))
      if (p.inherit_context) {
        const from = a.parent === "main"
          ? buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages
          : (this.sessions.get(a.parent)?.messages ?? [])
        for (const m of inherited(convertToLlm(from) as Message[])) sessionManager.appendMessage(m)
      }
    }
    const nested = def.allowedAgents.length && a.depth < MAX_DEPTH ? this.tools({ id: a.id, depth: a.depth }) : []
    const { session } = await createAgentSession({
      cwd,
      model,
      ...(p.thinking ? { thinkingLevel: p.thinking as never } : {}),
      modelRuntime: await runtimeFor(ctx, model),
      resourceLoader,
      settingsManager,
      sessionManager,
      // An allowlist disables every tool it does not name, the agent tools included.
      ...(def.tools ? { tools: [...def.tools, ...nested.map((t) => t.name)] } : {}),
      customTools: [...nested, this.bash(a, cwd, settingsManager)],
    })
    await session.bindExtensions({})
    return session
  }

  private tree = (a: Agent) => treeOf(this.ctx?.cwd ?? "", `agent-${a.id}`)

  // Pi's bash, marking what the agent runs so that stopping it kills those processes too.
  private bash(a: Agent, cwd: string, settings: SettingsManager) {
    const tree = this.tree(a)
    return createBashToolDefinition(cwd, {
      commandPrefix: settings.getShellCommandPrefix(),
      shellPath: settings.getShellPath(),
      spawnHook: (c) => ({ ...c, env: { ...c.env, OTHALA_TASK_TREE: tree } }),
    }) as unknown as ToolDefinition<any, any>
  }

  // `limit` counts every turn the agent ever had, so a resumed agent gets its max_turns anew.
  private follow(a: Agent, s: AgentSession, limit: number) {
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
        if (a.turns === limit) void s.steer(WRAP_UP)
        if (a.turns >= limit + GRACE_TURNS && a.status === "running") {
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
    const s = this.sessions.get(a.id)
    if (s) {
      this.transcripts.set(a.id, s.messages)
      s.sessionManager.appendCustomEntry(END, end(a))
    }
    s?.dispose()
    this.sessions.delete(a.id)
    for (const w of this.waiters.get(a.id) ?? []) w()
    this.waiters.delete(a.id)
    if (a.background && !this.claimed.delete(a.id)) this.deliver(a)
    this.pump()
  }

  // A background agent's result goes to its parent's next turn: main gets a message that starts
  // one; an agent parent gets it as its next prompt, unless agent_result read it first.
  private deliver(a: Agent) {
    if (this.closed) return
    // A parent that ended (a nested agent resumed by the user) leaves main to hear of it.
    if (a.parent === "main" || find(this.agents, a.parent)?.status !== "running") {
      this.pi.sendMessage({ customType: "agent-result", content: report(a), display: true, details: { id: a.id } }, { triggerTurn: true, deliverAs: "followUp" })
      return
    }
    this.pending.set(a.parent, [...(this.pending.get(a.parent) ?? []), a])
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
      const s = this.sessions.get(a.id)
      if (s) void s.abort()
      else if (wasQueued) this.finish(a)
      const tree = this.tree(a)
      kill((t) => t === tree)
    }
  }

  // The session is going: its agents stop, and nothing starts or reports after.
  shutdown() {
    this.closed = true
    for (const a of this.agents.filter((x) => x.parent === "main")) this.stop(a.id)
  }

  messages = (id: string) => this.sessions.get(id)?.messages ?? this.transcripts.get(id) ?? []

  // A foreground agent's caller stops waiting; the result comes as a background one's does.
  background(a: Agent) {
    if (a.status !== "running" || a.background) return false
    a.background = true
    for (const w of this.waiters.get(a.id) ?? []) w()
    this.waiters.delete(a.id)
    return true
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
        promptGuidelines: [
          `Agent types for the \`agent\` tool:\n${types()}`,
          "Give an agent a self-contained prompt: it does not see this conversation, unless inherit_context is set.",
          "To follow up on an agent that ended, resume it rather than starting a new one: it keeps what it learned.",
        ],
        parameters: Type.Object({
          type: Type.Optional(Type.String({ description: "The agent type; not needed with resume" })),
          prompt: Type.String({ description: "The task, self-contained" }),
          description: Type.String({ description: "3 to 5 words for the fleet view" }),
          name: Type.Optional(Type.String({ description: "A handle to refer to it by, unique" })),
          model: Type.Optional(Type.String({ description: "provider/model instead of the type's role" })),
          thinking: Type.Optional(Type.String({ description: "Thinking level: off, minimal, low, medium, high" })),
          max_turns: Type.Optional(Type.Integer({ minimum: 1 })),
          background: Type.Optional(Type.Boolean({ default: true })),
          resume: Type.Optional(Type.String({ description: "Id or handle of an ended agent to continue with this prompt, in its own context" })),
          inherit_context: Type.Optional(Type.Boolean({ description: "Start from a copy of this conversation instead of an empty one" })),
          isolation: Type.Optional(Type.Union([Type.Literal("off"), Type.Literal("worktree")], { description: "worktree: work in a new git worktree, committed to its own branch at the end" })),
        }),
        execute: async (_id, params, signal, onUpdate) => {
          const a = await this.start(params, parent)
          if (typeof a === "string") return text(a)
          if (a.background) return text(`Started ${a.handle} (id ${a.id})${a.status === "queued" ? ", queued" : ""}. Its result arrives at your next turn.`)
          const tick = setInterval(() => onUpdate?.(text(report(a))), 1000)
          const stop = () => this.stop(a.id)
          signal?.addEventListener("abort", stop, { once: true })
          await this.wait(a, signal)
          clearInterval(tick)
          signal?.removeEventListener("abort", stop)
          if (live(a)) return text(`Moved ${a.handle} (id ${a.id}) to the background. Its result arrives at your next turn.`)
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
          if (params.wait && live(a)) {
            this.claimed.add(a.id)
            await this.wait(a, signal)
            this.claimed.delete(a.id)
          }
          if (!live(a)) this.pending.set(a.parent, (this.pending.get(a.parent) ?? []).filter((x) => x !== a))
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
