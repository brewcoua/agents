import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { Type } from "typebox"
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import rules from "../guardrails/rules.json"
import type { Rules } from "../guardrails/rules.ts"
import { edit } from "../lib/editor.ts"
import { showList } from "../lib/view.ts"
import { live } from "../agents/fleet.ts"
import type { Spawner } from "../agents/runtime.ts"
import { WORKTREES_DIR, gitIO, killRun } from "./git.ts"
import {
  PLANS_DIR, commentsMessage, implementMessage, isSmall, parseComments, parsePlan,
  planPrompt, planStatus, planVerdict, slug, uniqueSlug, withStatus,
} from "./plan.ts"
import { type RunPlan, type RunTask, compile, start, summary } from "./run.ts"
import { runPlan } from "./runner.ts"
import { MAX_SCOUTS, SCOUT, SCOUT_TIMEOUT_MS, formatScouts } from "./scout.ts"
import { type Model, loadActive, loadProfiles } from "../lib/profiles.ts"

const R = rules as Rules

// Plan mode, kept in the session so a resume is still planning: the plan file
// (relative to the project) and the model to go back to.
type State = { path: string; before?: Model }
const ENTRY = "tasks-plan"

// The active profile's roles (/provider), and how many tasks run at once.
function loadTiers() {
  const p = loadProfiles()
  return { roles: loadActive(getAgentDir(), p).roles, maxConcurrent: p.maxConcurrent }
}

// One run per project: worktrees and branches are named by task id alone. The lock holds the pid
// and a token per extension instance: after /new or /reload the old instance's run may still be
// landing in this same process.
const lockFile = (cwd: string) => join(cwd, WORKTREES_DIR, "run.lock")
function holder(cwd: string, token: string): string | undefined {
  try {
    const lock = readFileSync(lockFile(cwd), "utf8")
    if (lock === token) return undefined
    // a pid reused by something else is no holder
    if (!readFileSync(`/proc/${Number(lock.split(" ")[0])}/cmdline`, "latin1").includes("pi")) return undefined
    return lock.split(" ")[0]
  } catch {
    return undefined
  }
}
const unlock = (cwd: string, token: string) => {
  try {
    if (readFileSync(lockFile(cwd), "utf8") === token) rmSync(lockFile(cwd))
  } catch {}
}

export default function (pi: ExtensionAPI) {
  // The agents extension's spawner, if it is loaded: scouts and task children are its agents.
  const agents = () => {
    let s: Spawner | undefined
    pi.events.emit("agents:spawner", (x: Spawner) => (s = x))
    return s
  }
  const token = `${process.pid} ${Math.random().toString(36).slice(2)}`
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
    // A Pi killed during a run leaves the processes its children started; nobody else will stop them.
    if (existsSync(join(ctx.cwd, WORKTREES_DIR)) && !holder(ctx.cwd, token)) {
      const n = killRun(ctx.cwd)
      if (n) ctx.ui.notify(`/tasks: stopped ${n} processes left by an interrupted run. /tasks run resumes it.`, "warning")
    }
  })

  pi.on("session_shutdown", (_e, ctx) => {
    if (!controller) return
    controller.abort()
    killRun(ctx.cwd)
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
    const top = tiers.roles.top
    const model = ctx.modelRegistry.find(top.provider, top.id)
    if (!model) return ctx.ui.notify(`/plan: model ${top.provider}/${top.id} is not available (/provider)`, "error")
    const before = ctx.model && { provider: ctx.model.provider, id: ctx.model.id }
    if (!(await pi.setModel(model))) return ctx.ui.notify(`/plan: no credentials for ${top.provider}`, "error")

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

  async function review(ctx: ExtensionCommandContext) {
    if (!state) return ctx.ui.notify("Not planning. Start with /plan <request>.", "warning")
    if (!ctx.isIdle()) return ctx.ui.notify("The model is still working; review when it stops.", "warning")
    const file = join(ctx.cwd, state.path)
    if (!existsSync(file)) return ctx.ui.notify(`${state.path} does not exist yet; the model has not written the plan.`, "warning")
    if (!(await edit(pi, file, ctx))) return ctx.ui.notify("The editor failed; nothing was sent.", "error")
    const comments = parseComments(readFileSync(file, "utf8"))
    if (!comments.length) return ctx.ui.notify(`No comments in ${state.path}. Comment with a >> line under quoted lines, or /plan approve.`, "info")
    pi.sendUserMessage(commentsMessage(state.path, comments))
  }

  // Plans on disk: <slug>.md is the plan, <slug>.json the task tree that /tasks run keeps up to date.
  const jsonPath = (ctx: ExtensionCommandContext, name: string) => join(ctx.cwd, PLANS_DIR, `${name}.json`)
  const loadRun = (ctx: ExtensionCommandContext, name: string) => {
    try {
      return JSON.parse(readFileSync(jsonPath(ctx, name), "utf8")) as RunPlan
    } catch {
      return undefined
    }
  }
  // Task files compiled before plans had acceptance and modes.
  const oldFormat = (run: RunPlan) => run.acceptance ? undefined : `${PLANS_DIR}/${run.slug}.json comes from the plan format with tier and accept. Rewrite the plan with role, mode and spec, delete the .json, and run it again.`
  const saveRun = (ctx: ExtensionCommandContext) => (run: RunPlan) => writeFileSync(jsonPath(ctx, run.slug), `${JSON.stringify(run, null, 2)}\n`)

  // Plans not finished: an approved plan, or a task tree that has not reached done.
  function open(ctx: ExtensionCommandContext): string[] {
    const dir = join(ctx.cwd, PLANS_DIR)
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => basename(f, ".md"))
      .filter((n) => {
        const run = loadRun(ctx, n)
        return run ? run.status !== "done" : planStatus(readFileSync(join(dir, `${n}.md`), "utf8")) === "approved"
      })
  }

  function pick(arg: string, ctx: ExtensionCommandContext): string | undefined {
    if (arg) return arg
    const names = open(ctx)
    if (names.length === 1) return names[0]
    ctx.ui.notify(names.length ? `Several plans are open; name one: ${names.join(", ")}` : "No approved plan is waiting.", "warning")
  }

  let controller: AbortController | undefined
  let current: string | undefined // the slug of the plan this instance is running

  // COMPILE (first time), then EXECUTE to FINISH; a task tree on disk is resumed. The run goes on
  // in the background, so the session stays usable and /tasks stop can reach it.
  async function execute(name: string, ctx: ExtensionCommandContext) {
    if (controller) return ctx.ui.notify("Tasks are already running. /tasks stop stops them.", "warning")
    const other = holder(ctx.cwd, token)
    if (other) return ctx.ui.notify(`Tasks are running in another Pi in this project (pid ${other}).`, "warning")
    const save = saveRun(ctx)
    let run = loadRun(ctx, name)
    if (!run) {
      const file = join(ctx.cwd, PLANS_DIR, `${name}.md`)
      if (!existsSync(file)) return ctx.ui.notify(`No plan ${name} in ${PLANS_DIR}/.`, "error")
      const text = readFileSync(file, "utf8")
      if (planStatus(text) !== "approved") return ctx.ui.notify(`${name} is not approved. Run /plan approve first.`, "warning")
      const plan = parsePlan(text)
      const c = plan.errors.length ? { errors: plan.errors, run: undefined } : compile(plan, text, name)
      if (!c.run) return ctx.ui.notify(`${name} cannot run:\n- ${c.errors.join("\n- ")}`, "error")
      run = c.run
    }
    const old = oldFormat(run)
    if (old) return ctx.ui.notify(old, "error")
    if (run.status === "done") return ctx.ui.notify(`${name} is already done.`, "info")
    const spawner = agents()
    if (!spawner) return ctx.ui.notify("/tasks runs each task as an agent, and the agents extension is not loaded.", "error")
    let tiers
    try {
      tiers = loadTiers()
    } catch (e) {
      return ctx.ui.notify(`/tasks: ${e instanceof Error ? e.message : e}`, "error")
    }
    // Interrupted tasks start over: whatever they left running is killed, prepare() resets their worktrees.
    start(run)
    killRun(ctx.cwd)
    const io = gitIO(ctx.cwd, spawner, save, (m) => {
      ctx.ui.setStatus("tasks", m)
      if (!ctx.hasUI) ctx.ui.notify(m, "info")
    })
    save(run)
    mkdirSync(join(ctx.cwd, WORKTREES_DIR), { recursive: true })
    try {
      writeFileSync(lockFile(ctx.cwd), token, { flag: "wx" })
    } catch {
      if (holder(ctx.cwd, token)) return ctx.ui.notify("Another Pi took this project's tasks just now.", "warning")
      writeFileSync(lockFile(ctx.cwd), token) // stale
    }
    const c = (controller = new AbortController())
    current = name
    ctx.ui.notify(`${name}: running. /tasks status shows the tasks, /tasks stop stops them.`, "info")
    void (async () => {
      try {
        const r = await runPlan(run, tiers.maxConcurrent, io, c.signal)
        if (r.ok) {
          const file = join(ctx.cwd, PLANS_DIR, `${name}.md`)
          writeFileSync(file, withStatus(readFileSync(file, "utf8"), "done"))
        }
        ctx.ui.notify(r.message, r.ok ? "info" : "error")
      } catch (e) {
        save(run)
        ctx.ui.notify(`/tasks: ${e instanceof Error ? e.message : e}\nThe task file ${PLANS_DIR}/${name}.json holds the state; /tasks run resumes.`, "error")
      } finally {
        if (controller === c) (controller = undefined), (current = undefined)
        unlock(ctx.cwd, token)
        ctx.ui.setStatus("tasks", undefined)
      }
    })()
  }

  function stop(ctx: ExtensionCommandContext) {
    if (!controller) return ctx.ui.notify("No tasks are running.", "info")
    controller.abort()
    const spawner = agents()
    for (const a of spawner?.agents ?? []) if (a.owner === "tasks" && live(a)) spawner?.stop(a.id)
    const n = killRun(ctx.cwd)
    ctx.ui.notify(`Stopping: ${n} processes killed. Tasks that already passed their checks still land; /tasks run resumes the rest.`, "info")
  }

  async function approve(ctx: ExtensionCommandContext) {
    if (!state) return ctx.ui.notify("Not planning. Start with /plan <request>.", "warning")
    const file = join(ctx.cwd, state.path)
    if (!existsSync(file)) return ctx.ui.notify(`${state.path} does not exist yet; the model has not written the plan.`, "warning")
    const text = readFileSync(file, "utf8")
    const plan = parsePlan(text)
    if (plan.errors.length) return ctx.ui.notify(`The plan cannot be approved:\n- ${plan.errors.join("\n- ")}`, "error")
    const name = basename(state.path, ".md")
    if (!isSmall(plan)) {
      const c = compile(plan, text, name)
      if (!c.run) return ctx.ui.notify(`The plan cannot be approved:\n- ${c.errors.join("\n- ")}`, "error")
    }
    const approved = withStatus(text, "approved")
    writeFileSync(file, approved)
    const path = state.path
    await leave(ctx)
    if (isSmall(plan)) pi.sendUserMessage(implementMessage(path, approved))
    else await execute(name, ctx)
  }

  // The live view of a plan's tasks, read from its task file once a second.
  async function view(name: string, ctx: ExtensionCommandContext) {
    const first = loadRun(ctx, name)
    if (!first) return ctx.ui.notify(`${name} has not been compiled yet. /tasks run ${name} does it.`, "info")
    const old = oldFormat(first)
    if (old) return ctx.ui.notify(old, "error")
    let tasks: RunTask[] = []
    await showList(ctx, {
      title: `Tasks: ${name}`,
      empty: "The plan has no tasks.",
      refreshMs: 1000,
      rows: () => {
        const run = loadRun(ctx, name)
        tasks = run?.tasks ?? tasks
        return tasks.map((t) => ({
          label: `${t.status.padEnd(8)} ${t.id.padEnd(5)} ${t.title}${t.attempts ? `  (${t.attempts} failed)` : ""}`,
          dim: t.status === "done" || t.status === "pending",
          detail: () =>
            [
              `${t.id} ${t.title}: ${t.status}`,
              `role ${t.role}, mode ${t.mode}, deps ${t.deps.join(", ") || "none"}`,
              `files ${t.files.join(", ")}`,
              ...(t.tests.length ? [`tests ${t.tests.join(", ")}`] : []),
              `verify ${t.verify}`,
              `spec ${t.spec}`,
              ...(t.covers.length ? [`covers ${t.covers.join(", ")}`] : []),
              ...(t.granted?.length ? ["", "granted:", ...t.granted.map((g) => `- ${g.files.join(", ")}: ${g.reason}`)] : []),
              ...(t.notes ? ["", "notes:", t.notes] : []),
            ].join("\n"),
        }))
      },
      actions: current === name ? [{ key: "s", label: "stop the run", confirm: true, run: () => stop(ctx) }] : [],
    })
  }

  pi.registerCommand("tasks", {
    description: "Run an approved plan's tasks in worktrees: /tasks [slug] (the view), /tasks run [slug] (also resumes), /tasks status [slug], /tasks stop",
    handler: async (args, ctx) => {
      const [sub, arg = ""] = args.trim().split(/\s+/)
      if (sub === "stop") return stop(ctx)
      if (sub !== "run" && sub !== "status") {
        // `/tasks`, `/tasks view [slug]` and `/tasks <slug>` open the view
        const name = (sub === "view" ? arg : sub) || current || pick("", ctx)
        return name ? view(name, ctx) : undefined
      }
      const name = pick(arg, ctx)
      if (!name) return
      if (sub === "run") return execute(name, ctx)
      const run = loadRun(ctx, name)
      ctx.ui.notify(run ? summary(run) : `${name} has not been compiled yet. /tasks run ${name} does it.`, "info")
    },
  })

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
    async execute(_id, p, signal) {
      const spawner = agents()
      if (!spawner) return { content: [{ type: "text" as const, text: "Scouts are agents, and the agents extension is not loaded." }], details: {} }
      const scouts = p.questions.map((q) =>
        spawner.spawn({ owner: "plan", def: SCOUT, prompt: q, description: q.split(/\s+/).slice(0, 5).join(" "), timeoutMs: SCOUT_TIMEOUT_MS }),
      )
      const stop = () => scouts.forEach((a) => spawner.stop(a.id))
      signal?.addEventListener("abort", stop, { once: true })
      await Promise.all(scouts.map((a) => spawner.wait(a)))
      signal?.removeEventListener("abort", stop)
      return { content: [{ type: "text" as const, text: formatScouts(p.questions, scouts) }], details: {} }
    },
  })
}
