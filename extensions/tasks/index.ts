import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Type } from "typebox"
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import rules from "../guardrails/rules.json"
import type { Rules } from "../guardrails/rules.ts"
import {
  PLANS_DIR, type Plan, commentsMessage, implementMessage, isSmall, parseComments, parsePlan,
  planPrompt, planVerdict, slug, uniqueSlug, withStatus,
} from "./plan.ts"
import { MAX_SCOUTS, SCOUT_TIMEOUT_MS, formatScouts, scoutArgs } from "./scout.ts"
import { type Model, parseTiers } from "./tiers.ts"

const R = rules as Rules

// Plan mode, kept in the session so a resume is still planning: the plan file
// (relative to the project) and the model to go back to.
type State = { path: string; before?: Model }
const ENTRY = "tasks-plan"

const loadTiers = () => parseTiers(readFileSync(join(getAgentDir(), "tasks.json"), "utf8"))

export default function (pi: ExtensionAPI) {
  let state: State | undefined

  const save = (s: State | undefined) => {
    state = s
    pi.appendEntry(ENTRY, s ?? null)
  }

  pi.on("session_start", (_e, ctx) => {
    const last = ctx.sessionManager.getEntries().filter((e: any) => e.type === "custom" && e.customType === ENTRY).pop() as any
    state = last?.data ?? undefined
    ctx.ui.setStatus("plan", state ? "plan mode" : undefined)
    if (state) pi.setActiveTools([...new Set([...pi.getActiveTools(), "scout"])])
  })

  // Prepended to each request instead of stored, as the memory extension does: the
  // bridge drops a systemPrompt from before_agent_start.
  pi.on("context", (event) => {
    if (!state) return undefined
    const note = { role: "user" as const, content: [{ type: "text" as const, text: planPrompt(state.path) }], timestamp: 0 }
    return { messages: [note, ...event.messages] }
  })

  pi.on("tool_call", (event, ctx) => {
    if (!state) return undefined
    const d = planVerdict(R, event.toolName, event.input, ctx.cwd)
    return d.verdict === "allow" ? undefined : { block: true, reason: d.reason }
  })

  async function enter(request: string, ctx: ExtensionCommandContext) {
    if (state) return pi.sendUserMessage(request)
    let tiers
    try {
      tiers = loadTiers()
    } catch (e) {
      return ctx.ui.notify(`/plan: ${e instanceof Error ? e.message : e}`, "error")
    }
    const model = ctx.modelRegistry.find(tiers.plan.provider, tiers.plan.id)
    if (!model) return ctx.ui.notify(`/plan: model ${tiers.plan.provider}/${tiers.plan.id} is not available (tasks.json)`, "error")
    const before = ctx.model && { provider: ctx.model.provider, id: ctx.model.id }
    if (!(await pi.setModel(model))) return ctx.ui.notify(`/plan: no credentials for ${tiers.plan.provider}`, "error")

    const dir = join(ctx.cwd, PLANS_DIR)
    mkdirSync(dir, { recursive: true })
    const name = uniqueSlug(slug(request), (s) => existsSync(join(dir, `${s}.md`)))
    save({ path: `${PLANS_DIR}/${name}.md`, before })
    ctx.ui.setStatus("plan", "plan mode")
    pi.setActiveTools([...new Set([...pi.getActiveTools(), "scout"])])
    pi.sendUserMessage(request)
  }

  async function leave(ctx: ExtensionCommandContext) {
    const before = state?.before
    save(undefined)
    ctx.ui.setStatus("plan", undefined)
    pi.setActiveTools(pi.getActiveTools().filter((n) => n !== "scout"))
    const model = before && ctx.modelRegistry.find(before.provider, before.id)
    if (model) await pi.setModel(model)
  }

  // Opens the plan in the user's editor. In the TUI the terminal is handed over, as Pi's own
  // ctrl+g does; elsewhere (rpc, print) the editor gets no terminal, which suits a script.
  async function edit(path: string, ctx: ExtensionCommandContext) {
    const [cmd, ...args] = (pi.getSettings().externalEditor || process.env.VISUAL || process.env.EDITOR || "vi").split(" ")
    const run = () =>
      new Promise<number | null>((done) => {
        const child = spawn(cmd, [...args, path], { stdio: ctx.mode === "tui" ? "inherit" : "ignore" })
        child.on("error", () => done(null))
        child.on("close", done)
      })
    let code: number | null = null
    if (ctx.mode === "tui") {
      await ctx.ui.custom<void>((tui, _theme, _kb, done) => {
        tui.stop()
        void run().then((c) => {
          code = c
          tui.start()
          tui.requestRender(true)
          done()
        })
        return { render: () => [], invalidate() {} }
      })
    } else code = await run()
    return code === 0
  }

  async function review(ctx: ExtensionCommandContext) {
    if (!state) return ctx.ui.notify("Not planning. Start with /plan <request>.", "warning")
    if (!ctx.isIdle()) return ctx.ui.notify("The model is still working; review when it stops.", "warning")
    const file = join(ctx.cwd, state.path)
    if (!existsSync(file)) return ctx.ui.notify(`${state.path} does not exist yet; the model has not written the plan.`, "warning")
    if (!(await edit(file, ctx))) return ctx.ui.notify("The editor failed; nothing was sent.", "error")
    const comments = parseComments(readFileSync(file, "utf8"))
    if (!comments.length) return ctx.ui.notify(`No comments in ${state.path}. Comment with a >> line under quoted lines, or /plan approve.`, "info")
    pi.sendUserMessage(commentsMessage(state.path, comments))
  }

  // SEAM for part 2: a plan with a task tree is approved, valid, and on disk. `/tasks run`
  // compiles it to .pi/plans/<slug>.json (steps 3 to 7 of the workflow) and starts here.
  function runTasks(path: string, _plan: Plan, ctx: ExtensionCommandContext) {
    ctx.ui.notify(`${path} is approved. Its tasks are executed by /tasks run, which is not available yet.`, "info")
  }

  async function approve(ctx: ExtensionCommandContext) {
    if (!state) return ctx.ui.notify("Not planning. Start with /plan <request>.", "warning")
    const file = join(ctx.cwd, state.path)
    if (!existsSync(file)) return ctx.ui.notify(`${state.path} does not exist yet; the model has not written the plan.`, "warning")
    const text = readFileSync(file, "utf8")
    const plan = parsePlan(text)
    if (plan.errors.length) return ctx.ui.notify(`The plan cannot be approved:\n- ${plan.errors.join("\n- ")}`, "error")
    const approved = withStatus(text, "approved")
    writeFileSync(file, approved)
    const path = state.path
    await leave(ctx)
    if (isSmall(plan)) pi.sendUserMessage(implementMessage(path, approved))
    else runTasks(path, plan, ctx)
  }

  pi.registerCommand("plan", {
    description: "Plan before building: /plan <request>, then /plan review and /plan approve (/plan cancel leaves)",
    handler: async (args, ctx) => {
      const a = args.trim()
      if (a === "review") return review(ctx)
      if (a === "approve") return approve(ctx)
      if (a === "cancel") return state ? leave(ctx) : ctx.ui.notify("Not planning.", "info")
      if (!a) return ctx.ui.notify(state ? `Planning in ${state.path}. /plan review, /plan approve, /plan cancel.` : "usage: /plan <request>", "info")
      await enter(a, ctx)
    },
  })

  pi.registerTool({
    name: "scout",
    label: "Scout",
    description:
      "Read-only research by cheaper models, one per question, run in parallel. Each scout reads files of this project " +
      "(read, grep, find, ls) and answers with findings. Give each question enough context to stand alone.",
    promptSnippet: "Research several questions in parallel with read-only scouts",
    defaultActive: false,
    parameters: Type.Object({
      questions: Type.Array(Type.String(), { minItems: 1, maxItems: MAX_SCOUTS, description: "One self-contained question per scout" }),
    }),
    async execute(_id, p, signal, _update, ctx) {
      const { small } = loadTiers()
      const results = await Promise.all(
        p.questions.map((q) =>
          pi.exec("pi", scoutArgs(small, q), { cwd: ctx.cwd, signal, timeout: SCOUT_TIMEOUT_MS, maxBuffer: 1 << 20 }),
        ),
      )
      return { content: [{ type: "text" as const, text: formatScouts(p.questions, results) }], details: {} }
    },
  })
}
