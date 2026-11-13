import { readFileSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { showList } from "../lib/view.ts"
import rules from "./rules.json"
import { type Env, type Rules, cap, decide, toolVerdict } from "./rules.ts"

const R = rules as Rules

// The tasks extension sets this in a task's child pi: a ":"-separated list of globs, relative to
// the project directory. Edit and write outside them are refused, and nothing asks. OTHALA_TASK_VERIFY
// is the one bash command the task may run besides `git add` of its files and `git commit`.
const TASK_FILES = process.env.OTHALA_TASK_FILES?.split(":").filter(Boolean)

function readFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return undefined
  }
}

// A file that does not exist yet resolves through its nearest existing directory.
function realpath(path: string): string {
  let dir = path
  let rest = ""
  for (;;) {
    try {
      return realpathSync(dir) + rest
    } catch {
      const i = dir.lastIndexOf("/")
      if (i <= 0) return path
      rest = dir.slice(i) + rest
      dir = dir.slice(0, i)
    }
  }
}

// What this session asked about or refused, newest last, for /guardrails.
type Logged = { time: Date; what: string; reason: string; outcome: "denied" | "allowed by you" | "declined by you" | "refused, no UI" }
const LOG_MAX = 200

async function enforce(env: Env, note: (e: Logged) => void, toolName: string, input: Record<string, unknown>, ctx: ExtensionContext) {
  const d = decide(R, env, toolName, input, ctx.cwd)
  if (d.verdict === "allow") return undefined
  const what = toolName === "bash" ? String(input.command) : `${toolName} ${String(input.path ?? input.file_path ?? "")}`
  const time = new Date()
  if (d.verdict === "deny") {
    note({ time, what, reason: d.reason, outcome: "denied" })
    return { block: true, reason: `Blocked by guardrails: ${d.reason}.` }
  }
  if (!ctx.hasUI) {
    note({ time, what, reason: d.reason, outcome: "refused, no UI" })
    return { block: true, reason: `Blocked by guardrails: ${d.reason}, and there is no UI to ask the user. Run it yourself or change the approach.` }
  }
  const ok = await ctx.ui.confirm("Allow?", `${what}\n\n${d.reason}`)
  note({ time, what, reason: d.reason, outcome: ok ? "allowed by you" : "declined by you" })
  return ok ? undefined : { block: true, reason: "Blocked by guardrails: the user declined." }
}

// An agent session (extensions/agents) loads guardrails through this with its own settings, since
// in-process agents share this process's environment.
export const guardrails = (task: Pick<Env, "taskFiles" | "taskVerify" | "bash">) => (pi: ExtensionAPI) => {
  const env: Env = { home: homedir(), readFile, realpath, ...task }
  const log: Logged[] = []
  const note = (e: Logged) => log.push(e) > LOG_MAX && log.shift()

  // Denied tools are not declared to the model. Codemode can still call tools
  // outside the active set, so tool_call below is the enforcement.
  const hide = () => {
    const active = pi.getActiveTools()
    const visible = active.filter((n) => toolVerdict(R, n) !== "deny")
    if (visible.length !== active.length) pi.setActiveTools(visible)
  }
  pi.on("session_start", hide)
  pi.on("before_agent_start", hide)

  pi.on("tool_call", (event, ctx) => enforce(env, note, event.toolName, event.input, ctx))

  pi.registerCommand("guardrails", {
    description: "What guardrails asked about or refused in this Pi, newest first",
    handler: async (_args, ctx) => {
      const hhmm = (d: Date) => d.toTimeString().slice(0, 8)
      await showList(ctx, {
        title: "Guardrails",
        empty: "Nothing was asked about or refused yet.",
        rows: () =>
          [...log].reverse().map((e) => ({
            label: `${hhmm(e.time)} ${e.outcome.padEnd(15)} ${e.what.replace(/\s+/g, " ")}`,
            dim: e.outcome === "allowed by you",
            detail: () => `${e.outcome} at ${hhmm(e.time)}\n\nreason: ${e.reason}\n\n${e.what}`,
          })),
      })
    },
  })

  pi.on("tool_result", (event) => {
    let changed = false
    const content = event.content.map((part) => {
      if (part.type !== "text") return part
      const text = cap(part.text, R.maxOutputChars)
      if (text === undefined) return part
      changed = true
      return { ...part, text }
    })
    return changed ? { content } : undefined
  })
}

export default guardrails({ taskFiles: TASK_FILES, taskVerify: process.env.OTHALA_TASK_VERIFY })
