import { fileURLToPath } from "node:url"
import {
  DefaultResourceLoader,
  DynamicBorder,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  getAgentDir,
  getMarkdownTheme,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { Container, Markdown, Text, matchesKey } from "@earendil-works/pi-tui"
import { USAGE_EVENT, type Usage } from "../budget/limits.ts"
import { READ_ONLY, SYSTEM, onlyReadOnly, parseArgs, transcript } from "./side.ts"

// Characters of the main conversation handed to the side session.
const CONTEXT_CHARS = 20000

// The guardrails are the only extension loaded in the side session, so its tools obey the
// same path rules. It has no UI, so what guardrails would ask about is refused.
const GUARDRAILS = fileURLToPath(new URL("../guardrails/index.ts", import.meta.url))

// An in-process session: no session file and no other extension, so the exchange never
// reaches the main history and /btw cannot recurse. Same model as the main one.
async function openSession(ctx: ExtensionContext, model: NonNullable<ExtensionContext["model"]>) {
  // A provider registered by an extension (claude-bridge) exists only in the main runtime.
  const config = ctx.modelRegistry.getRegisteredProviderConfig(model.provider)
  const native = ctx.modelRegistry.getRegisteredNativeProvider(model.provider)
  let modelRuntime: ModelRuntime | undefined
  if (config || native) {
    modelRuntime = await ModelRuntime.create({ allowModelNetwork: false })
    if (native) modelRuntime.registerNativeProvider(native)
    else if (config) modelRuntime.registerProvider(model.provider, config)
    await modelRuntime.refresh({ allowNetwork: false })
  }

  const settingsManager = SettingsManager.inMemory()
  const resourceLoader = new DefaultResourceLoader({
    cwd: ctx.cwd,
    agentDir: getAgentDir(),
    settingsManager,
    noExtensions: true,
    additionalExtensionPaths: [GUARDRAILS],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    appendSystemPrompt: [SYSTEM],
  })
  await resourceLoader.reload()

  const { session } = await createAgentSession({
    cwd: ctx.cwd,
    model,
    thinkingLevel: "low",
    modelRuntime,
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(ctx.cwd),
    tools: READ_ONLY,
  })
  await session.bindExtensions({})
  session.setActiveToolsByName(onlyReadOnly(session.getActiveToolNames()))
  return session
}

async function ask(question: string, ctx: ExtensionContext, report: (u: Usage) => void) {
  const model = ctx.model
  if (ctx.mode !== "tui") return ctx.ui.notify("/btw needs the interactive UI", "error")
  if (!model) return ctx.ui.notify("/btw: no model selected", "error")

  const context = transcript(ctx.sessionManager.getBranch(), CONTEXT_CHARS)
  const prompt = context
    ? `Conversation of the main session so far:\n\n${context}\n\n---\nSide question: ${question}`
    : question

  await ctx.ui.custom<void>((tui, theme, _kb, done) => {
    let body = ""
    let status = "thinking"
    let session: AgentSession | undefined
    let closed = false
    const used: Usage = { cost: 0, tokens: 0 }

    const close = () => {
      if (!closed) report(used)
      closed = true
      void session?.abort().finally(() => session?.dispose())
      done()
    }
    const update = () => tui.requestRender()

    void (async () => {
      try {
        session = await openSession(ctx, model)
        if (closed) return close()
        session.subscribe((e) => {
          if (e.type === "message_update" && e.assistantMessageEvent.type === "text_delta") {
            body += e.assistantMessageEvent.delta
            status = "answering"
          } else if (e.type === "message_end" && e.message.role === "assistant" && e.message.usage) {
            used.cost += e.message.usage.cost.total
            used.tokens += e.message.usage.input + e.message.usage.output
          } else if (e.type === "tool_execution_start") {
            status = `${e.toolName} ${JSON.stringify(e.args).slice(0, 60)}`
          }
          update()
        })
        await session.prompt(prompt)
        status = "done"
      } catch (error) {
        status = `error: ${error instanceof Error ? error.message : String(error)}`
      }
      update()
    })()

    return {
      render(width: number) {
        const border = new DynamicBorder((s: string) => theme.fg("accent", s))
        const box = new Container()
        box.addChild(border)
        box.addChild(new Text(theme.fg("accent", theme.bold("btw")) + theme.fg("dim", ` ${question}`), 1, 0))
        box.addChild(new Markdown(body || " ", 1, 1, getMarkdownTheme()))
        box.addChild(new Text(theme.fg("dim", `${status}  (esc closes)`), 1, 0))
        box.addChild(border)
        return box.render(width)
      },
      invalidate() {},
      handleInput(data: string) {
        if (matchesKey(data, "escape") || (status === "done" && matchesKey(data, "enter"))) close()
      },
    }
  }, { overlay: true, overlayOptions: { anchor: "center", width: "80%", maxHeight: "70%" } })
}

export default function (pi: ExtensionAPI) {
  const report = (u: Usage) => pi.events.emit(USAGE_EVENT, { source: "btw", ...u })
  pi.registerCommand("btw", {
    description: "Ask a quick question in a read-only side session; the main run is not interrupted",
    handler: async (args, ctx) => {
      const question = parseArgs(args)
      if (!question) return ctx.ui.notify("usage: /btw <question>", "warning")
      await ask(question, ctx, report)
    },
  })

  pi.registerShortcut("ctrl+alt+b", {
    description: "Ask a quick side question (/btw)",
    handler: async (ctx) => {
      const question = parseArgs((await ctx.ui.input("btw", "Quick question")) ?? "")
      if (question) await ask(question, ctx, report)
    },
  })
}
